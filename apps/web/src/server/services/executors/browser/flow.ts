import { classifyQuestion, type ProviderEnv, type SubmissionPayload, type SubmissionResult } from "@applywise/job-engine";
import type { ApplicationQuestion, CanonicalQuestionKey, ManualActionReason } from "@applywise/types";
import type { ApplicationExecutor, ExecutorContext, ExecutorLogger } from "../types";
import type { BrowserAdapter } from "./adapters";
import { SubmitButtonNotFoundError, type BrowserChallenge, type BrowserDriver, type BrowserField, type BrowserFile, type BrowserSession } from "./driver";
import { createPlaywrightDriver } from "./playwright-driver";

/**
 * BROWSER executor flow (worker-side, Playwright + Chromium; never the user's browser).
 *
 *  open the apply page -> the page must still be on a URL the adapter allows (redirects are re-checked) -> stop on
 *  CAPTCHA / MFA / sign-in (manual handoff, never bypassed) -> list the fields -> map each label (classifyQuestion)
 *  to the user's resolved answer for that exact question, else verified applicant data, the approved cover letter or
 *  the resume PDF -> any REQUIRED field without a value => NEEDS_INFORMATION (nothing is guessed) -> fill -> dry run:
 *  stop before submit -> still on an allowed page? -> press the form's own submit button -> wait for the provider's
 *  confirmation (only accepted on an allowed page). No confirmation => FAILED with submissionUncertain (the service
 *  then asks the user to check).
 *
 * Field values are never logged.
 */

export interface BrowserFlowOptions {
  /** BROWSER_EXECUTOR_DRY_RUN: fill the form but never press submit. */
  dryRun: boolean;
  /** How long to wait for the confirmation after pressing submit. */
  confirmationTimeoutMs: number;
  /** The environment adapter.matches() is evaluated with (APP_URL for the demo pages). */
  env: ProviderEnv;
  logger?: ExecutorLogger;
}

const CHALLENGE_DETAIL: Record<BrowserChallenge, string> = {
  CAPTCHA: "The application page shows a CAPTCHA. ApplyWise never solves CAPTCHAs - open the official page and apply yourself.",
  MFA: "The provider asked for a one-time code (multi-factor authentication). Complete the application on the official page.",
  LOGIN_REQUIRED: "The application page requires you to sign in. ApplyWise never stores job-platform passwords - apply on the official page.",
};

const manual = (reason: ManualActionReason, detail: string): SubmissionResult => ({ outcome: "MANUAL_ACTION_REQUIRED", reason, detail });
const failed = (error: string, retryable: boolean, submissionUncertain: boolean): SubmissionResult => ({ outcome: "FAILED", retryable, error, submissionUncertain });
const errName = (e: unknown) => (e instanceof Error ? e.name : "Error");

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/\*/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

function inputTypeFor(field: BrowserField): ApplicationQuestion["inputType"] {
  switch (field.type) {
    case "select":
    case "radio":
      return "select";
    case "textarea":
      return "textarea";
    case "checkbox":
      return "boolean";
    case "file":
      return "file";
    case "url":
      return "url";
    case "email":
      return "email";
    case "number":
      return "number";
    default:
      return "text";
  }
}

/** classifyQuestion from the questions module; an unrecognised (or unavailable) label is a custom question. */
function classify(label: string, field: BrowserField, jobCountry: string | null): Pick<ApplicationQuestion, "key" | "canonicalKey"> {
  try {
    const q = classifyQuestion(label, { required: field.required, options: field.options, inputType: inputTypeFor(field), origin: "provider", jobCountry });
    return { key: q.key, canonicalKey: q.canonicalKey };
  } catch {
    return { key: `custom:${norm(label)}`, canonicalKey: "custom" };
  }
}

function applicantValue(key: CanonicalQuestionKey, label: string, p: SubmissionPayload): string | null {
  const a = p.applicant;
  switch (key) {
    case "first_name":
      return a.firstName || null;
    case "last_name":
      return a.lastName || null;
    case "full_name":
      return a.fullName || null;
    case "email":
      return a.email || null;
    case "phone":
      return a.phone;
    case "current_location":
      // Only ever the user's own current-location answer (the payload never infers it from preferred locations).
      return a.location;
    case "linkedin_url":
      return a.linkedinUrl;
    case "github_url":
      // "GitHub or portfolio URL" accepts either; a plain "GitHub" field never gets the portfolio.
      return a.githubUrl ?? (/portfolio|website/i.test(label) ? a.portfolioUrl : null);
    case "portfolio_url":
      return a.portfolioUrl ?? (/github/i.test(label) ? a.githubUrl : null);
    case "current_company":
      return a.currentCompany;
    case "current_title":
      return a.currentTitle;
    case "total_experience_years":
      return a.yearsOfExperience != null ? String(a.yearsOfExperience) : null;
    case "cover_letter":
      return p.coverLetter;
    default:
      return null;
  }
}

