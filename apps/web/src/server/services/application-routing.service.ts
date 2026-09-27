import "server-only";
import { prisma, type ApplicationStatus, type Prisma } from "@applywise/database";
import { generateScreeningAnswer, type GenerationContext, type WorkflowOptions } from "@applywise/ai";
import {
  collectApplicationQuestions,
  countryForLocations,
  QUESTION_RESOLVER_VERSION,
  questionKeyFor,
  requiresApplicationScopedAnswer,
  resolveApplicationAnswers,
  type ProviderQuestion,
} from "@applywise/job-engine";
import type { AnswerSource, PendingQuestion, SourcedClaim } from "@applywise/types";
import { audit } from "../audit";
import { logger } from "../logger";
import { enqueue } from "../queue";
import { applicationExecutionService, executeDedupeKey } from "./application-execution.service";
import { recordApplicationEvent, transitionApplication } from "./application-transitions";
import { automationRunsService } from "./automation-runs.service";
import { automationDecisionIsStale } from "./automation-staleness";
import { automationSettingsService } from "./automation-settings.service";
import { applicationScopedKey, candidateAnswersService } from "./candidate-answers.service";
import { consentService } from "./consent.service";
import { loadProviderJob } from "./provider-job-ref";
import { notificationService } from "./notification.service";

/**
 * Preparation routing for the automation.
 *
 * resolveQuestions(): every question of the application (standard fields, the job description's screening
 * questions, the provider's own form questions and the questions an executor found on the live form) is answered
 * from verified data first (answer resolver). Work-authorisation / sponsorship questions that name no country are
 * tied to the job's country. Open, non-sensitive questions the resolver cannot answer fall back to the existing
 * screening-answer generator, which is itself guarded by the claim validator and reports canConfirm=false when the
 * facts do not support an answer. A generated draft is only a suggestion: it never answers a REQUIRED question
 * (those stay pending until the user answers them), and an optional generated answer keeps the AUTO policy from
 * approving the application (the user reviews it first). Sensitive questions (salary, notice, work authorisation,
 * visa, relocation, start date) are never generated.
 *
 * routeAfterPreparation(): MANUAL -> READY_FOR_REVIEW; missing required answers -> NEEDS_INFORMATION; no automatic
 * executor -> MANUAL_ACTION_REQUIRED (manual handoff); AUTO + AUTO_ELIGIBLE + every safety check (incl. unchanged
 * rules and no generated answers) -> APPROVED by policy and queued for execution; everything else -> WAITING_APPROVAL.
 */

export interface PreparedAnswerDraft {
  question: string;
  answer: string;
  canConfirm: boolean;
  claims: SourcedClaim[];
  provider: string;
  modelId: string | null;
  promptVersion: string;
  questionKey: string | null;
  required: boolean;
  answerSource: AnswerSource;
  resolved: boolean;
}

export interface PreparedAnswers {
  drafts: PreparedAnswerDraft[];
  pending: PendingQuestion[];
  warnings: string[];
}

/** Contact/document fields are filled from the profile directly; they are not shown as screening answers. */
const FORM_FIELD_KEYS = new Set(["first_name", "last_name", "full_name", "email", "phone", "linkedin_url", "github_url", "portfolio_url", "resume", "cover_letter"]);
/** At most this many open questions go to the (possibly AI) generator per application. */
const MAX_GENERATED = 8;
/** At most this many executor-discovered questions are kept per application. */
const MAX_RUNTIME_QUESTIONS = 50;
const PROVIDER_INPUT_TYPES: ReadonlySet<ProviderQuestion["inputType"]> = new Set(["text", "textarea", "select", "boolean", "number", "file", "url", "email"]);

/**
 * The country a work-authorisation / sponsorship answer applies to is unknown (its key carries no country), so the
 * answer holds for this one application only ("Are you authorised to work in this country?" on a job whose country is
 * unknown) and is never reused for another job, which may be in another country.
 */
export function isUnqualifiedCountryKey(key: string, question: string): boolean {
  if (requiresApplicationScopedAnswer(key)) return true;
  // A key that is not the classifier's (e.g. a custom key) for a question that itself is an unqualified
  // work-authorisation / sponsorship question: the answer cannot be tied to a country either.
  const textKey = questionKeyFor(question);
  return requiresApplicationScopedAnswer(textKey) && !key.startsWith(`${textKey}:`);
}

