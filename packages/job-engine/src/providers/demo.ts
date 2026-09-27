import { createHash } from "node:crypto";
import type { ApplicationMessageCategory } from "@applywise/types";
import { normalizeRawJob } from "../connectors/normalize";
import {
  DEMO_NOTICE_PERIOD_QUESTION,
  DEMO_SINGAPORE_PERMIT_QUESTION,
  DEMO_WORK_AUTH_QUESTION,
  demoCompanySlug,
  generateDemoAutomationJobs,
  isDemoScenario,
  type DemoChannel,
  type DemoScenario,
} from "../demo/automation-jobs";
import { FeedProviderError } from "../feeds/types";
import { isDemoProviderEnabled, resolveProviderInfo } from "./catalog";
import { isDemoProviderJob } from "./routing";
import type {
  ApplicationRequirements,
  ApplicationSupport,
  JobProvider,
  ProviderApplicationStatus,
  ProviderJobRef,
  ProviderQuestion,
  StatusCheckResult,
  SubmissionPayload,
  SubmissionResult,
} from "./types";

/**
 * DEMO provider.
 *
 * DEMO CONTENT: fictional companies and jobs used to demonstrate the automation pipeline without real job-platform
 * accounts. Every job is flagged isDemo and carries `sourceMetadata.demo = true` and a `demoScenario` that drives the
 * simulated application outcome deterministically. Discovery, matching, rules, preparation and execution all run
 * through the real pipeline; only the remote side (the "provider") is simulated. Nothing leaves the server.
 */

export {
  DEMO_AUTOMATION_JOB_COUNT,
  DEMO_NOTICE_PERIOD_QUESTION,
  DEMO_SCENARIOS,
  DEMO_SINGAPORE_PERMIT_QUESTION,
  DEMO_SOURCES,
  DEMO_WORK_AUTH_QUESTION,
  demoAutomationJobBySlug,
  demoAutomationJobTier,
  demoCompanySlug,
  generateDemoAutomationJobs,
  isDemoScenario,
  type DemoAtsJob,
  type DemoChannel,
  type DemoJobsOptions,
  type DemoScenario,
  type DemoSourceId,
  type DemoTier,
} from "../demo/automation-jobs";

const DEFAULT_APP_URL = "http://localhost:3000";

/** Platforms the demo simulates as "no automatic applications" when a job carries no explicit scenario. */
const MANUAL_DEMO_PLATFORMS = new Set(["LINKEDIN", "NAUKRI"]);

/** The job's scripted scenario (seeded demo jobs without one: manual_only for LinkedIn/Naukri, else auto_success). */
export function demoScenarioForJob(job: Pick<ProviderJobRef, "platform" | "sourceMetadata">): DemoScenario {
  const scenario = job.sourceMetadata?.demoScenario;
  if (isDemoScenario(scenario)) return scenario;
  return MANUAL_DEMO_PLATFORMS.has(job.platform) ? "manual_only" : "auto_success";
}

export function demoChannelForJob(job: Pick<ProviderJobRef, "sourceMetadata">): DemoChannel {
  return job.sourceMetadata?.demoChannel === "browser" ? "browser" : "api";
}

/** A connection token the simulated provider accepts: "demo-..." except the scripted expired "demo-expired". */
export function isValidDemoToken(token: string | null | undefined): boolean {
  return typeof token === "string" && token.startsWith("demo-") && token !== "demo-expired";
}

const shortHash = (value: string, length = 10) => createHash("sha256").update(value).digest("hex").slice(0, length);

/** Confirmation number for a submission: stable per idempotency key. */
export function demoConfirmationFor(idempotencyKey: string): string {
  return `DEMO-${shortHash(idempotencyKey, 8).toUpperCase()}`;
}

// ---------------------------------------------------------------- in-memory simulation state

/** Bounded in-memory state (one process); enough for demos, never a source of truth. */
const MAX_TRACKED = 5_000;
const submitted = new Map<string, Extract<SubmissionResult, { outcome: "SUBMITTED" }>>();
const failedOnce = new Set<string>();

function remember<K, V>(map: Map<K, V>, key: K, value: V): void {
  if (map.size >= MAX_TRACKED) map.delete(map.keys().next().value as K);
  map.set(key, value);
}

function rememberFailure(key: string): void {
  if (failedOnce.size >= MAX_TRACKED) failedOnce.delete(failedOnce.values().next().value as string);
  failedOnce.add(key);
}

// ---------------------------------------------------------------- questions