/**
 * The user's resolved answer to exactly this question. Exact key first: a qualified key (work_authorization:us,
 * visa_sponsorship:uk, diversity:veteran, skill_experience_years:react) is only ever answered by an answer to that
 * same question - never by an unqualified or other-country answer that shares the canonical key. Then the same
 * question text (answers stored without a classifier key).
 */
function answerValue(q: Pick<ApplicationQuestion, "key">, label: string, answers: SubmissionPayload["answers"]): string | null {
  const text = norm(label);
  const hit = answers.find((a) => a.key === q.key) ?? (text !== "" ? answers.find((a) => norm(a.key) === text || norm(a.question) === text) : undefined);
  return hit && hit.answer.trim() ? hit.answer : null;
}

type Planned = { field: BrowserField; kind: "fill"; value: string } | { field: BrowserField; kind: "upload"; file: BrowserFile };

/** The value for one field, from verified data only; null = unknown (never guessed). */
export function planField(field: BrowserField, payload: SubmissionPayload): Planned | null {
  const label = field.label || field.name || "";
  if (!label) return null;
  const q = classify(label, field, payload.jobCountry ?? null);
  if (field.type === "file") {
    const isResume = q.canonicalKey === "resume" || /\b(resume|cv|curriculum vitae)\b/i.test(label);
    return isResume && payload.resume ? { field, kind: "upload", file: payload.resume } : null;
  }
  // The user's explicit answer wins over profile-derived applicant data.
  const value = answerValue(q, label, payload.answers) ?? applicantValue(q.canonicalKey, label, payload);
  if (value == null || !value.trim()) return null;
  if (field.type === "checkbox") {
    // Only an explicit yes/no answer may tick a box (consent / declaration boxes stay with the user).
    return /^(yes|no|true|false)$/i.test(value.trim()) ? { field, kind: "fill", value } : null;
  }
  if (field.options?.length) {
    const option = field.options.find((o) => norm(o) === norm(value));
    return option ? { field, kind: "fill", value: option } : null;
  }
  return { field, kind: "fill", value };
}

/** Whether `raw` is an http(s) URL the adapter allows (the same allowlist as the stored apply URL). */
export function adapterAllows(adapter: BrowserAdapter, raw: string, env: ProviderEnv): boolean {
  try {
    const url = new URL(raw);
    return (url.protocol === "https:" || url.protocol === "http:") && adapter.matches(url, env);
  } catch {
    return false;
  }
}

const OFF_SITE_DETAIL = "The application page redirected to another site - ApplyWise only fills forms on the official application page. Apply on the official page.";

