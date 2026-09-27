import "server-only";
import { prisma, type ApplicationExecution, type ApplicationStatus, type ExecutorKind as DbExecutorKind, type Prisma } from "@applywise/database";
import {
  applicationProviderForJob,
  classifyQuestion,
  countryForLocations,
  questionKeyFor,
  type JobProvider,
  type ProviderEnv,
  type ProviderJobRef,
  type ProviderQuestion,
  type SubmissionPayload,
  type SubmissionResult,
} from "@applywise/job-engine";
import { renderResumePdf, type ResumeDocument } from "@applywise/resume-engine";
import type { CanonicalQuestionKey, ExecutorKind, ManualActionReason, PendingQuestion, ProviderConnectionStatus } from "@applywise/types";
import { env } from "@/env";
import { audit } from "../audit";
import { canTransition, type ApplicationAction } from "../domain/application-state";
import { AppError, Errors } from "../errors";
import { logger } from "../logger";
import { enqueue } from "../queue";
import { recordApplicationEvent, transitionApplication, type TransitionActor } from "./application-transitions";
import { automationRunsService } from "./automation-runs.service";
import { automationDecisionIsStale } from "./automation-staleness";
import { dayKey, inQuietHours, nextLocalDayStart, quietHoursEndAt } from "./automation-time";
import { consentService, type ConsentState } from "./consent.service";
import { executorInfo, providerLabel, selectExecutor, type ApplicationExecutor, type ExecutorSelection } from "./executors";
import { notificationService } from "./notification.service";
import { providerConnectionsService } from "./provider-connections.service";
import { canonicalJobKey, providerJobInclude, providerJobRef } from "./provider-job-ref";

/**
 * Application execution: the ONLY code path that invokes an ApplicationExecutor.
 *
 * execute() is idempotent and safe under retries, concurrent workers, overlapping schedulers and crashes:
 *  1. only APPROVED applications start (FAILED / MANUAL_ACTION_REQUIRED only on an explicit retry), only in REVIEW or
 *     AUTO mode (MANUAL - or no mode - never submits), only with an approval stamp (approvedAt), and a deferred task
 *     only for the approval it was scheduled under;
 *  2. AUTO-policy approvals are re-checked at execution time (automation on, AUTO mode, AUTO_APPLY consent, the Auto
 *     rules the job was evaluated under, a non-zero daily limit); a blocked policy approval goes back to the user's
 *     review queue (WAITING_APPROVAL), and policy approvals wait for the end of quiet hours;
 *  3. no automatic executor => manual handoff (MANUAL_ACTION_REQUIRED with the reason), except a broken provider
 *     connection, which holds the approved application until the user reconnects (then it is re-queued);
 *  4. ApplicationExecution.idempotencyKey = userId:canonicalJobKey is claimed with a unique insert + lease, so one
 *     canonical job is submitted at most once however many Job rows, workers or retries exist (SUCCEEDED is final;
 *     SUBMISSION_UNCERTAIN is a lock only the user's explicit retry lifts);
 *  5. a daily-limit slot is reserved atomically together with the attempt's slotDay, and given back in the same
 *     transaction that clears it (only when the attempt definitely did not submit);
 *  6. APPROVED -> APPLYING is compare-and-set; the executor then receives verified data and approved documents only;
 *  7. each outcome finishes the attempt and moves the application in ONE transaction, fenced on the attempt.
 * Deferred submissions (daily limit, retries, claim conflicts, recovery) are never scheduled inside quiet hours.
 * recoverStale() handles workers that died holding a lease: idempotent executors are retried, anything else asks
 * the user to check (SUBMISSION_UNCERTAIN) - never a blind resubmission. It also reconciles applications left in
 * APPLYING whose execution already finished.
 */

export type ExecutionOutcome = "APPLIED" | "FAILED" | "MANUAL_ACTION_REQUIRED" | "NEEDS_INFORMATION" | "DEFERRED" | "SKIPPED";

export interface ExecutionReport {
  outcome: ExecutionOutcome;
  detail: string;
}

export interface ExecutorDescription {
  kind: ExecutorKind;
  id: string;
  label: string;
  automatic: boolean;
  reason: ManualActionReason | null;
  detail: string;
  /**
   * True when automatic submission only waits for the user to reconnect the provider (its saved credential stopped
   * working): approved applications are held, not handed off, and go out again after reconnecting. Always set by
   * describeExecutor (optional only so hand-written descriptions stay valid).
   */
  paused?: boolean;
}

/** A worker holding an execution longer than this is considered dead (browser runs time out long before). */
export const EXECUTION_LEASE_MS = 10 * 60_000;
export const MAX_EXECUTION_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 30_000;
const RECOVERY_BATCH = 100;
const TX_OPTIONS = { maxWait: 10_000, timeout: 20_000 };

/**
 * Queue job id for application.execute. Initial enqueues use the bare key; re-enqueues made while a task with that
 * key may still be running/retained (retries, deferrals, recovery) add a suffix so the queue does not drop them.
 */
export function executeDedupeKey(applicationId: string, suffix?: string): string {
  return suffix ? `application.execute:${applicationId}:${suffix}` : `application.execute:${applicationId}`;
}

const report = (outcome: ExecutionOutcome, detail: string): ExecutionReport => ({ outcome, detail });
const human = (s: string) => s.replace(/_/g, " ").toLowerCase();
const providerEnv = (): ProviderEnv => ({ ...process.env });
const MANUAL_EXECUTOR = { kind: "MANUAL" as const, id: "manual" };
const NO_APPROVED_RESUME = "No approved resume is available for this application (the raw CV import is never sent) - approve a tailored or edited resume, or apply on the official page.";

interface ExecutionSettings {
  enabled: boolean;
  mode: "MANUAL" | "REVIEW" | "AUTO";
  maxApplicationsPerDay: number;
  timezone: string;
  quietHoursStart: number | null;
  quietHoursEnd: number | null;
  allowEmailApplications: boolean;
  generateCoverLetter: boolean;
  rulesVersion: number;
}

/** Schema defaults (automation off, MANUAL) when the user never opened the automation settings. */
const DEFAULT_SETTINGS: ExecutionSettings = {
  enabled: false,
  mode: "MANUAL",
  maxApplicationsPerDay: 10,
  timezone: "Asia/Kolkata",
  quietHoursStart: null,
  quietHoursEnd: null,
  allowEmailApplications: false,
  generateCoverLetter: true,
  // No settings row => no rule evaluation ever happened: a policy approval cannot match it.
  rulesVersion: 0,
};

async function loadSettings(userId: string): Promise<ExecutionSettings> {
  const s = await prisma.automationSettings.findUnique({
    where: { userId },
    select: {
      enabled: true,
      mode: true,
      maxApplicationsPerDay: true,
      timezone: true,
      quietHoursStart: true,
      quietHoursEnd: true,
      allowEmailApplications: true,
      generateCoverLetter: true,
      rulesVersion: true,
    },
  });
  return s ?? DEFAULT_SETTINGS;
}

/** A deferred submission time that is never inside the user's quiet hours. */
function outsideQuietHours(settings: ExecutionSettings, at: Date): Date {
  return inQuietHours(settings, at) ? quietHoursEndAt(settings, at) : at;
}

function effectiveLimit(settings: ExecutionSettings): number {
  return Math.min(settings.maxApplicationsPerDay, env().AUTOMATION_MAX_DAILY_LIMIT);
}

function loadApplication(userId: string, applicationId: string) {
  return prisma.application.findFirst({ where: { id: applicationId, userId }, include: { job: { include: providerJobInclude } } });
}
type LoadedApplication = NonNullable<Awaited<ReturnType<typeof loadApplication>>>;

interface SelectionContext {
  jobRef: ProviderJobRef;
  provider: JobProvider;
  penv: ProviderEnv;
  label: string;
  selection: ExecutorSelection;
  connectionStatus: ProviderConnectionStatus | null;
}

/** Connection states that mean "the saved credential stopped working": reconnecting resumes held applications. */
const BROKEN_CONNECTION = new Set<ProviderConnectionStatus>(["NEEDS_ATTENTION", "ERROR"]);

function pausedByConnection(selection: ExecutorSelection, status: ProviderConnectionStatus | null): boolean {
  return !selection.automatic && selection.reason === "LOGIN_REQUIRED" && !!status && BROKEN_CONNECTION.has(status);
}