/** Questions an executor found on the live application form (Application.runtimeQuestions), validated. */
export function parseRuntimeQuestions(value: unknown): ProviderQuestion[] {
  if (!Array.isArray(value)) return [];
  const out: ProviderQuestion[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const q = raw as Record<string, unknown>;
    const question = typeof q.question === "string" ? q.question.trim().slice(0, 500) : "";
    if (!question) continue;
    const options = Array.isArray(q.options) ? q.options.filter((o): o is string => typeof o === "string" && o.trim() !== "").slice(0, 100) : [];
    out.push({
      question,
      required: q.required === true,
      inputType: PROVIDER_INPUT_TYPES.has(q.inputType as ProviderQuestion["inputType"]) ? (q.inputType as ProviderQuestion["inputType"]) : options.length ? "select" : "text",
      options: options.length ? options : null,
      providerKey: typeof q.providerKey === "string" ? q.providerKey.slice(0, 200) : null,
    });
    if (out.length >= MAX_RUNTIME_QUESTIONS) break;
  }
  return out;
}

export async function resolveQuestions(userId: string, jobId: string, ctx: GenerationContext, opts: WorkflowOptions, applicationId: string | null = null): Promise<PreparedAnswers> {
  const warnings: string[] = [];
  const { ref, provider } = await loadProviderJob(userId, jobId);
  let providerQuestions: ProviderQuestion[] = [];
  if (provider.getApplicationRequirements) {
    try {
      const req = await provider.getApplicationRequirements(ref, { env: process.env });
      providerQuestions = req.questions;
      if (req.requiresLogin) warnings.push(`${provider.info(process.env).label} asks applicants to sign in.`);
    } catch (e) {
      warnings.push("The provider's application questions could not be loaded; only the job description's questions were answered.");
      logger.warn("application.requirements_failed", { jobId, provider: provider.id, error: e instanceof Error ? e.name : "unknown" });
    }
  }
  // Questions an executor met on the live form earlier (NEEDS_INFORMATION): the user's answers to them must reach the
  // payload, so they are resolved like the provider's own questions.
  const runtimeQuestions = applicationId
    ? parseRuntimeQuestions((await prisma.application.findFirst({ where: { id: applicationId, userId }, select: { runtimeQuestions: true } }))?.runtimeQuestions)
    : [];
  // "Authorised to work in this country?" means the job's country: the key carries it, so an answer given for a job in
  // another country is never reused (unknown country -> the key stays unqualified and only this application's answer counts).
  const jobCountry = countryForLocations(ctx.job.location ?? []);
  const questions = collectApplicationQuestions({ screeningQuestions: ctx.job.screeningQuestions, providerQuestions: [...providerQuestions, ...runtimeQuestions], jobCountry });
  const sources = await candidateAnswersService.answerSources(userId, applicationId);
  const { answers, pending } = resolveApplicationAnswers(questions, sources);
  const byKey = new Map(questions.map((q) => [q.key, q]));

  const drafts: PreparedAnswerDraft[] = [];
  let generated = 0;
  for (const a of answers) {
    const q = byKey.get(a.key);
    if (!q || FORM_FIELD_KEYS.has(q.canonicalKey) || a.status === "NOT_APPLICABLE") continue;
    if (a.status === "RESOLVED" && a.answer) {
      drafts.push({ question: q.question, answer: a.answer, canConfirm: true, claims: [], provider: "rules", modelId: null, promptVersion: QUESTION_RESOLVER_VERSION, questionKey: q.key, required: q.required, answerSource: a.source, resolved: true });
      continue;
    }
    // Unknown: open, non-sensitive questions may be drafted from verified facts by the guarded generator.
    if (!q.sensitive && generated < MAX_GENERATED && !q.options?.length) {
      generated++;
      const r = await generateScreeningAnswer(q.question, ctx, opts);
      if (r.data.canConfirm && r.data.answer.trim()) {
        // A generated draft is a suggestion, never an answer to a REQUIRED question: those come from verified data or
        // the user, so the question stays pending (NEEDS_INFORMATION) and the draft is not sent. An optional generated
        // answer may be sent, but only after review: policyBlockers() keeps the AUTO policy from approving it.
        drafts.push({ question: q.question, answer: r.data.answer, canConfirm: true, claims: r.data.claims, provider: r.meta.provider, modelId: r.meta.modelId, promptVersion: r.meta.promptVersion, questionKey: q.key, required: q.required, answerSource: "GENERATED", resolved: !q.required });
        continue;
      }
    }
    drafts.push({ question: q.question, answer: "", canConfirm: false, claims: [], provider: "rules", modelId: null, promptVersion: QUESTION_RESOLVER_VERSION, questionKey: q.key, required: q.required, answerSource: "UNKNOWN", resolved: false });
  }
  return { drafts, pending, warnings };
}

export interface RouteInput {
  pending: PendingQuestion[];
  /** No unsupported claims remain in the tailored resume after validation. */
  truthOk: boolean;
  warnings: string[];
  runId: string | null;
}