export async function runBrowserApplication(session: BrowserSession, adapter: BrowserAdapter, payload: SubmissionPayload, opts: BrowserFlowOptions): Promise<SubmissionResult> {
  const log = (outcome: string, meta: Record<string, unknown> = {}) => opts.logger?.info("executor.browser.flow", { adapter: adapter.id, outcome, ...meta });
  const onAllowedPage = () => {
    try {
      return adapterAllows(adapter, session.currentUrl(), opts.env);
    } catch {
      return false;
    }
  };
  /** Nothing was filled or submitted on the foreign page: a manual handoff, never a retry. */
  const offSite = (stage: string) => {
    log("off_origin", { stage });
    return manual("UNSUPPORTED_FLOW", OFF_SITE_DETAIL);
  };
  const url = payload.job.applyUrl;
  if (!url) return manual("UNSUPPORTED_FLOW", "This job has no application page to open.");
  if (!adapterAllows(adapter, url, opts.env)) return offSite("apply_url");
  try {
    await session.goto(url);
  } catch (e) {
    log("navigation_failed", { error: errName(e) });
    return failed("The application page could not be opened.", true, false);
  }
  // Redirects (HTTP or script) may have left the allowlisted page: never read, fill or submit anything there.
  if (!onAllowedPage()) return offSite("after_navigation");

  const challenge = await session.detectChallenge();
  if (challenge) {
    log("challenge", { challenge });
    return manual(challenge, CHALLENGE_DETAIL[challenge]);
  }

  const fields = await session.listFields();
  if (!onAllowedPage()) return offSite("after_list");
  if (fields.length === 0) return manual("UNSUPPORTED_FLOW", "No application form was found on the page - apply on the official page.");
  const plan: Planned[] = [];
  const missing: BrowserField[] = [];
  for (const field of fields) {
    const step = planField(field, payload);
    if (step) plan.push(step);
    else if (field.required) missing.push(field);
  }
  if (missing.length) {
    log("needs_information", { missing: missing.length });
    return { outcome: "NEEDS_INFORMATION", questions: missing.map((f) => ({ question: f.label || f.name || "Unlabelled required field", required: true })) };
  }

  try {
    for (const step of plan) {
      // A page script may navigate away while the form is being filled: stop before the next value is typed.
      if (!onAllowedPage()) return offSite("during_fill");
      if (step.kind === "upload") await session.upload(step.field.index, step.file);
      else await session.fill(step.field.index, step.value);
    }
  } catch (e) {
    // Nothing was submitted yet: safe to retry.
    log("fill_failed", { error: errName(e) });
    return failed("The application form could not be filled.", true, false);
  }

  if (!onAllowedPage()) return offSite("before_submit");
  const late = await session.detectChallenge();
  if (late) return manual(late, CHALLENGE_DETAIL[late]);
  if (opts.dryRun) {
    log("dry_run", { filled: plan.length });
    return manual("UNSUPPORTED_FLOW", "Dry run: the form was filled but not submitted");
  }

  try {
    await session.submit(adapter.submitSelectors);
  } catch (e) {
    if (e instanceof SubmitButtonNotFoundError) return manual("UNSUPPORTED_FLOW", "The application form has no recognisable submit button - apply on the official page.");
    log("submit_failed", { error: errName(e) });
    return failed("Pressing the submit button failed.", false, true);
  }

  const confirmation = await session.readConfirmation(adapter.confirmationPatterns, opts.confirmationTimeoutMs);
  if (!onAllowedPage()) {
    // The submit led to another site: a "confirmation" there proves nothing, and the data may have been posted.
    log("off_origin", { stage: "after_submit" });
    return failed("The page left the official application site after submitting - the application may or may not have been sent.", false, true);
  }
  if (confirmation) {
    log("submitted", { filled: plan.length });
    return { outcome: "SUBMITTED", externalApplicationId: adapter.extractReference(confirmation), confirmation };
  }
  const after = await session.detectChallenge().catch(() => null);
  if (after) return manual(after, `${CHALLENGE_DETAIL[after]} The form was not accepted automatically.`);
  log("no_confirmation");
  return failed("No confirmation appeared after submitting - the application may or may not have been sent.", false, true);
}

function envTimeout(env: ProviderEnv): number {
  const n = Number(env.BROWSER_EXECUTOR_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 5_000 ? Math.min(n, 600_000) : 60_000;
}

export interface BrowserExecutorDeps {
  /** Injected in tests; defaults to Playwright + Chromium. */
  driver?: (env: ProviderEnv) => BrowserDriver;
}

/** The BROWSER executor for one adapter ("browser:<adapter>"). Browser submissions are never idempotent. */
export function createBrowserExecutor(adapter: BrowserAdapter, deps: BrowserExecutorDeps = {}): ApplicationExecutor {
  return {
    kind: "BROWSER",
    id: `browser:${adapter.id}`,
    label: adapter.label,
    idempotentSubmission: false,
    async execute(payload: SubmissionPayload, ctx: ExecutorContext): Promise<SubmissionResult> {
      const timeoutMs = envTimeout(ctx.env);
      const driver = deps.driver?.(ctx.env) ?? createPlaywrightDriver({ headless: ctx.env.BROWSER_EXECUTOR_HEADLESS !== "false", timeoutMs });
      let session: BrowserSession;
      try {
        // Main-frame navigations off the adapter's allowlist are blocked before any request is sent.
        const allowUrl = (url: URL) => adapter.matches(url, ctx.env);
        session = await driver.newSession(ctx.signal ? { signal: ctx.signal, allowUrl } : { allowUrl });
      } catch (e) {
        ctx.logger.warn("executor.browser.launch_failed", { adapter: adapter.id, error: errName(e) });
        return failed("The browser could not be started on the worker.", true, false);
      }
      try {
        return await runBrowserApplication(session, adapter, payload, { dryRun: ctx.env.BROWSER_EXECUTOR_DRY_RUN === "true", confirmationTimeoutMs: timeoutMs, env: ctx.env, logger: ctx.logger });
      } finally {
        await session.close().catch(() => undefined);
      }
    },
  };
}