/** Read-only: which executor would run this application right now. */
async function selectionFor(userId: string, app: LoadedApplication, settings: ExecutionSettings, consents: ConsentState): Promise<SelectionContext> {
  const jobRef = providerJobRef(app.job);
  const provider = applicationProviderForJob(jobRef);
  const penv = providerEnv();
  const [connection, account] = await Promise.all([
    prisma.providerConnection.findUnique({ where: { userId_provider: { userId, provider: provider.id } }, select: { status: true } }),
    prisma.user.findUnique({ where: { id: userId }, select: { emailVerifiedAt: true } }),
  ]);
  const selection = selectExecutor({
    job: jobRef,
    provider,
    env: penv,
    settings: { allowEmailApplications: settings.allowEmailApplications },
    connection,
    userEmailVerified: !!account?.emailVerifiedAt,
    emailSendingConsent: consents.emailSending,
  });
  return { jobRef, provider, penv, label: providerLabel(provider, penv), selection, connectionStatus: connection?.status ?? null };
}

function describe(selection: ExecutorSelection, connectionStatus: ProviderConnectionStatus | null): ExecutorDescription {
  const { executor } = selection;
  return selection.automatic
    ? { kind: executor.kind, id: executor.id, label: executor.label, automatic: true, reason: null, detail: `Submitted automatically via ${executor.label}.`, paused: false }
    : { kind: executor.kind, id: executor.id, label: executor.label, automatic: false, reason: selection.reason, detail: selection.detail, paused: pausedByConnection(selection, connectionStatus) };
}

// ---------------------------------------------------------------- payload (verified data only)

type ResumeFile = NonNullable<SubmissionPayload["resume"]>;

/**
 * An APPROVED resume version only: the approved TAILORED version of this application, else the approved base
 * version the preparation selected, else the user's latest own approved (EDITED) version - rendered to PDF. The raw
 * CV parse (ORIGINAL, never approved) is never sent; null => the application is handed to the user.
 */
async function resumeFor(userId: string, app: LoadedApplication): Promise<ResumeFile | null> {
  const approved = { approvedAt: { not: null } } satisfies Prisma.ResumeVersionWhereInput;
  const version =
    (await prisma.resumeVersion.findFirst({ where: { userId, applicationId: app.id, kind: "TAILORED", ...approved }, orderBy: { createdAt: "desc" } })) ??
    (app.selectedResumeVersionId ? await prisma.resumeVersion.findFirst({ where: { id: app.selectedResumeVersionId, userId, ...approved } }) : null) ??
    (app.selectedResumeId
      ? await prisma.resumeVersion.findFirst({ where: { userId, resumeId: app.selectedResumeId, kind: { in: ["ORIGINAL", "EDITED"] }, ...approved }, orderBy: { createdAt: "desc" } })
      : null) ??
    (await prisma.resumeVersion.findFirst({ where: { userId, kind: { in: ["ORIGINAL", "EDITED"] }, ...approved }, orderBy: { createdAt: "desc" } }));
  if (!version) return null;
  const doc = version.content as unknown as ResumeDocument;
  // Fixed creation date => byte-identical PDF on a retry.
  const content = await renderResumePdf(doc, { creationDate: version.createdAt });
  return { fileName: `${(doc.contact.fullName || "resume").replace(/[^\w]+/g, "_")}_Resume.pdf`, mimeType: "application/pdf", content };
}

async function buildPayload(
  userId: string,
  app: LoadedApplication,
  jobRef: ProviderJobRef,
  idempotencyKey: string,
  credential: { token: string } | null,
  settings: ExecutionSettings,
): Promise<SubmissionPayload> {
  const [profile, account, cover, answers, resume] = await Promise.all([
    prisma.candidateProfile.findUnique({ where: { userId } }),
    prisma.user.findUnique({ where: { id: userId }, select: { email: true } }),
    prisma.coverLetter.findUnique({ where: { applicationId: app.id }, select: { userId: true, body: true } }),
    // Resolved answers only: unknown answers are never sent (the application would be NEEDS_INFORMATION instead).
    prisma.screeningAnswerDraft.findMany({ where: { applicationId: app.id, userId, resolved: true }, orderBy: { sortOrder: "asc" }, select: { questionKey: true, question: true, answer: true } }),
    resumeFor(userId, app),
  ]);
  const fullName = (profile?.fullName ?? "").trim().replace(/\s+/g, " ");
  const [firstName = "", ...rest] = fullName ? fullName.split(" ") : [];
  const sent = answers.filter((a) => a.answer.trim());
  // Where the user lives only from their own current-location answer - never inferred from preferred locations.
  const currentLocation = sent.find((a) => a.questionKey === "current_location")?.answer.trim() ?? null;
  // "Write a cover letter" off => no cover letter is submitted, whatever an earlier preparation left behind.
  const coverAllowed = app.origin !== "AUTOMATION" || settings.generateCoverLetter;
  return {
    idempotencyKey,
    job: jobRef,
    jobCountry: countryForLocations(app.job.locations),
    applicant: {
      fullName,
      firstName,
      lastName: rest.join(" "),
      email: profile?.email ?? account?.email ?? "",
      phone: profile?.phone ?? null,
      location: currentLocation,
      linkedinUrl: profile?.linkedinUrl ?? null,
      githubUrl: profile?.githubUrl ?? null,
      portfolioUrl: profile?.portfolioUrl ?? null,
      currentCompany: profile?.currentCompany ?? null,
      currentTitle: profile?.currentTitle ?? null,
      yearsOfExperience: profile?.yoe ?? null,
    },
    resume,
    coverLetter: coverAllowed && cover && cover.userId === userId && cover.body.trim() ? cover.body : null,
    answers: sent.map((a) => ({ key: a.questionKey ?? a.question, question: a.question, answer: a.answer })),
    credential,
  };
}

// ---------------------------------------------------------------- questions

const SENSITIVE_KEYS = new Set<CanonicalQuestionKey>(["notice_period", "current_salary", "expected_salary", "work_authorization", "visa_sponsorship", "willing_to_relocate", "earliest_start_date", "diversity"]);

const slugKey = (question: string) =>
  `custom:${question
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80)}`;

function safeQuestionKey(question: string): string {
  try {
    return questionKeyFor(question);
  } catch {
    return slugKey(question);
  }
}

function pendingQuestion(question: string, required: boolean, jobCountry: string | null = null): PendingQuestion {
  let key: string;
  let canonicalKey: CanonicalQuestionKey = "custom";
  let sensitive = false;
  try {
    const q = classifyQuestion(question, { required, origin: "provider", jobCountry });
    canonicalKey = q.canonicalKey;
    sensitive = q.sensitive;
    // Same keys as preparation (country-bound questions carry the job's country), so the user's answer is found.
    key = questionKeyFor(question, { jobCountry });
  } catch {
    // Classifier unavailable: keep the question as a custom one (the user answers it; nothing is guessed).
    key = slugKey(question);
    sensitive = SENSITIVE_KEYS.has(canonicalKey);
  }
  return { key, canonicalKey, question, required, options: null, sensitive };
}

function storedPending(value: Prisma.JsonValue): PendingQuestion[] {
  return Array.isArray(value) ? (value as unknown as PendingQuestion[]).filter((q) => q && typeof q.key === "string") : [];
}

function storedRuntime(value: Prisma.JsonValue | null | undefined): ProviderQuestion[] {
  return Array.isArray(value) ? (value as unknown as ProviderQuestion[]).filter((q) => q && typeof q.question === "string" && q.question.trim() !== "") : [];
}

/**
 * Application.runtimeQuestions: the questions executors found on the live form (ProviderQuestion[]), merged and
 * de-duplicated by questionKeyFor(question). The next preparation resolves them like the provider's own questions.
 */
export function mergeRuntimeQuestions(existing: ProviderQuestion[], found: { question: string; required: boolean }[]): ProviderQuestion[] {
  const out = existing.map((q) => ({ ...q }));
  const byKey = new Map(out.map((q) => [safeQuestionKey(q.question), q]));
  for (const f of found) {
    const question = f.question.replace(/\s+/g, " ").trim();
    if (!question) continue;
    const key = safeQuestionKey(question);
    const known = byKey.get(key);
    if (known) {
      if (f.required) known.required = true;
      continue;
    }
    const q: ProviderQuestion = { question, required: f.required, inputType: "text", options: null, providerKey: null };
    byKey.set(key, q);
    out.push(q);
  }
  return out;
}

// ---------------------------------------------------------------- state helpers

interface Target {
  userId: string;
  applicationId: string;
  jobId: string;
  runId: string | null;
  title: string;
  link: string;
}

/**
 * Transition when the current status allows `action`; otherwise keep the status, apply the data and record the
 * event (e.g. a retried FAILED / MANUAL_ACTION_REQUIRED application only gets the new reason). Uses `tx` when given.
 */