/** Final state after a successful preparation. Also used when an application is re-routed after the user answered questions. */
export async function routeAfterPreparation(userId: string, applicationId: string, input: RouteInput): Promise<ApplicationStatus> {
  const app = await prisma.application.findFirstOrThrow({
    where: { id: applicationId, userId },
    select: { id: true, jobId: true, evaluatedAt: true, origin: true, mode: true, automationDecision: true, rulesVersion: true, preparedAt: true, job: { select: { title: true, company: true } } },
  });
  const title = `${app.job.title} at ${app.job.company}`;
  const pendingJson = input.pending as unknown as Prisma.InputJsonValue;
  const link = `/applications/${applicationId}`;
  // Notifications about this preparation: a later preparation (new drafts) is a new episode and notifies again, while
  // a retried task for the same preparation does not.
  const episode = app.preparedAt ? String(app.preparedAt.getTime()) : "0";

  // The original, manual flow (and MANUAL mode): drafts wait for the user, who applies themselves.
  if (app.origin === "USER" && !app.mode) {
    return transitionApplication(userId, applicationId, "preparation_succeeded", { to: "READY_FOR_REVIEW", message: "Drafts ready for your review.", data: { pendingQuestions: pendingJson } });
  }
  if (app.mode === "MANUAL") {
    const to = await transitionApplication(userId, applicationId, "preparation_succeeded", {
      to: "READY_FOR_REVIEW",
      actor: "system",
      message: "Prepared automatically. Manual mode: review the drafts and apply yourself - nothing is submitted for you.",
      data: { pendingQuestions: pendingJson },
    });
    await notifyReview(userId, applicationId, title, link, episode);
    return to;
  }

  if (input.pending.length) {
    const to = await transitionApplication(userId, applicationId, "needs_information", {
      actor: "system",
      message: `Needs your answer to ${input.pending.length} required question${input.pending.length === 1 ? "" : "s"} before it can continue.`,
      data: { pendingQuestions: pendingJson },
      metadata: { questions: input.pending.map((p) => p.key) },
    });
    await notificationService.notify(userId, {
      type: "application.information_required",
      title: `Information needed: ${title}`,
      body: `Answer ${input.pending.length} question${input.pending.length === 1 ? "" : "s"} once; your answers are reused for future applications.`,
      link,
      dedupeKey: `info:${applicationId}:${input.pending.map((p) => p.key).sort().join(",")}`,
    });
    await automationRunsService.increment(input.runId, { needsInformation: 1 });
    await automationRunsService.item(input.runId, userId, { stage: "prepare", outcome: "NEEDS_INFORMATION", message: `${title}: ${input.pending.map((p) => p.question).join("; ")}`, applicationId });
    return to;
  }

  const executor = await applicationExecutionService.describeExecutor(userId, applicationId);
  // A provider connection that needs attention pauses submission (execute() holds the application and reconnecting
  // re-queues it) - it is not a manual handoff, and it must not send one "apply manually" notice per application.
  if (!executor.automatic && !executor.paused) {
    const to = await transitionApplication(userId, applicationId, "manual_action", {
      actor: "system",
      message: `Prepared. Automatic submission is not available: ${executor.detail}`,
      data: { pendingQuestions: pendingJson, manualActionReason: executor.reason ?? "AUTOMATION_NOT_SUPPORTED", manualActionDetail: executor.detail.slice(0, 500), executorKind: "MANUAL", executorId: "manual" },
    });
    await notificationService.notify(userId, {
      type: "application.manual_action_required",
      title: `Apply manually: ${title}`,
      body: `${executor.detail} Everything is prepared - open the handoff to apply in a few minutes.`,
      link,
      dedupeKey: `manual:${applicationId}:${episode}`,
    });
    await automationRunsService.increment(input.runId, { manualActions: 1 });
    await automationRunsService.item(input.runId, userId, { stage: "route", outcome: "MANUAL_ACTION_REQUIRED", message: `${title}: ${executor.detail}`, applicationId });
    return to;
  }

  const blockers = await policyBlockers(userId, app, input);
  if (app.mode === "AUTO" && app.automationDecision === "AUTO_ELIGIBLE" && blockers.length === 0) {
    const { applicationService } = await import("./application.service");
    await applicationService.approveContent(userId, applicationId, "policy", input.runId);
    await enqueue("application.execute", { applicationId, runId: input.runId }, { userId, dedupeKey: executeDedupeKey(applicationId) });
    return "APPROVED";
  }

  const to = await transitionApplication(userId, applicationId, "preparation_succeeded", {
    to: "WAITING_APPROVAL",
    actor: "system",
    message: blockers.length ? `Waiting for your approval: ${blockers.join(" ")}` : "Prepared and waiting for your approval before it is submitted.",
    data: { pendingQuestions: pendingJson, executorKind: executor.kind, executorId: executor.id },
    metadata: { blockers },
  });
  await notifyReview(userId, applicationId, title, link, episode);
  await automationRunsService.item(input.runId, userId, { stage: "route", outcome: "WAITING_APPROVAL", message: `${title}${blockers.length ? `: ${blockers.join(" ")}` : ""}`, applicationId });
  return to;
}