function providerQuestions(scenario: DemoScenario): ProviderQuestion[] {
  const questions: ProviderQuestion[] = [
    { question: DEMO_NOTICE_PERIOD_QUESTION, required: true, inputType: "text", options: null, providerKey: "notice_period" },
    { question: DEMO_WORK_AUTH_QUESTION, required: true, inputType: "select", options: ["Yes", "No"], providerKey: "work_authorization_india" },
  ];
  if (scenario === "unknown_question") {
    questions.push({ question: DEMO_SINGAPORE_PERMIT_QUESTION, required: true, inputType: "select", options: ["Yes", "No"], providerKey: "work_permit_singapore" });
  }
  return questions;
}

const normalizeQuestion = (q: string) => q.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function answered(payload: SubmissionPayload, question: string): boolean {
  const target = normalizeQuestion(question);
  return payload.answers.some((a) => normalizeQuestion(a.question) === target && a.answer.trim().length > 0);
}

// ---------------------------------------------------------------- status messages

const HOUR_MS = 3_600_000;

function statusMessage(
  job: ProviderJobRef,
  appliedAt: Date,
  now: Date,
  category: ApplicationMessageCategory,
): NonNullable<StatusCheckResult["message"]> {
  const slug = demoCompanySlug(job.company) || "company";
  const title = job.title;
  const texts: Record<string, { subject: string; text: string; delayHours: number }> = {
    APPLICATION_CONFIRMATION: {
      subject: `We received your application for ${title}`,
      text: `Hi,\n\nThank you for applying to ${job.company}. We received your application for ${title} and our team will review it shortly.\n\n(DEMO CONTENT - simulated message)`,
      delayHours: 0,
    },
    ASSESSMENT: {
      subject: `Online assessment for ${title}`,
      text: `Hi,\n\nThank you for your interest in ${title} at ${job.company}. As the next step, please complete the online assessment (coding test) within 5 days.\n\n(DEMO CONTENT - simulated message)`,
      delayHours: 24,
    },
    INTERVIEW: {
      subject: `Interview invitation - ${title}`,
      text: `Hi,\n\nWe would like to invite you to an interview for ${title} at ${job.company}. Please share a few time slots that work for you to schedule the interview.\n\n(DEMO CONTENT - simulated message)`,
      delayHours: 48,
    },
    REJECTION: {
      subject: `Update on your application for ${title}`,
      text: `Hi,\n\nThank you for applying for ${title} at ${job.company}. Unfortunately, after careful consideration, we will not be moving forward with your application at this time. We have decided to proceed with other candidates whose experience more closely matches the role.\n\n(DEMO CONTENT - simulated message)`,
      delayHours: 72,
    },
    OFFER: {
      subject: `Offer letter - ${title}`,
      text: `Hi,\n\nCongratulations! We are delighted to extend you an offer for ${title} at ${job.company}. Please find the offer letter attached and let us know if you have questions.\n\n(DEMO CONTENT - simulated message)`,
      delayHours: 96,
    },
  };
  const t = texts[category] ?? texts.APPLICATION_CONFIRMATION!;
  const at = new Date(Math.min(appliedAt.getTime() + Math.max(t.delayHours * HOUR_MS, 5 * 60_000), now.getTime()));
  return { from: `talent@${slug}.example`, subject: t.subject, text: t.text, receivedAt: at.toISOString(), category };
}

const OUTCOMES: Partial<Record<DemoScenario, { status: ProviderApplicationStatus; category: ApplicationMessageCategory; detail: string }>> = {
  assessment: { status: "ASSESSMENT", category: "ASSESSMENT", detail: "(demo) The employer sent an online assessment." },
  interview: { status: "INTERVIEW", category: "INTERVIEW", detail: "(demo) The employer invited you to an interview." },
  rejection: { status: "REJECTED", category: "REJECTION", detail: "(demo) The employer is not moving forward." },
  offer: { status: "OFFER", category: "OFFER", detail: "(demo) The employer made an offer." },
};

// ---------------------------------------------------------------- provider