async function moveOrRecord(
  t: Target,
  action: ApplicationAction,
  opts: { message: string; data: Prisma.ApplicationUncheckedUpdateManyInput; metadata?: Record<string, unknown>; actor?: TransitionActor },
  tx?: Prisma.TransactionClient,
): Promise<boolean> {
  const db = tx ?? prisma;
  const actor = opts.actor ?? "executor";
  const current = await db.application.findFirst({ where: { id: t.applicationId, userId: t.userId }, select: { status: true } });
  if (current && canTransition(current.status, action)) {
    try {
      await transitionApplication(t.userId, t.applicationId, action, { actor, message: opts.message, data: opts.data, metadata: opts.metadata ?? {}, ...(tx ? { tx } : {}) });
      return true;
    } catch (e) {
      if (!(e instanceof AppError)) throw e;
    }
  }
  await db.application.updateMany({ where: { id: t.applicationId, userId: t.userId }, data: opts.data });
  await recordApplicationEvent(t.userId, t.applicationId, action, opts.message, { actor, metadata: opts.metadata ?? {}, ...(tx ? { tx } : {}) });
  return false;
}

/** Hand the application to the user (MANUAL_ACTION_REQUIRED where the status allows it, else only the reason). */
async function moveToManual(t: Target, reason: ManualActionReason, detail: string, executor: { kind: DbExecutorKind; id: string }, tx?: Prisma.TransactionClient): Promise<void> {
  const data = { manualActionReason: reason, manualActionDetail: detail.slice(0, 500), executorKind: executor.kind, executorId: executor.id };
  await moveOrRecord(t, "manual_action", { message: `Needs you: ${detail}`, data, metadata: { reason } }, tx);
}

async function notifyManual(t: Target, detail: string, dedupeKey: string, title = `Apply manually: ${t.title}`): Promise<void> {
  await notificationService.notify(t.userId, {
    type: "application.manual_action_required",
    title,
    body: `${detail} Everything is prepared - open the handoff to finish the application.`,
    link: t.link,
    dedupeKey,
  });
}

async function runItem(t: Target, outcome: string, message: string, metadata: Record<string, unknown> = {}): Promise<void> {
  await automationRunsService.item(t.runId, t.userId, { stage: "execute", outcome, message: `${t.title}: ${message}`, jobId: t.jobId, applicationId: t.applicationId, metadata });
}

async function releaseSlotTx(tx: Prisma.TransactionClient, userId: string, day: string): Promise<void> {
  await tx.dailyApplicationCounter.updateMany({ where: { userId, day, count: { gt: 0 } }, data: { count: { decrement: 1 } } });
}

async function enqueueExecute(t: Target, runAt: Date, retry: boolean, suffix: string, approvedAt: Date | null): Promise<void> {
  await enqueue(
    "application.execute",
    // The approval stamp: the task only submits while the application still carries this approval.
    { applicationId: t.applicationId, runId: t.runId, retry, ...(approvedAt ? { approvedAt: approvedAt.toISOString() } : {}) },
    { userId: t.userId, runAt, dedupeKey: executeDedupeKey(t.applicationId, suffix) },
  );
}

/**
 * A policy approval that may no longer be submitted goes back to the user instead of staying APPROVED forever:
 * APPROVED -> WAITING_APPROVAL (approval cleared) + a review notification. An automatic retry of a FAILED /
 * MANUAL_ACTION_REQUIRED application simply stays with the user (no retry pending any more).
 */
async function returnPolicyApproval(t: Target, app: LoadedApplication, approvedAt: Date, blockers: string[]): Promise<ExecutionReport> {
  const detail = `Not submitted automatically: ${blockers.join(", ")}.`;
  if (app.status === "APPROVED") {
    try {
      await transitionApplication(t.userId, t.applicationId, "edit", {
        to: "WAITING_APPROVAL",
        from: ["APPROVED"],
        actor: "policy",
        message: `${detail} It is back in your review queue.`,
        data: { approvalSource: null, approvedAt: null, nextActionAt: null },
        metadata: { reason: "policy_blocked", blockers },
      });
    } catch (e) {
      if (!(e instanceof AppError)) throw e;
      return report("SKIPPED", "The application changed before the submission started.");
    }
    await notificationService.notify(t.userId, {
      type: "application.approval_required",
      title: `Needs your approval: ${t.title}`,
      body: `${detail} Review it and approve it to submit, or skip it.`,
      link: t.link,
      dedupeKey: `review:${t.applicationId}:returned:${approvedAt.getTime()}`,
    });
    await runItem(t, "WAITING_APPROVAL", detail, { blockers });
    return report("SKIPPED", detail);
  }
  await prisma.application.updateMany({ where: { id: t.applicationId, userId: t.userId, status: app.status }, data: { nextActionAt: null } });
  await recordApplicationEvent(t.userId, t.applicationId, "execution_blocked", detail, { actor: "policy", metadata: { blockers } });
  await runItem(t, "SKIPPED", detail, { blockers });
  return report("SKIPPED", detail);
}

/**
 * The provider's saved credential stopped working. An APPROVED application is held (not handed off, no per-app
 * notification - the provider notice covers it) and re-queued when the user reconnects; a retried FAILED /
 * MANUAL_ACTION_REQUIRED application stays with the user.
 */
async function pauseForConnection(t: Target, app: LoadedApplication, providerId: string, label: string): Promise<ExecutionReport> {
  const detail = `Paused until you reconnect ${label} in Settings -> Job sources; it is submitted automatically once the connection works again.`;
  if (app.status === "APPROVED") {
    const marked = await prisma.application.updateMany({
      where: { id: t.applicationId, userId: t.userId, status: "APPROVED", OR: [{ manualActionReason: null }, { manualActionReason: { not: "LOGIN_REQUIRED" } }] },
      data: { nextActionAt: null, manualActionReason: "LOGIN_REQUIRED", manualActionDetail: detail },
    });
    if (marked.count === 1) {
      await recordApplicationEvent(t.userId, t.applicationId, "execution_blocked", detail, { actor: "executor", metadata: { reason: "provider_needs_attention", providerId } });
    } else {
      // Already paused: stay out of the deferred sweep, no new timeline entry.
      await prisma.application.updateMany({ where: { id: t.applicationId, userId: t.userId, status: "APPROVED" }, data: { nextActionAt: null } });
    }
    await runItem(t, "DEFERRED", detail, { reason: "provider_needs_attention", providerId });
    return report("DEFERRED", detail);
  }
  const message = `Reconnect ${label} in Settings -> Job sources - the saved credential stopped working - then retry.`;
  await moveToManual(t, "LOGIN_REQUIRED", message, MANUAL_EXECUTOR);
  await runItem(t, "MANUAL_ACTION_REQUIRED", message, { reason: "LOGIN_REQUIRED", providerId });
  return report("MANUAL_ACTION_REQUIRED", message);
}

type ClaimResult =
  | { claimed: true; id: string; attempts: number; restore: Prisma.ApplicationExecutionUncheckedUpdateManyInput }
  | {
      claimed: false;
      detail: string;
      duplicateOf: string | null;
      /** The canonical job may already have been submitted: nothing may take it over automatically. */
      uncertain: { kind: DbExecutorKind; id: string } | null;
      /** Held by another application's live or unrecovered attempt: worth trying again later. */
      retryable: boolean;
    };

const NOT_UNCERTAIN = { OR: [{ manualActionReason: null }, { manualActionReason: { not: "SUBMISSION_UNCERTAIN" } }] } satisfies Prisma.ApplicationExecutionWhereInput;