/** Why an AUTO_ELIGIBLE application must still wait for the user (empty = it may be submitted by policy). */
export async function policyBlockers(
  userId: string,
  app: { id: string; jobId: string; evaluatedAt: Date | null; mode: string | null; automationDecision: string | null; rulesVersion: number | null },
  input: Pick<RouteInput, "truthOk">,
): Promise<string[]> {
  if (app.mode !== "AUTO" || app.automationDecision !== "AUTO_ELIGIBLE") return [];
  const out: string[] = [];
  const { settings } = await automationSettingsService.ensure(userId);
  if (!settings.enabled) out.push("Automation is turned off.");
  if (settings.mode !== "AUTO") out.push("Your mode is no longer Auto.");
  if (!(await consentService.get(userId)).autoApply) out.push("The auto-apply consent is not granted.");
  // The AUTO_ELIGIBLE decision was made under these rules: after a rules change it no longer counts.
  if (app.rulesVersion !== settings.rulesVersion) out.push("Your Auto rules changed after this job was evaluated.");
  else if (await automationDecisionIsStale(userId, { jobId: app.jobId, evaluatedAt: app.evaluatedAt })) out.push("Your profile or preferences changed since this job was evaluated.");
  if (!input.truthOk) out.push("The tailored resume or cover letter had claims that are not backed by verified facts.");
  // Generated text is never submitted without the user's review (required questions never take a generated answer).
  const generated = await prisma.screeningAnswerDraft.count({ where: { applicationId: app.id, userId, answerSource: "GENERATED", resolved: true, NOT: { answer: "" } } });
  if (generated > 0) out.push(`${generated === 1 ? "An answer was" : `${generated} answers were`} drafted by the answer generator and need${generated === 1 ? "s" : ""} your review.`);
  return out;
}

async function notifyReview(userId: string, applicationId: string, title: string, link: string, episode: string) {
  await notificationService.notify(userId, {
    type: "application.approval_required",
    title: `Ready for your review: ${title}`,
    body: "The application is prepared from your verified profile. Review it and approve, edit or skip.",
    link,
    dedupeKey: `review:${applicationId}:${episode}`,
  });
}

/** The user answered NEEDS_INFORMATION questions: store them as reusable answers and resume the workflow. */
export async function provideInformation(
  userId: string,
  applicationId: string,
  answers: { key: string; question: string; answer: string; remember: boolean }[],
  requestId?: string,
): Promise<ApplicationStatus> {
  const app = await prisma.application.findFirst({ where: { id: applicationId, userId }, select: { status: true, pendingQuestions: true, job: { select: { locations: true } } } });
  if (!app) throw new Error("Application not found");
  const jobCountry = countryForLocations(app.job.locations);
  for (const a of answers) {
    // "Authorised to work in this country?" (a key without a country, e.g. found on the live form) means this job's
    // country: the answer is stored for that country, as the next preparation classifies the question.
    const key = jobCountry && requiresApplicationScopedAnswer(a.key) ? `${a.key}:${jobCountry}` : a.key;
    // User-authored answers. "Save for future applications" off => scoped to this application only. A
    // work-authorisation / sponsorship answer whose country is unknown is only true for this job: never reused.
    const reusable = a.remember && !isUnqualifiedCountryKey(key, a.question);
    const questionKey = reusable ? key : applicationScopedKey(applicationId, key);
    await candidateAnswersService.upsert(userId, { questionKey, question: a.question, answer: a.answer }, requestId);
  }
  const answered = new Set(answers.map((a) => a.key));
  const remaining = ((app.pendingQuestions ?? []) as unknown as PendingQuestion[]).filter((p) => !answered.has(p.key));
  await recordApplicationEvent(userId, applicationId, "information_provided", `You answered ${answers.length} question${answers.length === 1 ? "" : "s"}.`, { actor: "user", metadata: { keys: [...answered] } });
  await audit(userId, "application.information_provided", { requestId, entityType: "Application", entityId: applicationId, metadata: { count: answers.length } });
  if (app.status !== "NEEDS_INFORMATION") return app.status;
  await prisma.application.update({ where: { id: applicationId }, data: { pendingQuestions: remaining as unknown as Prisma.InputJsonValue } });
  // Re-run preparation so the new answers flow into the drafts, then route again.
  const to = await transitionApplication(userId, applicationId, "information_provided", { actor: "user", message: "Resuming with your answers.", data: { preparationError: null } });
  await enqueue("application.prepare", { applicationId, requestId }, { userId, dedupeKey: `application.prepare:${applicationId}` });
  return to;
}