export const demoProvider: JobProvider = {
  id: "demo",

  info: (env) => resolveProviderInfo("demo", env),

  matchesJob: (job) => isDemoProviderJob(job),

  async discover(ctx) {
    if (!isDemoProviderEnabled(ctx.runtime.env)) throw new FeedProviderError("The demo provider is disabled on this server.", false);
    const configured = typeof ctx.config.appUrl === "string" && /^https?:\/\//.test(ctx.config.appUrl) ? ctx.config.appUrl : null;
    return generateDemoAutomationJobs({ appUrl: configured ?? ctx.runtime.env.APP_URL ?? DEFAULT_APP_URL, now: ctx.runtime.now });
  },

  normalize: normalizeRawJob,

  async getApplicationRequirements(job): Promise<ApplicationRequirements> {
    return {
      questions: providerQuestions(demoScenarioForJob(job)),
      requiresLogin: false,
      requiresResume: true,
      acceptsCoverLetter: true,
      notes: ["(demo) Simulated application form."],
    };
  },

  supportsApplication(job, env): ApplicationSupport {
    if (!isDemoProviderEnabled(env)) {
      return { supported: false, channel: "manual", reason: "AUTOMATION_NOT_SUPPORTED", detail: "The demo provider is disabled on this server." };
    }
    if (demoScenarioForJob(job) === "manual_only") {
      return { supported: false, channel: "manual", reason: "PROVIDER_RESTRICTION", detail: "(demo) This simulated platform does not allow automated applications." };
    }
    return demoChannelForJob(job) === "browser"
      ? { supported: true, channel: "browser", reason: null, detail: "(demo) Demo ATS page, filled by the browser executor." }
      : { supported: true, channel: "api", reason: null, detail: "(demo) Simulated application API." };
  },

  async submitApplication(payload, runtime): Promise<SubmissionResult> {
    if (!isDemoProviderEnabled(runtime.env)) {
      return { outcome: "MANUAL_ACTION_REQUIRED", reason: "AUTOMATION_NOT_SUPPORTED", detail: "The demo provider is disabled on this server." };
    }
    if (!isValidDemoToken(payload.credential?.token)) {
      return { outcome: "AUTH_FAILED", detail: "(demo) The demo connection token was rejected. Reconnect the demo provider." };
    }
    const key = payload.idempotencyKey;
    // Idempotent: the same key always returns the first successful submission.
    const previous = submitted.get(key);
    if (previous) return previous;

    const scenario = demoScenarioForJob(payload.job);
    switch (scenario) {
      case "manual_only":
        return { outcome: "MANUAL_ACTION_REQUIRED", reason: "PROVIDER_RESTRICTION", detail: "(demo) This simulated platform does not allow automated applications." };
      case "permanent_failure":
        return { outcome: "FAILED", retryable: false, error: "(demo) This posting has closed", submissionUncertain: false };
      case "captcha":
        return {
          outcome: "MANUAL_ACTION_REQUIRED",
          reason: "CAPTCHA",
          detail: "(demo) The application page shows a CAPTCHA. ApplyWise never bypasses CAPTCHAs: please submit this application yourself.",
        };
      case "login_required":
        return {
          outcome: "MANUAL_ACTION_REQUIRED",
          reason: "LOGIN_REQUIRED",
          detail: "(demo) The provider asks you to sign in before applying. Sign in and submit the application yourself.",
        };
      case "mfa":
        return {
          outcome: "MANUAL_ACTION_REQUIRED",
          reason: "MFA",
          detail: "(demo) The provider asked for a one-time verification code. Complete the verification and submit the application yourself.",
        };
      case "unknown_question":
        if (!answered(payload, DEMO_SINGAPORE_PERMIT_QUESTION)) return { outcome: "NEEDS_INFORMATION", questions: [{ question: DEMO_SINGAPORE_PERMIT_QUESTION, required: true }] };
        break;
      case "transient_failure":
        if (!failedOnce.has(key)) {
          rememberFailure(key);
          return { outcome: "FAILED", retryable: true, error: "(demo) The provider is temporarily unavailable (HTTP 503). It will be retried.", submissionUncertain: false };
        }
        break;
      default:
        break;
    }
    const result = { outcome: "SUBMITTED" as const, externalApplicationId: `demo-app-${shortHash(key, 12)}`, confirmation: demoConfirmationFor(key) };
    remember(submitted, key, result);
    return result;
  },

  async checkApplicationStatus(ref, runtime): Promise<StatusCheckResult> {
    const now = runtime.now ?? new Date();
    const outcome = OUTCOMES[demoScenarioForJob(ref.job)];
    if (outcome) {
      return { status: outcome.status, detail: outcome.detail, message: statusMessage(ref.job, ref.appliedAt, now, outcome.category) };
    }
    return {
      status: "UNDER_REVIEW",
      detail: "(demo) The application is under review.",
      message: statusMessage(ref.job, ref.appliedAt, now, "APPLICATION_CONFIRMATION"),
    };
  },
};