/** Claim the idempotency key for this attempt (unique insert, else a conditional takeover). */
async function claimExecution(userId: string, applicationId: string, idempotencyKey: string, executor: ApplicationExecutor, now: Date): Promise<ClaimResult> {
  const leaseUntil = new Date(now.getTime() + EXECUTION_LEASE_MS);
  // INSERT ... ON CONFLICT DO NOTHING: exactly one concurrent caller inserts the row (no error noise for the others).
  const inserted = await prisma.applicationExecution.createMany({
    data: [{ userId, applicationId, idempotencyKey, executorKind: executor.kind, executorId: executor.id, status: "RUNNING", attempts: 1, leaseUntil, startedAt: now }],
    skipDuplicates: true,
  });
  if (inserted.count === 1) {
    const row = await prisma.applicationExecution.findUniqueOrThrow({ where: { idempotencyKey }, select: { id: true } });
    return { claimed: true, id: row.id, attempts: 1, restore: { status: "PENDING", leaseUntil: null, attempts: 0, finishedAt: now, slotDay: null } };
  }
  const refused = (detail: string, o: { duplicateOf?: string | null; uncertain?: { kind: DbExecutorKind; id: string } | null; retryable?: boolean } = {}): ClaimResult => ({
    claimed: false,
    detail,
    duplicateOf: o.duplicateOf ?? null,
    uncertain: o.uncertain ?? null,
    retryable: o.retryable ?? false,
  });
  const existing = await prisma.applicationExecution.findUnique({ where: { idempotencyKey } });
  if (!existing) return refused("Another worker is handling this job.", { retryable: true });
  const otherApplication = existing.applicationId !== applicationId;
  if (existing.status === "SUCCEEDED") return refused("Already applied to this job.", { duplicateOf: otherApplication ? existing.applicationId : null });
  // An attempt that may have reached the provider is a lock: no automatic task - for any listing of the job - takes
  // it over. Only the user's explicit retry of the application holding it lifts it (acknowledgeUncertainSubmission).
  if (existing.manualActionReason === "SUBMISSION_UNCERTAIN") {
    return refused(
      otherApplication
        ? "Another listing of this job may already have been submitted - check it first."
        : "The previous attempt may already have been submitted - waiting for you to check it.",
      { uncertain: { kind: existing.executorKind, id: existing.executorId } },
    );
  }
  const leaseLive = existing.status === "RUNNING" && !!existing.leaseUntil && existing.leaseUntil.getTime() > now.getTime();
  if (leaseLive) return refused("Another worker is submitting this application right now.", { retryable: otherApplication });
  // A dead worker's attempt that may have reached the provider is resolved by recoverStale / the user, never here.
  if (existing.status === "RUNNING" && !executorInfo(existing.executorId).idempotentSubmission) {
    return refused("A previous attempt was interrupted; waiting for recovery.", { retryable: otherApplication });
  }
  const taken = await prisma.applicationExecution.updateMany({
    where: {
      id: existing.id,
      status: { not: "SUCCEEDED" },
      OR: [{ status: { not: "RUNNING" } }, { leaseUntil: null }, { leaseUntil: { lt: now } }],
      // Atomic with the check above: a row that became uncertain meanwhile is never taken over.
      AND: [NOT_UNCERTAIN],
    },
    data: {
      status: "RUNNING",
      attempts: { increment: 1 },
      applicationId,
      executorKind: executor.kind,
      executorId: executor.id,
      leaseUntil,
      startedAt: now,
      finishedAt: null,
      lastError: null,
      manualActionReason: null,
      slotDay: null,
    },
  });
  if (taken.count === 0) return refused("Another worker is submitting this application right now.", { retryable: otherApplication });
  return {
    claimed: true,
    id: existing.id,
    attempts: existing.attempts + 1,
    restore: {
      status: existing.status,
      attempts: existing.attempts,
      applicationId: existing.applicationId,
      executorKind: existing.executorKind,
      executorId: existing.executorId,
      leaseUntil: null,
      manualActionReason: existing.manualActionReason,
      lastError: existing.lastError,
      finishedAt: existing.finishedAt,
      slotDay: null,
    },
  };
}

class ClaimLostError extends Error {
  constructor() {
    super("The execution claim was taken over.");
    this.name = "ClaimLostError";
  }
}

/**
 * Take a daily-limit slot and record it on this attempt in one transaction: the counter can never hold a slot no
 * attempt knows about (a crash between the two statements), and a lost claim takes no slot.
 */
async function reserveSlot(userId: string, claim: { id: string; attempts: number }, limit: number, timeZone: string, now: Date): Promise<string | null> {
  if (limit <= 0) return null;
  const day = dayKey(now, timeZone);
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`INSERT INTO "DailyApplicationCounter" ("userId", "day", "count", "updatedAt") VALUES (${userId}, ${day}, 0, NOW()) ON CONFLICT ("userId", "day") DO NOTHING`;
    // Conditional increment under the row lock: parallel workers can never push the count past the limit.
    const taken = await tx.dailyApplicationCounter.updateMany({ where: { userId, day, count: { lt: limit } }, data: { count: { increment: 1 } } });
    if (taken.count !== 1) return null;
    const own = await tx.applicationExecution.updateMany({ where: { id: claim.id, status: "RUNNING", attempts: claim.attempts }, data: { slotDay: day } });
    if (own.count !== 1) throw new ClaimLostError(); // rolls the increment back
    return day;
  }, TX_OPTIONS);
}

// ---------------------------------------------------------------- results

interface Attempt {
  t: Target;
  executor: ApplicationExecutor;
  providerId: string;
  providerLabel: string;
  executionId: string;
  attempts: number;
  slotDay: string;
  pending: PendingQuestion[];
  settings: ExecutionSettings;
  approvedAt: Date;
}

const superseded = (a: Attempt): ExecutionReport => {
  logger.warn("application.execute_superseded", { applicationId: a.t.applicationId, executionId: a.executionId, attempt: a.attempts });
  return report("SKIPPED", "This attempt was already resolved by crash recovery; nothing was changed.");
};

/**
 * Finish this attempt and move the application in ONE transaction: either both happen or neither (the execution
 * then stays RUNNING and recoverStale resolves it - nothing is left in APPLYING). Fenced on the attempt: a stale
 * worker whose attempt was recovered or superseded changes nothing (returns false). A released daily-limit slot is
 * given back in the same transaction that clears slotDay, so it can never be released twice.
 */
async function settle(a: Attempt, data: Prisma.ApplicationExecutionUncheckedUpdateManyInput, releaseSlot: boolean, move: (tx: Prisma.TransactionClient) => Promise<void>): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const res = await tx.applicationExecution.updateMany({
      where: { id: a.executionId, status: "RUNNING", attempts: a.attempts },
      data: { ...data, ...(releaseSlot ? { slotDay: null } : {}), leaseUntil: null, finishedAt: new Date() },
    });
    if (res.count !== 1) return false;
    if (releaseSlot) await releaseSlotTx(tx, a.t.userId, a.slotDay);
    await move(tx);
    return true;
  }, TX_OPTIONS);
}

async function onSubmitted(a: Attempt, r: Extract<SubmissionResult, { outcome: "SUBMITTED" }>): Promise<ExecutionReport> {
  const { t, executor } = a;
  const at = new Date();
  const confirmation = r.confirmation?.slice(0, 500) ?? null;
  const message = `Submitted via ${executor.label}.${confirmation ? ` ${confirmation}` : ""}`;
  const data = { appliedAt: at, externalApplicationId: r.externalApplicationId, executorKind: executor.kind, executorId: executor.id, failureReason: null, nextActionAt: null };
  await prisma.$transaction(async (tx) => {
    const row = await tx.applicationExecution.findUnique({ where: { id: a.executionId }, select: { status: true, attempts: true, slotDay: true } });
    const recovered = !row || row.status !== "RUNNING" || row.attempts !== a.attempts;
    if (recovered) logger.error("application.execute_applied_after_recovery", { applicationId: t.applicationId, executionId: a.executionId });
    // The idempotency record first: from here on this canonical job is never submitted again. A submission is a fact,
    // so it is recorded even when crash recovery already took this attempt over.
    await tx.applicationExecution.updateMany({
      where: { id: a.executionId },
      data: { status: "SUCCEEDED", submittedAt: at, externalApplicationId: r.externalApplicationId, confirmation, lastError: null, manualActionReason: null, leaseUntil: null, finishedAt: at, ...(row && !row.slotDay ? { slotDay: a.slotDay } : {}) },
    });
    // Recovery gave this attempt's slot back: the submission still counts against its day.
    if (row && !row.slotDay) {
      await tx.dailyApplicationCounter.upsert({ where: { userId_day: { userId: t.userId, day: a.slotDay } }, create: { userId: t.userId, day: a.slotDay, count: 1 }, update: { count: { increment: 1 } } });
    }
    const moved = await moveOrRecord(t, "execute_succeeded", { message, data, metadata: { executionId: a.executionId, externalApplicationId: r.externalApplicationId, ...(recovered ? { outOfBand: true } : {}) } }, tx);
    if (!moved) logger.error("application.execute_applied_out_of_band", { applicationId: t.applicationId, executionId: a.executionId });
  }, TX_OPTIONS);
  await notificationService.notify(t.userId, {
    type: "application.submitted",
    title: `Applied: ${t.title}`,
    body: `ApplyWise submitted your application via ${executor.label}.${confirmation ? ` ${confirmation}` : ""}`,
    link: t.link,
    dedupeKey: `submitted:${t.applicationId}`,
  });
  await automationRunsService.increment(t.runId, { applicationsSubmitted: 1 });
  await runItem(t, "APPLIED", message, { executorId: executor.id });
  await audit(t.userId, "application.submitted_by_executor", {
    entityType: "Application",
    entityId: t.applicationId,
    metadata: { executorId: executor.id, executorKind: executor.kind, executionId: a.executionId, externalApplicationId: r.externalApplicationId, attempt: a.attempts },
  });
  return report("APPLIED", confirmation ?? `Submitted via ${executor.label}.`);
}

async function onManual(a: Attempt, reason: ManualActionReason, detail: string): Promise<ExecutionReport> {
  const { t, executor } = a;
  const settled = await settle(a, { status: "MANUAL_ACTION_REQUIRED", manualActionReason: reason, lastError: detail.slice(0, 500) }, true, (tx) => moveToManual(t, reason, detail, executor, tx));
  if (!settled) return superseded(a);
  // One notification per attempt: a later, different handoff of the same application is announced again.
  await notifyManual(t, detail, `manual:${t.applicationId}:${a.executionId}:${a.attempts}`);
  await automationRunsService.increment(t.runId, { manualActions: 1 });
  await runItem(t, "MANUAL_ACTION_REQUIRED", detail, { reason });
  await audit(t.userId, "application.manual_action_required", { entityType: "Application", entityId: t.applicationId, metadata: { reason, executorId: executor.id } });
  return report("MANUAL_ACTION_REQUIRED", detail);
}

async function onNeedsInformation(a: Attempt, r: Extract<SubmissionResult, { outcome: "NEEDS_INFORMATION" }>): Promise<ExecutionReport> {
  const { t } = a;
  const pending = [...a.pending];
  const job = await prisma.job.findUnique({ where: { id: t.jobId }, select: { locations: true } });
  const jobCountry = countryForLocations(job?.locations ?? []);
  for (const q of r.questions) {
    const p = pendingQuestion(q.question, q.required, jobCountry);
    if (!pending.some((x) => x.key === p.key)) pending.push(p);
  }
  const detail = `The application form asks ${r.questions.length} question${r.questions.length === 1 ? "" : "s"} that ${r.questions.length === 1 ? "has" : "have"} no verified answer yet.`;
  const settled = await settle(a, { status: "NEEDS_INFORMATION", lastError: `${r.questions.length} question(s) need your answer.` }, true, async (tx) => {
    const current = await tx.application.findFirst({ where: { id: t.applicationId, userId: t.userId }, select: { runtimeQuestions: true } });
    // Kept for the next preparation, which resolves them (the user's answers included) into the submitted answers.
    const runtime = mergeRuntimeQuestions(storedRuntime(current?.runtimeQuestions), r.questions);
    await moveOrRecord(
      t,
      "needs_information",
      {
        message: detail,
        data: { pendingQuestions: pending as unknown as Prisma.InputJsonValue, runtimeQuestions: runtime as unknown as Prisma.InputJsonValue },
        metadata: { questions: pending.map((p) => p.key) },
      },
      tx,
    );
  });
  if (!settled) return superseded(a);
  await notificationService.notify(t.userId, {
    type: "application.information_required",
    title: `Information needed: ${t.title}`,
    body: `Answer ${r.questions.length} question${r.questions.length === 1 ? "" : "s"} once; your answers are reused for future applications.`,
    link: t.link,
    dedupeKey: `info:${t.applicationId}:${a.executionId}:${a.attempts}`,
  });
  await automationRunsService.increment(t.runId, { needsInformation: 1 });
  await runItem(t, "NEEDS_INFORMATION", detail);
  return report("NEEDS_INFORMATION", detail);
}

async function onAuthFailed(a: Attempt, detail: string): Promise<ExecutionReport> {
  const { t, executor } = a;
  const message = `Reconnect ${a.providerLabel} in Settings -> Job sources, then retry. ${detail}`.trim();
  const settled = await settle(a, { status: "FAILED", lastError: `Authentication failed: ${detail}`.slice(0, 500), manualActionReason: "LOGIN_REQUIRED" }, true, (tx) =>
    moveToManual(t, "LOGIN_REQUIRED", message, executor, tx),
  );
  if (!settled) return superseded(a);
  // One provider.needs_attention notification; approved applications for this provider are held until reconnecting.
  await providerConnectionsService.markAuthFailed(t.userId, a.providerId, detail);
  await automationRunsService.increment(t.runId, { manualActions: 1 });
  await runItem(t, "AUTH_FAILED", message, { providerId: a.providerId });
  await audit(t.userId, "application.execution_failed", { entityType: "Application", entityId: t.applicationId, metadata: { executorId: executor.id, reason: "auth_failed" } });
  return report("MANUAL_ACTION_REQUIRED", message);
}

async function onFailed(a: Attempt, r: Extract<SubmissionResult, { outcome: "FAILED" }>): Promise<ExecutionReport> {
  const { t, executor } = a;
  const error = r.error.slice(0, 500);
  if (r.submissionUncertain && !executor.idempotentSubmission) {
    // It may have been sent: keep the slot, never resubmit automatically, ask the user to check.
    const detail = `The submission via ${executor.label} may have gone through (${error.replace(/[.\s]+$/, "")}). Check on the official page whether it was sent, then mark it submitted or retry.`;
    const settled = await settle(a, { status: "FAILED", lastError: error, manualActionReason: "SUBMISSION_UNCERTAIN" }, false, (tx) => moveToManual(t, "SUBMISSION_UNCERTAIN", detail, executor, tx));
    if (!settled) return superseded(a);
    await notifyManual(t, detail, `uncertain:${t.applicationId}:${a.executionId}:${a.attempts}`, `Check your application: ${t.title}`);
    await automationRunsService.increment(t.runId, { manualActions: 1 });
    await runItem(t, "SUBMISSION_UNCERTAIN", detail);
    await audit(t.userId, "application.manual_action_required", { entityType: "Application", entityId: t.applicationId, metadata: { reason: "SUBMISSION_UNCERTAIN", executorId: executor.id } });
    return report("MANUAL_ACTION_REQUIRED", detail);
  }
  const willRetry = r.retryable && a.attempts < MAX_EXECUTION_ATTEMPTS;
  const retryAt = willRetry ? outsideQuietHours(a.settings, new Date(Date.now() + RETRY_BASE_DELAY_MS * 2 ** (a.attempts - 1))) : null;
  const settled = await settle(a, { status: "FAILED", lastError: error }, true, async (tx) => {
    await moveOrRecord(
      t,
      "execute_failed",
      {
        message: willRetry ? `Attempt ${a.attempts} failed (${error}). Retrying automatically.` : `Submission failed: ${error}`,
        data: { failureReason: error, nextActionAt: retryAt },
        metadata: { executionId: a.executionId, attempt: a.attempts, retryable: r.retryable },
      },
      tx,
    );
  });
  if (!settled) return superseded(a);
  if (willRetry && retryAt) {
    await enqueueExecute(t, retryAt, true, `retry:${a.executionId}:${a.attempts}`, a.approvedAt);
    await runItem(t, "RETRY_SCHEDULED", `Attempt ${a.attempts} failed; retrying at ${retryAt.toISOString()}.`);
    return report("FAILED", `Attempt ${a.attempts} failed; a retry is scheduled.`);
  }
  await notificationService.notify(t.userId, {
    type: "application.failed",
    title: `Application failed: ${t.title}`,
    body: `The automatic submission did not go through (${error}). You can retry or apply on the official page.`,
    link: t.link,
    dedupeKey: `failed:${t.applicationId}:${a.executionId}:${a.attempts}`,
  });
  await automationRunsService.increment(t.runId, { failures: 1 });
  await runItem(t, "FAILED", error);
  await audit(t.userId, "application.execution_failed", { entityType: "Application", entityId: t.applicationId, metadata: { executorId: executor.id, attempt: a.attempts, retryable: r.retryable } });
  return report("FAILED", error);
}

// ---------------------------------------------------------------- crash recovery helpers

type OrphanApp = { id: string; userId: string; automationRunId: string | null; jobId: string; executorId: string | null; job: { title: string; company: string } };

/**
 * An application left in APPLYING although no execution is RUNNING any more (the process died between finishing
 * the execution and moving the application, before those two writes became one transaction): move it to what the
 * execution recorded. Unknown outcomes of non-idempotent executors ask the user to check - never a resubmission.
 */
async function reconcileOrphan(app: OrphanApp, ex: ApplicationExecution | null, now: Date): Promise<boolean> {
  const t: Target = { userId: app.userId, applicationId: app.id, jobId: app.jobId, runId: app.automationRunId, title: `${app.job.title} at ${app.job.company}`, link: `/applications/${app.id}` };
  const move = async (action: ApplicationAction, message: string, data: Prisma.ApplicationUncheckedUpdateManyInput, metadata: Record<string, unknown>) => {
    try {
      await transitionApplication(t.userId, t.applicationId, action, { from: ["APPLYING"], actor: "executor", message, data, metadata: { ...metadata, reconciled: true } });
      return true;
    } catch (e) {
      if (!(e instanceof AppError)) throw e;
      return false; // moved meanwhile (another recovery pass)
    }
  };
  if (ex?.status === "SUCCEEDED") {
    const executor = { kind: ex.executorKind, id: ex.executorId };
    const ok = await move(
      "execute_succeeded",
      `Submitted via ${ex.executorId}.${ex.confirmation ? ` ${ex.confirmation}` : ""}`,
      { appliedAt: ex.submittedAt ?? now, externalApplicationId: ex.externalApplicationId, executorKind: executor.kind, executorId: executor.id, failureReason: null, nextActionAt: null },
      { executionId: ex.id },
    );
    if (ok) {
      await notificationService.notify(t.userId, { type: "application.submitted", title: `Applied: ${t.title}`, body: "ApplyWise submitted your application.", link: t.link, dedupeKey: `submitted:${t.applicationId}` });
    }
    return ok;
  }
  const reason = ex?.manualActionReason ?? null;
  const executorId = ex?.executorId ?? app.executorId;
  const idempotent = !!executorId && executorInfo(executorId).idempotentSubmission;
  // No finished outcome on record: whether the executor reached the provider is unknown.
  const unknownOutcome = !ex || ex.status === "PENDING" || ex.status === "CANCELLED" || ex.status === "RUNNING";
  if (reason === "SUBMISSION_UNCERTAIN" || (unknownOutcome && !idempotent)) {
    const detail = "The automation was interrupted while submitting. Check on the official page whether the application was sent, then mark it submitted or retry.";
    const ok = await move("manual_action", `Needs you: ${detail}`, { manualActionReason: "SUBMISSION_UNCERTAIN", manualActionDetail: detail }, { reason: "SUBMISSION_UNCERTAIN", executionId: ex?.id ?? null });
    if (ok) await notifyManual(t, detail, `uncertain:${t.applicationId}:orphan:${ex?.id ?? "none"}:${ex?.attempts ?? 0}`, `Check your application: ${t.title}`);
    return ok;
  }
  if (ex?.status === "NEEDS_INFORMATION") {
    return move("needs_information", "The application form asks questions that have no verified answer yet.", {}, { executionId: ex.id });
  }
  if (reason) {
    const detail = ex?.lastError ?? "The automation could not finish this application - apply on the official page.";
    const ok = await move("manual_action", `Needs you: ${detail}`, { manualActionReason: reason, manualActionDetail: detail.slice(0, 500) }, { reason, executionId: ex?.id ?? null });
    if (ok && reason !== "LOGIN_REQUIRED") await notifyManual(t, detail, `manual:${t.applicationId}:orphan:${ex?.id ?? "none"}:${ex?.attempts ?? 0}`);
    return ok;
  }
  const error = ex?.lastError ?? "The worker stopped before the submission finished.";
  const ok = await move("execute_failed", `Submission failed: ${error}`, { failureReason: error.slice(0, 500), nextActionAt: null }, { executionId: ex?.id ?? null });
  if (ok) {
    await notificationService.notify(t.userId, {
      type: "application.failed",
      title: `Application failed: ${t.title}`,
      body: "The automatic submission did not go through. You can retry or apply on the official page.",
      link: t.link,
      dedupeKey: `failed:${t.applicationId}:orphan:${ex?.id ?? "none"}:${ex?.attempts ?? 0}`,
    });
  }
  return ok;
}

// ---------------------------------------------------------------- service

export const applicationExecutionService = {
  /**
   * Idempotent; safe under retries, concurrent workers and crashes. `retry` allows FAILED / MANUAL_ACTION_REQUIRED.
   * `approvedAt` (set on deferred tasks) = the approval the task was scheduled under: a changed approval skips it.
   */
  async execute(userId: string, applicationId: string, opts: { runId?: string | null; retry?: boolean; approvedAt?: string | null } = {}): Promise<ExecutionReport> {
    const retry = opts.retry === true;
    const now = new Date();

    // 1. Load + start status.
    const app = await loadApplication(userId, applicationId);
    if (!app) return report("SKIPPED", "Application not found.");
    const allowedFrom: ApplicationStatus[] = retry ? ["APPROVED", "FAILED", "MANUAL_ACTION_REQUIRED"] : ["APPROVED"];
    if (!allowedFrom.includes(app.status)) return report("SKIPPED", `Nothing to submit: the application is ${human(app.status)}.`);

    // An attempt that may already have reached the employer holds the application until the user has checked it and
    // explicitly retried (applyNow with acknowledgeUncertain) - no automatic task may touch it, not even to re-route it.
    if (app.manualActionReason === "SUBMISSION_UNCERTAIN") return report("SKIPPED", "Waiting for you to check whether the previous attempt was received.");

    // 2. Mode: MANUAL (or no mode = the original manual flow) never submits.
    if (app.mode !== "REVIEW" && app.mode !== "AUTO") return report("SKIPPED", "Manual applications are never submitted automatically.");
    // Only approved content is ever submitted: every approval stamps approvedAt, and editing the content clears it.
    const approvedAt = app.approvedAt;
    if (!approvedAt) return report("SKIPPED", "The prepared content was never approved - review and approve it first.");
    // A deferred task belongs to the approval it was scheduled under (a re-approval or an edit invalidates it).
    if (opts.approvedAt && approvedAt.toISOString() !== opts.approvedAt) return report("SKIPPED", "The approval changed after this submission was scheduled.");
    const t: Target = {
      userId,
      applicationId,
      jobId: app.jobId,
      runId: opts.runId ?? app.automationRunId ?? null,
      title: `${app.job.title} at ${app.job.company}`,
      link: `/applications/${applicationId}`,
    };
    const settings = await loadSettings(userId);
    const consents = await consentService.get(userId);
    const limit = effectiveLimit(settings);
    if (app.approvalSource === "policy") {
      // 3. A policy approval is only as good as the policy right now.
      const blockers: string[] = [];
      if (!settings.enabled) blockers.push("automation is turned off");
      if (settings.mode !== "AUTO") blockers.push("the application mode is no longer Auto");
      if (!consents.autoApply) blockers.push("the auto-apply consent was withdrawn");
      if (app.rulesVersion == null || app.rulesVersion !== settings.rulesVersion) blockers.push("your Auto rules changed since this job was evaluated");
      else if (await automationDecisionIsStale(userId, app)) blockers.push("your profile or preferences changed since this job was evaluated");
      if (limit <= 0) blockers.push("your daily application limit is 0");
      if (blockers.length) return returnPolicyApproval(t, app, approvedAt, blockers);
      // Policy approvals never submit during quiet hours.
      if (inQuietHours(settings, now)) {
        const at = quietHoursEndAt(settings, now);
        await prisma.application.updateMany({ where: { id: applicationId, userId, status: { in: allowedFrom } }, data: { nextActionAt: at } });
        const detail = `Quiet hours: submission scheduled for ${at.toISOString()}.`;
        await recordApplicationEvent(userId, applicationId, "execution_deferred", detail, { actor: "executor", metadata: { reason: "quiet_hours", at: at.toISOString() } });
        await enqueueExecute(t, at, retry, `quiet:${at.getTime()}`, approvedAt);
        await runItem(t, "DEFERRED", detail);
        return report("DEFERRED", detail);
      }
    } else if (limit <= 0) {
      // A limit of 0 means "submit nothing automatically": say so once instead of deferring day after day.
      await prisma.application.updateMany({ where: { id: applicationId, userId, status: { in: allowedFrom } }, data: { nextActionAt: null } });
      const detail = "Your daily application limit is 0, so nothing is submitted automatically. Raise it on the Automation page, or apply on the official page.";
      await recordApplicationEvent(userId, applicationId, "execution_blocked", detail, { actor: "executor", metadata: { reason: "daily_limit_zero", limit } });
      await runItem(t, "SKIPPED", detail);
      return report("SKIPPED", detail);
    }

    // 4. Executor selection.
    const { jobRef, provider, label, selection, connectionStatus } = await selectionFor(userId, app, settings, consents);
    if (!selection.automatic) {
      if (pausedByConnection(selection, connectionStatus)) return pauseForConnection(t, app, provider.id, label);
      await moveToManual(t, selection.reason, selection.detail, MANUAL_EXECUTOR);
      // One notification per handoff episode (a later, different handoff of the same application is announced too).
      await notifyManual(t, selection.detail, `manual:${applicationId}:${selection.reason}:${app.updatedAt.getTime()}`);
      await automationRunsService.increment(t.runId, { manualActions: 1 });
      await runItem(t, "MANUAL_ACTION_REQUIRED", selection.detail, { reason: selection.reason });
      await audit(userId, "application.manual_action_required", { entityType: "Application", entityId: applicationId, metadata: { reason: selection.reason, providerId: provider.id } });
      return report("MANUAL_ACTION_REQUIRED", selection.detail);
    }
    const executor = selection.executor;

    // 4b. Credentials are checked before anything is claimed or moved, and decrypted only for this provider's API call.
    let credential: { token: string } | null = null;
    const auth = safeAuth(provider);
    if (executor.id === `api:${provider.id}` && (auth === "api_key" || auth === "oauth_token")) {
      credential = await providerConnectionsService.credentialFor(userId, provider.id);
      if (!credential) {
        const status = (await prisma.providerConnection.findUnique({ where: { userId_provider: { userId, provider: provider.id } }, select: { status: true } }))?.status ?? null;
        if (status && BROKEN_CONNECTION.has(status)) return pauseForConnection(t, app, provider.id, label);
        const detail = `Connect ${label} in Settings -> Job sources`;
        await moveToManual(t, "LOGIN_REQUIRED", detail, MANUAL_EXECUTOR);
        await notifyManual(t, detail, `manual:${applicationId}:LOGIN_REQUIRED:${app.updatedAt.getTime()}`);
        await runItem(t, "MANUAL_ACTION_REQUIRED", detail, { reason: "LOGIN_REQUIRED" });
        return report("MANUAL_ACTION_REQUIRED", detail);
      }
    }

    // 5. Idempotency claim on the canonical job.
    const idempotencyKey = `${userId}:${app.canonicalJobKey ?? canonicalJobKey(app.job)}`;
    const claim = await claimExecution(userId, applicationId, idempotencyKey, executor, now);
    if (!claim.claimed) {
      if (claim.duplicateOf) {
        await recordApplicationEvent(userId, applicationId, "duplicate_skipped", "Already applied via another listing", { actor: "executor", metadata: { applicationId: claim.duplicateOf } });
        try {
          await transitionApplication(userId, applicationId, "decline", { actor: "executor", message: "Already applied via another listing of the same job.", from: allowedFrom });
        } catch (e) {
          if (!(e instanceof AppError)) throw e;
        }
        await runItem(t, "SKIPPED", "Already applied via another listing.");
        return report("SKIPPED", "Already applied via another listing.");
      }
      if (claim.uncertain) {
        // (A leftover task of the uncertain application itself was already refused at the top of execute().)
        const detail = `${claim.detail} Check on the official page whether it was sent, then mark it submitted or retry.`;
        await moveToManual(t, "SUBMISSION_UNCERTAIN", detail, claim.uncertain);
        await notifyManual(t, detail, `uncertain:${applicationId}:blocked:${app.updatedAt.getTime()}`, `Check your application: ${t.title}`);
        await runItem(t, "SUBMISSION_UNCERTAIN", detail);
        return report("MANUAL_ACTION_REQUIRED", detail);
      }
      if (claim.retryable) {
        // Another listing of this job holds the claim right now: look again once its lease has run out.
        const at = outsideQuietHours(settings, new Date(now.getTime() + EXECUTION_LEASE_MS));
        await prisma.application.updateMany({ where: { id: applicationId, userId, status: { in: allowedFrom } }, data: { nextActionAt: at } });
        await enqueueExecute(t, at, retry, `claim:${at.getTime()}`, approvedAt);
        const detail = `${claim.detail} Trying again at ${at.toISOString()}.`;
        await runItem(t, "DEFERRED", detail);
        return report("DEFERRED", detail);
      }
      return report("SKIPPED", claim.detail);
    }
    // Not an attempt after all: the claim goes back to what it was (fenced on this attempt).
    const releaseClaim = () => prisma.applicationExecution.updateMany({ where: { id: claim.id, status: "RUNNING", attempts: claim.attempts }, data: claim.restore });

    // 6. Daily limit: slot + slotDay in one transaction.
    let slotDay: string | null;
    try {
      slotDay = await reserveSlot(userId, claim, limit, settings.timezone, now);
    } catch (e) {
      await releaseClaim();
      if (e instanceof ClaimLostError) return report("SKIPPED", "Another worker took this submission over.");
      throw e;
    }
    if (!slotDay) {
      await releaseClaim();
      const at = outsideQuietHours(settings, nextLocalDayStart(now, settings.timezone));
      await prisma.application.updateMany({ where: { id: applicationId, userId, status: { in: allowedFrom } }, data: { nextActionAt: at } });
      const detail = `Daily limit of ${limit} application${limit === 1 ? "" : "s"} reached - submission moved to ${at.toISOString()}.`;
      await recordApplicationEvent(userId, applicationId, "daily_limit_reached", detail, { actor: "executor", metadata: { limit, at: at.toISOString() } });
      await enqueueExecute(t, at, retry, `limit:${dayKey(at, settings.timezone)}`, approvedAt);
      await runItem(t, "DEFERRED", detail);
      return report("DEFERRED", detail);
    }
    const reservedDay = slotDay;

    // 7. APPROVED (or retried FAILED / MANUAL) -> APPLYING, compare-and-set.
    try {
      await transitionApplication(userId, applicationId, "execute_started", {
        actor: "executor",
        from: allowedFrom,
        // The approval this attempt was checked against must still be current (an edit in the meantime clears it).
        expect: { approvedAt },
        message: `Submitting via ${executor.label} (attempt ${claim.attempts}).`,
        data: { executorKind: executor.kind, executorId: executor.id, nextActionAt: null, manualActionReason: null, manualActionDetail: null, failureReason: null },
        metadata: { executionId: claim.id, attempt: claim.attempts },
      });
    } catch (e) {
      // Give back the slot and the claim together (fenced: only while this attempt still owns the row).
      await prisma.$transaction(async (tx) => {
        const res = await tx.applicationExecution.updateMany({ where: { id: claim.id, status: "RUNNING", attempts: claim.attempts }, data: claim.restore });
        if (res.count === 1) await releaseSlotTx(tx, userId, reservedDay);
      }, TX_OPTIONS);
      if (!(e instanceof AppError)) throw e;
      return report("SKIPPED", "The application changed before the submission started.");
    }
    await audit(userId, "application.execution_started", { entityType: "Application", entityId: applicationId, metadata: { executorId: executor.id, executionId: claim.id, attempt: claim.attempts } });

    const attempt: Attempt = {
      t,
      executor,
      providerId: provider.id,
      providerLabel: label,
      executionId: claim.id,
      attempts: claim.attempts,
      slotDay: reservedDay,
      pending: storedPending(app.pendingQuestions),
      settings,
      approvedAt,
    };

    // 8 + 9. Verified payload -> executor.
    let result: SubmissionResult;
    let executorRan = false;
    try {
      const payload = await buildPayload(userId, app, jobRef, idempotencyKey, credential, settings);
      if (!payload.resume) {
        // Nothing unapproved is ever sent: without an approved resume the user takes over.
        result = { outcome: "MANUAL_ACTION_REQUIRED", reason: "UNSUPPORTED_FLOW", detail: NO_APPROVED_RESUME };
      } else {
        executorRan = true;
        result = await executor.execute(payload, {
          userId,
          applicationId,
          job: jobRef,
          provider,
          env: providerEnv(),
          logger: logger.child({ applicationId, executorId: executor.id }),
          signal: AbortSignal.timeout(EXECUTION_LEASE_MS - 60_000),
        });
      }
    } catch (e) {
      logger.warn("application.execute_threw", { applicationId, executorId: executor.id, error: e instanceof Error ? e.name : "unknown" });
      result = executorRan
        ? { outcome: "FAILED", retryable: true, error: "The executor stopped unexpectedly.", submissionUncertain: executor.kind === "BROWSER" }
        : { outcome: "FAILED", retryable: true, error: "The application could not be prepared for submission.", submissionUncertain: false };
    }

    switch (result.outcome) {
      case "SUBMITTED":
        return onSubmitted(attempt, result);
      case "MANUAL_ACTION_REQUIRED":
        return onManual(attempt, result.reason, result.detail);
      case "NEEDS_INFORMATION":
        return onNeedsInformation(attempt, result);
      case "AUTH_FAILED":
        return onAuthFailed(attempt, result.detail);
      case "FAILED":
        return onFailed(attempt, result);
    }
  },

  /**
   * The user checked an uncertain submission and explicitly asked the automation to try again ("Retry" on this
   * application): lift the SUBMISSION_UNCERTAIN lock of this application's own execution. Other listings of the job
   * stay blocked by another application's lock.
   */
  async acknowledgeUncertainSubmission(userId: string, applicationId: string): Promise<{ released: number }> {
    // Both locks: this application's own execution row, and the application's "may already have been sent" marker.
    return prisma.$transaction(async (tx) => {
      const res = await tx.applicationExecution.updateMany({
        where: { userId, applicationId, manualActionReason: "SUBMISSION_UNCERTAIN", status: { notIn: ["RUNNING", "SUCCEEDED"] } },
        data: { manualActionReason: null },
      });
      await tx.application.updateMany({ where: { id: applicationId, userId, manualActionReason: "SUBMISSION_UNCERTAIN" }, data: { manualActionReason: null, manualActionDetail: null } });
      return { released: res.count };
    });
  },

  /**
   * The user reconnected `providerId`: re-queue this user's approved applications that were held because its saved
   * credential stopped working (each is re-checked by execute()).
   */
  async resumePausedForProvider(userId: string, providerId: string): Promise<{ resumed: number }> {
    const held = await prisma.application.findMany({
      where: { userId, status: "APPROVED", mode: { in: ["REVIEW", "AUTO"] }, manualActionReason: "LOGIN_REQUIRED", approvedAt: { not: null } },
      include: { job: { include: providerJobInclude } },
      orderBy: { updatedAt: "asc" },
      take: 200,
    });
    const penv = providerEnv();
    let resumed = 0;
    for (const app of held) {
      let provider: JobProvider;
      try {
        provider = applicationProviderForJob(providerJobRef(app.job));
      } catch {
        continue;
      }
      if (provider.id !== providerId) continue;
      const now = new Date();
      // nextActionAt = now: if the task below is lost, the deferred sweep still picks the application up.
      const res = await prisma.application.updateMany({
        where: { id: app.id, userId, status: "APPROVED", manualActionReason: "LOGIN_REQUIRED" },
        data: { manualActionReason: null, manualActionDetail: null, nextActionAt: now },
      });
      if (res.count === 0) continue;
      await recordApplicationEvent(userId, app.id, "execution_resumed", `${providerLabel(provider, penv)} is connected again - submitting.`, { actor: "system", metadata: { providerId } });
      const t: Target = { userId, applicationId: app.id, jobId: app.jobId, runId: app.automationRunId, title: `${app.job.title} at ${app.job.company}`, link: `/applications/${app.id}` };
      await enqueueExecute(t, now, false, `reconnect:${now.getTime()}`, app.approvedAt);
      resumed++;
    }
    return { resumed };
  },

  /** Crash recovery for RUNNING executions whose lease expired, then applications orphaned in APPLYING. */
  async recoverStale(now = new Date()): Promise<{ recovered: number }> {
    const stale = await prisma.applicationExecution.findMany({
      where: { status: "RUNNING", leaseUntil: { lt: now } },
      orderBy: { leaseUntil: "asc" },
      take: RECOVERY_BATCH,
      include: { application: { select: { id: true, status: true, automationRunId: true, jobId: true, approvedAt: true, job: { select: { title: true, company: true } } } } },
    });
    let recovered = 0;
    for (const ex of stale) {
      const app = ex.application;
      const t: Target = { userId: ex.userId, applicationId: app.id, jobId: app.jobId, runId: app.automationRunId, title: `${app.job.title} at ${app.job.company}`, link: `/applications/${app.id}` };
      const fence = { id: ex.id, status: "RUNNING" as const, attempts: ex.attempts, leaseUntil: { lt: now } };
      // The executor runs only after APPROVED -> APPLYING: before that nothing can have been sent.
      const started = app.status === "APPLYING";
      const idempotent = executorInfo(ex.executorId).idempotentSubmission;
      if (!started || idempotent) {
        const canRetry = !started || ex.attempts < MAX_EXECUTION_ATTEMPTS;
        const retryAt = outsideQuietHours(await loadSettings(ex.userId), new Date(now.getTime() + RETRY_BASE_DELAY_MS));
        const lastError = "The worker stopped before the submission finished.";
        // Execution row, slot and application in one transaction (a slot can never be released twice).
        const done = await prisma.$transaction(async (tx) => {
          const res = await tx.applicationExecution.updateMany({ where: fence, data: { status: started ? "FAILED" : "PENDING", leaseUntil: null, finishedAt: now, slotDay: null, lastError } });
          if (res.count === 0) return false;
          if (ex.slotDay) await releaseSlotTx(tx, ex.userId, ex.slotDay);
          if (started) {
            await moveOrRecord(
              t,
              "execute_failed",
              {
                message: canRetry ? "The worker stopped mid-submission; retrying (this provider deduplicates submissions)." : "The worker stopped mid-submission.",
                data: { failureReason: lastError, nextActionAt: canRetry ? retryAt : null },
                metadata: { executionId: ex.id, recovered: true },
              },
              tx,
            );
          }
          return true;
        }, TX_OPTIONS);
        if (!done) continue;
        recovered++;
        if (canRetry) {
          await enqueueExecute(t, retryAt, started || app.status !== "APPROVED", `recover:${ex.id}:${ex.attempts}`, app.approvedAt);
        } else {
          await notificationService.notify(ex.userId, {
            type: "application.failed",
            title: `Application failed: ${t.title}`,
            body: "The automatic submission was interrupted repeatedly. You can retry or apply on the official page.",
            link: t.link,
            dedupeKey: `failed:${app.id}:${ex.id}:${ex.attempts}`,
          });
          await automationRunsService.increment(t.runId, { failures: 1 });
        }
        continue;
      }
      // Non-idempotent executor interrupted mid-submission: it may have been sent. Keep the slot, ask the user.
      const detail = "The automation was interrupted while submitting. Check on the official page whether the application was sent, then mark it submitted or retry.";
      const done = await prisma.$transaction(async (tx) => {
        const res = await tx.applicationExecution.updateMany({
          where: fence,
          data: { status: "MANUAL_ACTION_REQUIRED", manualActionReason: "SUBMISSION_UNCERTAIN", leaseUntil: null, finishedAt: now, lastError: "The worker stopped mid-submission." },
        });
        if (res.count === 0) return false;
        await moveToManual(t, "SUBMISSION_UNCERTAIN", detail, { kind: ex.executorKind, id: ex.executorId }, tx);
        return true;
      }, TX_OPTIONS);
      if (!done) continue;
      recovered++;
      await notifyManual(t, detail, `uncertain:${app.id}:${ex.id}:${ex.attempts}`, `Check your application: ${t.title}`);
      await automationRunsService.increment(t.runId, { manualActions: 1 });
      await audit(ex.userId, "application.manual_action_required", { entityType: "Application", entityId: app.id, metadata: { reason: "SUBMISSION_UNCERTAIN", executorId: ex.executorId, recovered: true } });
    }

    // Applications stuck in APPLYING whose execution is no longer RUNNING (older than a lease, so no live worker).
    const orphans = await prisma.application.findMany({
      where: { status: "APPLYING", updatedAt: { lt: new Date(now.getTime() - EXECUTION_LEASE_MS) }, executions: { none: { status: "RUNNING" } } },
      select: { id: true, userId: true, automationRunId: true, jobId: true, executorId: true, job: { select: { title: true, company: true } } },
      orderBy: { updatedAt: "asc" },
      take: RECOVERY_BATCH,
    });
    for (const orphan of orphans) {
      const ex = await prisma.applicationExecution.findFirst({ where: { applicationId: orphan.id }, orderBy: { updatedAt: "desc" } });
      if (await reconcileOrphan(orphan, ex, now)) recovered++;
    }
    return { recovered };
  },

  /** Which executor would run this application now (and why not, when manual). No side effects. */
  async describeExecutor(userId: string, applicationId: string): Promise<ExecutorDescription> {
    const app = await loadApplication(userId, applicationId);
    if (!app) throw Errors.notFound("Application");
    if (app.mode === "MANUAL") {
      return { kind: "MANUAL", id: "manual", label: "Manual handoff", automatic: false, reason: null, detail: "Manual mode: you apply on the official page yourself - nothing is submitted for you.", paused: false };
    }
    const [settings, consents] = await Promise.all([loadSettings(userId), consentService.get(userId)]);
    const { selection, connectionStatus } = await selectionFor(userId, app, settings, consents);
    return describe(selection, connectionStatus);
  },
};

function safeAuth(provider: JobProvider): string {
  try {
    return provider.info(providerEnv()).auth;
  } catch {
    return "none";
  }
}
