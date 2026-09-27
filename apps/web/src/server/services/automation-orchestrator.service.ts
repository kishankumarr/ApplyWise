import "server-only";
import { randomBytes } from "node:crypto";
import { prisma, recomputeMatchScores, type ApplicationStatus, type Prisma } from "@applywise/database";
import { AUTOMATION_RULES_VERSION, evaluateAutomationRules, MATCH_ENGINE_VERSION, sourceProviderIdForJob } from "@applywise/job-engine";
import { ERROR_CODES, type AutomationDecision, type AutomationRunProviderDetail, type AutomationRunSummary, type JobMatchReport, type RuleCheck, type RuleEvaluation } from "@applywise/types";
import { env } from "@/env";
import { audit } from "../audit";
import { AppError, Errors } from "../errors";
import { logger } from "../logger";
import { enqueue } from "../queue";
import { executeDedupeKey } from "./application-execution.service";
import { recordApplicationEvent, transitionApplication } from "./application-transitions";
import { automationRunsService, runSummary, type RunCounter } from "./automation-runs.service";
import { automationSettingsService, effectiveDailyLimit, ruleConfig } from "./automation-settings.service";
import { dayKey, localHour } from "./automation-time";
import { dailyLimitService } from "./daily-limit.service";
import { jobFeedsService } from "./job-feeds.service";
import { notificationService } from "./notification.service";
import { canonicalJobKey, providerJobInclude, providerJobRef } from "./provider-job-ref";

/**
 * AutomationOrchestrator - the single place that drives the pipeline for a user:
 *
 *   discover (claim due feeds -> runSync: normalise, dedupe/merge, score)
 *   -> ensure fresh deterministic match scores
 *   -> evaluate rules (IGNORE / RECOMMEND / REVIEW / AUTO_ELIGIBLE) and record the decision on the Application
 *   -> queue preparation for REVIEW / AUTO_ELIGIBLE (capped per run); routing by mode happens after preparation
 *   -> execution is queued by the router (AUTO policy) or by the user's approval (REVIEW)
 *
 * Queue handlers only call into here. Everything is idempotent: one run per user at a time (a lease owned by the run,
 * renewed while it works), one Application per (user, job) (unique), one preparation per canonical job,
 * compare-and-set transitions, queue dedupe keys, and the execution service's per-canonical-job idempotency key.
 */

/**
 * The per-user run lease. The run that holds it (AutomationSettings.runLeaseRunId) renews it when it starts and while
 * it works; a lease that was not renewed for this long belongs to a crashed or stalled run and can be taken over.
 */
const RUN_LEASE_MS = 15 * 60_000;
/** The lease is renewed after every feed sync, between stages and after this many evaluated jobs / preparations. */
const LEASE_RENEW_EVERY_JOBS = 25;
const LEASE_RENEW_EVERY_PREPARATIONS = 10;
/** A single job that cannot be evaluated is skipped; this many in a row means something systemic: the run fails. */
const MAX_CONSECUTIVE_JOB_ERRORS = 5;
/** PREPARING longer than this (worker died after commit, before routing) is re-queued. */
const STALE_PREPARING_MS = 30 * 60_000;
/** APPROVED (Review/Auto) this long without a running or successful execution: its execute task was lost. */
const LOST_EXECUTE_MS = 15 * 60_000;
/** execute() already ran and recorded "execution_blocked": that is not a lost task (re-driven at most once a day). */
const BLOCKED_REDRIVE_BACKOFF_MS = 24 * 60 * 60_000;
/** Daily summaries: users are read in pages of this size (every enabled user is visited on each tick). */
const SUMMARY_PAGE_SIZE = 500;
/** Statuses the orchestrator may (re-)evaluate: it never touches applications the user or an executor moved on. */
const EVALUABLE: ApplicationStatus[] = ["DISCOVERED", "MATCHING", "MATCHED", "REJECTED_BY_RULES", "AUTO_ELIGIBLE"];
/** Statuses the "evaluate" transition starts from (after the match step). */
const EVALUATED: ApplicationStatus[] = ["MATCHED", "REJECTED_BY_RULES", "AUTO_ELIGIBLE"];
/** Another application for the same canonical job is sent or being sent. */
const SENT_OR_SENDING: ApplicationStatus[] = ["APPLYING", "APPLIED", "SUBMITTED", "EMAIL_SENT", "ASSESSMENT", "INTERVIEW", "OFFER"];
/** Another application for the same canonical job is being prepared or waits for a decision / submission. */
const IN_PROGRESS: ApplicationStatus[] = ["PREPARING", "NEEDS_INFORMATION", "READY_FOR_REVIEW", "WAITING_APPROVAL", "APPROVED", "MANUAL_ACTION_REQUIRED"];

const RUN_INTERRUPTED = "The run was interrupted before it finished (the worker restarted, or the run waited longer than its lease). The next run continues the work.";
const RUN_SUPERSEDED = "Stopped: a newer run took over for this account (this run was delayed or stalled). The newer run continues the work.";
const DUPLICATE_LISTING = "Another listing of this job is already prepared or being prepared - this one is not prepared again.";

const jobSelect = {
  id: true,
  title: true,
  company: true,
  platform: true,
  locations: true,
  workMode: true,
  applyMethod: true,
  applyUrl: true,
  sourceUrl: true,
  sourceExternalId: true,
  hrEmail: true,
  isDemo: true,
  salaryMin: true,
  salaryMax: true,
  currency: true,
  experienceMinYears: true,
  experienceMaxYears: true,
  postedAt: true,
  expiresAt: true,
  createdAt: true,
  descriptionLevel: true,
  matchKey: true,
  dedupeKey: true,
  skillRequirements: { select: { canonicalName: true, required: true } },
  ...providerJobInclude,
} satisfies Prisma.JobSelect;

type CandidateJob = Prisma.JobGetPayload<{ select: typeof jobSelect }>;

/** Result of evaluating one job. `newlyStrong`: REVIEW / AUTO_ELIGIBLE now, and not before this evaluation. */
export interface JobEvaluationOutcome {
  applicationId: string;
  decision: AutomationDecision;
  prepare: boolean;
  newlyStrong: boolean;
}

const DECISION_COUNTER: Record<AutomationDecision, RunCounter> = { IGNORE: "ignored", RECOMMEND: "recommended", REVIEW: "reviewRequired", AUTO_ELIGIBLE: "autoEligible" };

const isStrong = (d: AutomationDecision | null | undefined): boolean => d === "REVIEW" || d === "AUTO_ELIGIBLE";

/** Another process (the user, another run, an executor) moved the application on: skip it, do not fail. */
function movedOn(e: unknown): boolean {
  return e instanceof AppError && (e.code === ERROR_CODES.INVALID_STATE || e.code === ERROR_CODES.CONFLICT || e.code === ERROR_CODES.NOT_FOUND);
}

/** The run lost its lease to a newer run (or the lease was revoked as expired): it must stop without touching it. */
class RunSupersededError extends Error {
  constructor() {
    super("The automation run was superseded.");
    this.name = "RunSupersededError";
  }
}

/** A cuid-shaped id, generated before the run row exists so the lease can be claimed with its owner atomically. */
function newRunId(): string {
  return `c${Date.now().toString(36)}${randomBytes(8).toString("hex")}`;
}

/**
 * Claim the per-user run lease atomically for `runId`. Any other RUNNING run of the user cannot hold the lease any
 * more (it expired and now belongs to `runId`), so it can never renew it: it is closed here instead of staying
 * RUNNING forever.
 */
async function claimLease(userId: string, now: Date, requireEnabled: boolean, runId: string): Promise<boolean> {
  const res = await prisma.automationSettings.updateMany({
    where: { userId, ...(requireEnabled ? { enabled: true } : {}), OR: [{ runLeaseUntil: null }, { runLeaseUntil: { lt: now } }] },
    data: { runLeaseUntil: new Date(now.getTime() + RUN_LEASE_MS), runLeaseRunId: runId },
  });
  if (res.count !== 1) return false;
  await prisma.automationRun.updateMany({ where: { userId, status: "RUNNING", id: { not: runId } }, data: { status: "FAILED", completedAt: now, error: RUN_INTERRUPTED } });
  return true;
}

/** Extend the lease, only while `runId` still owns it. False: the run was superseded and must stop. */
async function renewLease(userId: string, runId: string): Promise<boolean> {
  const res = await prisma.automationSettings.updateMany({ where: { userId, runLeaseRunId: runId }, data: { runLeaseUntil: new Date(Date.now() + RUN_LEASE_MS) } });
  return res.count === 1;
}

/** Release the lease, only when `runId` owns it (never another run's). */
async function releaseLease(userId: string, runId: string): Promise<void> {
  await prisma.automationSettings.updateMany({ where: { userId, runLeaseRunId: runId }, data: { runLeaseUntil: null, runLeaseRunId: null } });
}

/** Finish a run (compare-and-set: a run that was already closed, e.g. reaped, keeps its outcome). */
async function closeRun(runId: string, status: "COMPLETED" | "FAILED", error: string | null = null): Promise<boolean> {
  const res = await prisma.automationRun.updateMany({ where: { id: runId, status: "RUNNING" }, data: { status, completedAt: new Date(), ...(error ? { error: error.slice(0, 300) } : {}) } });
  return res.count === 1;
}

/**
 * Close RUNNING runs whose task was lost or whose worker crashed: started more than a lease ago and not holding a live
 * lease. An expired lease the run still owns is revoked first (atomically), so the run cannot renew it afterwards.
 */
async function reapInterruptedRuns(now: Date): Promise<number> {
  const stale = await prisma.automationRun.findMany({
    where: { status: "RUNNING", startedAt: { lt: new Date(now.getTime() - RUN_LEASE_MS) } },
    select: { id: true, userId: true, user: { select: { automationSettings: { select: { runLeaseRunId: true, runLeaseUntil: true } } } } },
    orderBy: { startedAt: "asc" },
    take: 100,
  });
  let reaped = 0;
  for (const r of stale) {
    const lease = r.user.automationSettings;
    if (lease?.runLeaseRunId === r.id) {
      if (lease.runLeaseUntil && lease.runLeaseUntil >= now) continue; // renewed recently: still working
      const revoked = await prisma.automationSettings.updateMany({
        where: { userId: r.userId, runLeaseRunId: r.id, OR: [{ runLeaseUntil: null }, { runLeaseUntil: { lt: now } }] },
        data: { runLeaseUntil: null, runLeaseRunId: null },
      });
      if (revoked.count === 0) continue; // renewed meanwhile
    }
    const res = await prisma.automationRun.updateMany({ where: { id: r.id, status: "RUNNING" }, data: { status: "FAILED", completedAt: now, error: RUN_INTERRUPTED } });
    reaped += res.count;
  }
  if (reaped) logger.warn("automation.runs_reaped", { count: reaped });
  return reaped;
}

/** Queue a run's task. If that fails nothing would ever run it: the run is closed and its lease released. */
async function enqueueRun(userId: string, runId: string, trigger: string): Promise<void> {
  try {
    await enqueue("automation.run", { runId, trigger }, { userId, dedupeKey: `automation.run:${runId}` });
  } catch (e) {
    await closeRun(runId, "FAILED", "The run could not be queued. It is retried at the next scheduled run.").catch(() => undefined);
    await releaseLease(userId, runId).catch(() => undefined);
    throw e;
  }
}

/** Map a feed's provider to the registry id used by rules and the UI. */
function feedProviderId(provider: string): string {
  return ["imap", "gmail", "outlook", "microsoft", "forwarding"].includes(provider) ? "job_alert_email" : provider;
}

/** Another application for the same canonical job is prepared or on its way (one preparation per job, across runs). */
async function siblingPreparedOrInProgress(userId: string, canonical: string, applicationId: string): Promise<boolean> {
  const n = await prisma.application.count({
    where: { userId, canonicalJobKey: canonical, id: { not: applicationId }, OR: [{ status: { in: IN_PROGRESS } }, { preparedAt: { not: null } }] },
  });
  return n > 0;
}

/** The rule checks with the "already applied" check replaced by a failing duplicate-listing check (capped at RECOMMEND). */
function withDuplicateListingCheck(checks: RuleCheck[]): RuleCheck[] {
  const existing = checks.find((c) => c.key === "already_applied");
  const check: RuleCheck = { key: "already_applied", label: existing?.label ?? "Already applied", outcome: "fail", effect: "cap_recommend", detail: DUPLICATE_LISTING };
  return existing ? checks.map((c) => (c === existing ? check : c)) : [...checks, check];
}

/** A strong decision for a job whose other listing is already prepared / in progress becomes a recommendation. */
function asDuplicateListing(e: RuleEvaluation): RuleEvaluation {
  return { ...e, decision: "RECOMMEND", deferredByDailyLimit: false, checks: withDuplicateListingCheck(e.checks), reasons: [DUPLICATE_LISTING, ...e.reasons] };
}

/**
 * The run's second listing of a canonical job it is already preparing (or deferring): persist RECOMMEND so the
 * "awaiting preparation" query does not select it again on every run. False when the application moved on.
 */
async function skipDuplicateListing(userId: string, applicationId: string, runId: string): Promise<boolean> {
  const app = await prisma.application.findFirst({ where: { id: applicationId, userId }, select: { status: true, automationDecision: true, preparedAt: true, decisionReasons: true } });
  if (!app || app.preparedAt || (app.status !== "MATCHED" && app.status !== "AUTO_ELIGIBLE") || !isStrong(app.automationDecision)) return false;
  const checks = withDuplicateListingCheck(Array.isArray(app.decisionReasons) ? (app.decisionReasons as unknown as RuleCheck[]) : []);
  try {
    await transitionApplication(userId, applicationId, "evaluate", {
      to: "MATCHED",
      from: [app.status],
      actor: "system",
      message: `${decisionHeadline("RECOMMEND")}: ${DUPLICATE_LISTING}`,
      data: { automationDecision: "RECOMMEND", decisionReasons: checks as unknown as Prisma.InputJsonValue },
      metadata: { runId, decision: "RECOMMEND", duplicateListing: true },
    });
  } catch (e) {
    if (movedOn(e)) return false;
    throw e;
  }
  await automationRunsService.item(runId, userId, { stage: "prepare", outcome: "SKIPPED", message: DUPLICATE_LISTING, applicationId });
  return true;
}

/** Claim a due user for a scheduled run: lease (owned by the new run) -> next run time -> run row -> queued task. */
async function queueScheduledRun(userId: string, searchFrequencyMinutes: number, now: Date): Promise<boolean> {
  const runId = newRunId();
  if (!(await claimLease(userId, now, true, runId))) return false;
  try {
    await prisma.automationSettings.update({ where: { userId }, data: { nextRunAt: new Date(now.getTime() + searchFrequencyMinutes * 60_000) } });
    const { settings } = await automationSettingsService.ensure(userId);
    await prisma.automationRun.create({ data: { id: runId, userId, trigger: "schedule", mode: settings.mode } });
  } catch (e) {
    await releaseLease(userId, runId).catch(() => undefined);
    throw e;
  }
  await enqueueRun(userId, runId, "schedule");
  return true;
}

export const automationOrchestrator = {
  /**
   * Scheduler tick: close interrupted runs, then claim users whose run is due and queue their runs (safe with several
   * instances). One user's failure never stops the others.
   */
  async tick(now = new Date()): Promise<{ queued: number; reaped: number }> {
    const reaped = await reapInterruptedRuns(now).catch((e: unknown) => {
      logger.warn("automation.reap_failed", { error: e instanceof Error ? e.name : "unknown" });
      return 0;
    });
    const due = await prisma.automationSettings.findMany({
      where: { enabled: true, OR: [{ nextRunAt: null }, { nextRunAt: { lte: now } }], AND: [{ OR: [{ runLeaseUntil: null }, { runLeaseUntil: { lt: now } }] }] },
      select: { userId: true, searchFrequencyMinutes: true },
      orderBy: { nextRunAt: "asc" },
      take: 25,
    });
    let queued = 0;
    for (const s of due) {
      try {
        if (await queueScheduledRun(s.userId, s.searchFrequencyMinutes, now)) queued++;
      } catch (e) {
        logger.error("automation.schedule_failed", { userId: s.userId, error: e instanceof Error ? e.name : "unknown" });
      }
    }
    return { queued, reaped };
  },

  /**
   * Everything the scheduler does every tick, in one place: automation runs, deferred and lost executions, crashed-
   * execution recovery, provider status sync, quiet-hour notifications and daily summaries. Each step is isolated:
   * one failing step does not stop the others (failures are counted in `failedSteps`).
   */
  async schedulerTick(now = new Date()) {
    const out: Record<string, number> = {};
    let failedSteps = 0;
    const step = async (name: string, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (e) {
        failedSteps++;
        logger.warn("automation.scheduler_step_failed", { step: name, error: e instanceof Error ? e.name : "unknown" });
      }
    };
    await step("runs", async () => {
      const r = await this.tick(now);
      out.runs = r.queued;
      out.reapedRuns = r.reaped;
    });
    await step("deferred", async () => {
      out.deferred = await this.redriveDeferred(now);
    });
    await step("recover", async () => {
      await enqueue("execution.recover", {}, { userId: null, dedupeKey: "execution.recover" });
    });
    await step("notifications", async () => {
      await enqueue("notification.dispatch", {}, { userId: null, dedupeKey: "notification.dispatch" });
    });
    await step("statusSync", async () => {
      const { applicationStatusSyncService } = await import("./application-status-sync.service");
      const syncUsers = await applicationStatusSyncService.dueUsers(now, 25);
      for (const userId of syncUsers) await enqueue("application.status_sync", {}, { userId, dedupeKey: `application.status_sync:${userId}:${Math.floor(now.getTime() / 3_600_000)}` });
      out.statusSync = syncUsers.length;
    });
    await step("summaries", async () => {
      out.summaries = await this.dailySummaryTick(now);
    });
    out.failedSteps = failedSteps;
    return out;
  },

  /** "Run now" from the control centre (also used by the demo). Creates the run row so the UI can follow it. */
  async runNow(userId: string, trigger: "manual" | "demo" = "manual", requestId?: string): Promise<AutomationRunSummary> {
    const { settings } = await automationSettingsService.ensure(userId);
    const runId = newRunId();
    if (!(await claimLease(userId, new Date(), false, runId))) throw Errors.conflict("An automation run is already in progress.");
    try {
      await prisma.automationRun.create({ data: { id: runId, userId, trigger, mode: settings.mode } });
    } catch (e) {
      await releaseLease(userId, runId).catch(() => undefined);
      throw e;
    }
    await audit(userId, "automation.run_started", { requestId, entityType: "AutomationRun", entityId: runId, metadata: { trigger } });
    await enqueueRun(userId, runId, trigger);
    const fresh = await prisma.automationRun.findUniqueOrThrow({ where: { id: runId } });
    return runSummary(fresh);
  },

  /**
   * The pipeline for one user. Idempotent per run id (a retried task resumes; a finished run is not repeated). A run
   * only works while it owns the user's run lease: it renews it at the start and while it works, and stops as soon as
   * a newer run has taken it over.
   */
  async runForUser(userId: string, trigger: "schedule" | "manual" | "demo", opts: { runId?: string } = {}): Promise<AutomationRunSummary | null> {
    const now = new Date();
    const { settings, rule } = await automationSettingsService.ensure(userId);
    let run = opts.runId ? await prisma.automationRun.findFirst({ where: { id: opts.runId, userId } }) : null;
    if (opts.runId && !run) return null;
    if (run && run.status !== "RUNNING") return runSummary(run);
    if (!run) {
      // Direct call without a pre-claimed run (tests, CLI): claim the lease here, owned by the new run.
      const id = newRunId();
      if (!(await claimLease(userId, now, trigger === "schedule", id))) return null;
      try {
        run = await prisma.automationRun.create({ data: { id, userId, trigger, mode: settings.mode } });
      } catch (e) {
        await releaseLease(userId, id).catch(() => undefined);
        throw e;
      }
    } else if (!(await renewLease(userId, run.id))) {
      // The task waited longer than the lease and a newer run took over (or the lease was revoked as expired).
      await closeRun(run.id, "FAILED", RUN_SUPERSEDED);
      logger.warn("automation.run_superseded", { userId, runId: run.id, stage: "start" });
      return null;
    }
    const runId = run.id;
    if (trigger === "schedule" && !settings.enabled) {
      await closeRun(runId, "COMPLETED", "Automation was turned off before the run started.");
      await releaseLease(userId, runId);
      return null;
    }
    const keepLease = async () => {
      if (!(await renewLease(userId, runId))) throw new RunSupersededError();
    };
    try {
      // ---------------------------------------------------------------- 1. discover
      const providers: AutomationRunProviderDetail[] = [];
      const newJobIds = new Set<string>();
      const claimed = await jobFeedsService.claimDue({ userId, force: trigger !== "schedule", limit: 50 });
      for (const feed of claimed) {
        const r = await jobFeedsService.runSync(feed.id, `automation:${trigger}`);
        await keepLease();
        if (!r) continue;
        r.newJobIds.forEach((id) => newJobIds.add(id));
        providers.push({ providerId: feedProviderId(r.provider), label: r.label, feedId: r.feedId, fetched: r.fetched, created: r.created, merged: r.merged, skipped: r.skipped, error: r.error });
        await automationRunsService.item(runId, userId, {
          stage: "discovery",
          outcome: r.error ? "ERROR" : "OK",
          message: r.error ? `${r.label}: ${r.error}` : `${r.label}: ${r.fetched} found, ${r.created} new, ${r.merged} merged, ${r.skipped} not relevant`,
        });
      }
      const found = providers.reduce((n, p) => n + p.fetched, 0);
      const created = providers.reduce((n, p) => n + p.created, 0);
      const skipped = providers.reduce((n, p) => n + p.skipped, 0);
      await automationRunsService.increment(runId, {
        providersChecked: new Set(providers.map((p) => p.providerId)).size,
        jobsFound: found,
        newJobs: created,
        duplicates: Math.max(0, found - created - skipped),
        failures: providers.filter((p) => p.error).length,
      });
      await prisma.automationRun.update({ where: { id: runId }, data: { details: { providers } as unknown as Prisma.InputJsonValue } });

      // ---------------------------------------------------------------- 2. candidate jobs
      const jobs = await this.candidateJobs(userId, settings.rulesVersion, [...newJobIds], now);

      // ---------------------------------------------------------------- 3. match (deterministic; stale scores recomputed)
      const profile = await prisma.candidateProfile.findUnique({ where: { userId }, select: { factsVersion: true, yoe: true } });
      if (!profile) throw Errors.invalidState("Create your profile before running the automation.");
      const scores = new Map(
        (await prisma.jobMatchScore.findMany({ where: { userId, jobId: { in: jobs.map((j) => j.id) } }, select: { jobId: true, factsVersion: true, engineVersion: true } })).map((s) => [s.jobId, s]),
      );
      const stale = jobs.filter((j) => {
        const s = scores.get(j.id);
        return !s || s.factsVersion !== profile.factsVersion || s.engineVersion !== MATCH_ENGINE_VERSION;
      });
      const staleIds = new Set(stale.map((j) => j.id));
      if (stale.length) await recomputeMatchScores(prisma, userId, stale.map((j) => j.id));
      const reports = new Map(
        (await prisma.jobMatchScore.findMany({ where: { userId, jobId: { in: jobs.map((j) => j.id) } }, select: { jobId: true, score: true, report: true } })).map((s) => [s.jobId, s]),
      );
      await automationRunsService.increment(runId, { jobsMatched: reports.size });
      await keepLease();

      // ---------------------------------------------------------------- 4. rules (one job's failure never fails the run)
      const config = ruleConfig(settings, rule);
      const toPrepare: { applicationId: string; score: number; canonical: string }[] = [];
      const decisions: Record<AutomationDecision, number> = { IGNORE: 0, RECOMMEND: 0, REVIEW: 0, AUTO_ELIGIBLE: 0 };
      /** Applications that became REVIEW / AUTO_ELIGIBLE in this run (for the strong-match notification). */
      const newlyStrong = new Map<string, AutomationDecision>();
      let evaluated = 0;
      let consecutiveErrors = 0;
      for (const job of jobs) {
        const score = reports.get(job.id);
        if (!score) continue;
        if (evaluated > 0 && evaluated % LEASE_RENEW_EVERY_JOBS === 0) await keepLease();
        evaluated++;
        let outcome: JobEvaluationOutcome | null;
        try {
          outcome = await this.evaluateJob(userId, job, score.report as unknown as JobMatchReport, { runId, config, candidateYoe: profile.yoe, mode: settings.mode, rulesVersion: settings.rulesVersion, timezone: settings.timezone, rescored: staleIds.has(job.id), now });
          consecutiveErrors = 0;
        } catch (e) {
          consecutiveErrors++;
          logger.warn("automation.evaluate_failed", { userId, runId, jobId: job.id, error: e instanceof Error ? e.name : "unknown" });
          if (consecutiveErrors >= MAX_CONSECUTIVE_JOB_ERRORS) throw e;
          await automationRunsService.item(runId, userId, { stage: "rules", outcome: "ERROR", message: `${job.title} at ${job.company}: could not be evaluated in this run.`, jobId: job.id });
          await automationRunsService.increment(runId, { failures: 1 });
          continue;
        }
        if (!outcome) continue;
        decisions[outcome.decision]++;
        if (outcome.newlyStrong) newlyStrong.set(outcome.applicationId, outcome.decision);
        if (outcome.prepare) toPrepare.push({ applicationId: outcome.applicationId, score: score.score, canonical: canonicalJobKey(job) });
      }
      const counters: Partial<Record<RunCounter, number>> = {};
      for (const [d, n] of Object.entries(decisions) as [AutomationDecision, number][]) if (n) counters[DECISION_COUNTER[d]] = n;
      await automationRunsService.increment(runId, counters);
      await keepLease();

      // ---------------------------------------------------------------- 5. prepare (best matches first, capped; one per canonical job)
      toPrepare.sort((a, b) => b.score - a.score);
      const chosen = new Set<string>();
      let prepared = 0;
      for (const [i, p] of toPrepare.entries()) {
        if (i > 0 && i % LEASE_RENEW_EVERY_PREPARATIONS === 0) await keepLease();
        if (chosen.has(p.canonical)) {
          if (await skipDuplicateListing(userId, p.applicationId, runId)) newlyStrong.delete(p.applicationId);
          continue;
        }
        chosen.add(p.canonical);
        if (prepared >= env().AUTOMATION_MAX_PREPARE_PER_RUN) {
          await automationRunsService.item(runId, userId, { stage: "prepare", outcome: "DEFERRED", message: "Preparation limit for this run reached - it will be prepared in the next run.", applicationId: p.applicationId });
          continue;
        }
        try {
          if (await this.startPreparation(userId, p.applicationId, runId)) prepared++;
        } catch (e) {
          // Stuck PREPARING applications are re-queued by the stale-preparation recovery; others stay awaiting.
          logger.warn("automation.prepare_failed", { userId, runId, applicationId: p.applicationId, error: e instanceof Error ? e.name : "unknown" });
          await automationRunsService.item(runId, userId, { stage: "prepare", outcome: "ERROR", message: "The preparation could not be started. It is retried automatically.", applicationId: p.applicationId });
          await automationRunsService.increment(runId, { failures: 1 });
        }
      }

      // ---------------------------------------------------------------- 6. strong-match notification (new strong matches only)
      const strong = newlyStrong.size;
      if (strong && settings.notifyStrongMatches) {
        const auto = [...newlyStrong.values()].filter((d) => d === "AUTO_ELIGIBLE").length;
        await notificationService
          .notify(userId, {
            type: "automation.strong_match",
            title: `${strong} new strong match${strong === 1 ? "" : "es"} found`,
            body: `${auto} auto-eligible and ${strong - auto} for review in this run. ${settings.mode === "MANUAL" ? "Manual mode: nothing is submitted for you." : ""}`.trim(),
            link: `/automation/runs/${runId}`,
            dedupeKey: `strong:${runId}`,
          })
          .catch((e: unknown) => logger.warn("automation.notify_failed", { userId, runId, error: e instanceof Error ? e.name : "unknown" }));
      }

      // Recovery of earlier work: stale preparations, deferred and lost executions (never fails the run).
      await this.redriveUser(userId, now).catch((e: unknown) => logger.warn("automation.redrive_failed", { userId, runId, error: e instanceof Error ? e.name : "unknown" }));

      await closeRun(runId, "COMPLETED");
      await prisma.automationSettings.update({
        where: { userId },
        data: { lastRunAt: new Date(), ...(settings.enabled ? { nextRunAt: new Date(Date.now() + settings.searchFrequencyMinutes * 60_000) } : {}) },
      });
      await releaseLease(userId, runId);
      await audit(userId, "automation.run_completed", { entityType: "AutomationRun", entityId: runId, metadata: { trigger, jobs: jobs.length, prepared } });
      logger.info("automation.run_completed", { userId, runId, trigger, jobs: jobs.length, prepared });
      return runSummary(await prisma.automationRun.findUniqueOrThrow({ where: { id: runId } }));
    } catch (e) {
      if (e instanceof RunSupersededError) {
        // A newer run owns the lease and continues the work: close this one quietly, never touch its lease.
        await closeRun(runId, "FAILED", RUN_SUPERSEDED).catch(() => undefined);
        logger.warn("automation.run_superseded", { userId, runId });
        return null;
      }
      const message = e instanceof Error && e.name === "AppError" ? e.message : "The automation run failed. It will be retried at the next scheduled run.";
      await closeRun(runId, "FAILED", message).catch(() => undefined);
      await releaseLease(userId, runId).catch(() => undefined);
      await notificationService.notify(userId, { type: "automation.run_failed", title: "An automation run failed", body: message, link: `/automation/runs/${runId}`, dedupeKey: `run-failed:${dayKey(now, "UTC")}` }).catch(() => undefined);
      logger.error("automation.run_failed", { userId, runId, error: e instanceof Error ? e.name : "unknown" });
      return null;
    }
  },

  /**
   * Jobs to (re-)evaluate: the user's own jobs (never the shared demo catalogue) that are new, have no application
   * yet, or whose automation application is still in a pipeline state with an outdated decision. Newest first.
   */
  async candidateJobs(userId: string, rulesVersion: number, newJobIds: string[], now: Date): Promise<CandidateJob[]> {
    const limit = env().AUTOMATION_MAX_JOBS_PER_RUN;
    const baseWhere: Prisma.JobWhereInput = {
      ownerUserId: userId,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      NOT: { states: { some: { userId, ignored: true } } },
    };
    const fresh = await prisma.job.findMany({
      where: { ...baseWhere, applications: { none: { userId } } },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: jobSelect,
    });
    const stale = await prisma.job.findMany({
      where: {
        ...baseWhere,
        applications: {
          some: {
            userId,
            origin: "AUTOMATION",
            status: { in: EVALUABLE },
            preparedAt: null,
            OR: [{ rulesVersion: null }, { rulesVersion: { not: rulesVersion } }, { evaluatedAt: null }],
          },
        },
      },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: jobSelect,
    });
    // Jobs whose score changed since the last evaluation (profile facts or engine changed).
    const rescored = await prisma.job.findMany({
      where: {
        ...baseWhere,
        applications: { some: { userId, origin: "AUTOMATION", status: { in: EVALUABLE }, preparedAt: null } },
        matchScores: { some: { userId } },
      },
      select: { ...jobSelect, applications: { where: { userId }, select: { evaluatedAt: true } }, matchScores: { where: { userId }, select: { computedAt: true } } },
      take: limit,
    });
    const changed = rescored.filter((j) => {
      const evaluated = j.applications[0]?.evaluatedAt;
      const computed = j.matchScores[0]?.computedAt;
      return !evaluated || (computed && computed > evaluated);
    });
    // Worth applying but not prepared yet (e.g. the previous run hit its preparation cap): prepare them now.
    const awaiting = await prisma.job.findMany({
      where: {
        ...baseWhere,
        applications: { some: { userId, origin: "AUTOMATION", status: { in: ["MATCHED", "AUTO_ELIGIBLE"] }, automationDecision: { in: ["REVIEW", "AUTO_ELIGIBLE"] }, preparedAt: null } },
      },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: jobSelect,
    });
    const byId = new Map<string, CandidateJob>();
    const newFirst = new Set(newJobIds);
    for (const j of [...fresh.filter((x) => newFirst.has(x.id)), ...awaiting, ...fresh, ...stale, ...changed]) if (!byId.has(j.id)) byId.set(j.id, j);
    return [...byId.values()].slice(0, limit);
  },

  /**
   * Create/advance the job's automation application and record the rule decision. Returns null when the application
   * is not (or no longer) the orchestrator's to evaluate - including when the user, another run or an executor moved
   * it on concurrently (every write is a compare-and-set, so such a change is never overwritten).
   */
  async evaluateJob(
    userId: string,
    job: CandidateJob,
    report: JobMatchReport,
    ctx: { runId: string | null; config: ReturnType<typeof ruleConfig>; candidateYoe: number | null; mode: "MANUAL" | "REVIEW" | "AUTO"; rulesVersion: number; timezone: string; rescored: boolean; now: Date },
  ): Promise<JobEvaluationOutcome | null> {
    const canonical = canonicalJobKey(job);
    const ref = providerJobRef(job);
    const sourceProvider = sourceProviderIdForJob(ref);

    // One application per (user, job): create-or-find, safe against concurrent runs (unique constraint).
    let app = await prisma.application.findUnique({ where: { userId_jobId: { userId, jobId: job.id } }, select: { id: true, status: true, origin: true, automationDecision: true, rulesVersion: true, preparedAt: true } });
    if (!app) {
      try {
        const createdApp = await prisma.application.create({
          data: { userId, jobId: job.id, applyMethod: job.applyMethod, status: "DISCOVERED", origin: "AUTOMATION", mode: ctx.mode, canonicalJobKey: canonical, automationRunId: ctx.runId },
          select: { id: true, status: true, origin: true, automationDecision: true, rulesVersion: true, preparedAt: true },
        });
        await recordApplicationEvent(userId, createdApp.id, "discovered", `Discovered by the automation (${job.sources.length ? sourceProvider : "job source"}).`, { metadata: { runId: ctx.runId, provider: sourceProvider } });
        app = createdApp;
      } catch (e) {
        if ((e as { code?: string }).code !== "P2002") throw e;
        app = await prisma.application.findUnique({ where: { userId_jobId: { userId, jobId: job.id } }, select: { id: true, status: true, origin: true, automationDecision: true, rulesVersion: true, preparedAt: true } });
        if (!app) return null;
      }
    }
    // Never touch applications the user created or that already moved past the pipeline.
    if (app.origin !== "AUTOMATION" || !EVALUABLE.includes(app.status) || app.preparedAt) return null;

    try {
      if (app.status === "DISCOVERED") {
        if (ctx.rescored) {
          await transitionApplication(userId, app.id, "match_started", { actor: "system", message: "Computing the match score.", from: ["DISCOVERED"] }).catch((e: unknown) => {
            if (!movedOn(e)) throw e;
          });
        }
        await transitionApplication(userId, app.id, "match_completed", { actor: "system", message: `Match score ${report.estimatedMatchScore} (${report.scoreLabel}).`, metadata: { score: report.estimatedMatchScore, engineVersion: report.engineVersion }, from: ["DISCOVERED", "MATCHING"] });
      } else if (app.status === "MATCHING") {
        await transitionApplication(userId, app.id, "match_completed", { actor: "system", message: `Match score ${report.estimatedMatchScore} (${report.scoreLabel}).`, from: ["MATCHING"] });
      }
    } catch (e) {
      if (movedOn(e)) return null;
      throw e;
    }

    const alreadyApplied =
      (await prisma.application.count({ where: { userId, canonicalJobKey: canonical, id: { not: app.id }, status: { in: SENT_OR_SENDING } } })) > 0 ||
      (await prisma.applicationExecution.count({ where: { idempotencyKey: `${userId}:${canonical}`, status: "SUCCEEDED" } })) > 0;
    const applicationsToday = await dailyLimitService.countToday(userId, ctx.timezone, ctx.now);
    let evaluation: RuleEvaluation = evaluateAutomationRules(
      {
        title: job.title,
        company: job.company,
        platform: job.platform,
        providerId: sourceProvider,
        locations: job.locations,
        workMode: job.workMode,
        applyMethod: job.applyMethod,
        salaryMin: job.salaryMin,
        salaryMax: job.salaryMax,
        currency: job.currency,
        experienceMinYears: job.experienceMinYears,
        experienceMaxYears: job.experienceMaxYears,
        postedAt: job.postedAt?.toISOString() ?? null,
        foundAt: job.createdAt.toISOString(),
        descriptionLevel: job.descriptionLevel,
        requiredSkills: job.skillRequirements.filter((s) => s.required).map((s) => s.canonicalName),
        preferredSkills: job.skillRequirements.filter((s) => !s.required).map((s) => s.canonicalName),
      },
      {
        score: report.estimatedMatchScore,
        missingMandatorySkills: report.missingMandatoryRequirements.map((m) => m.canonicalName),
        locationFit: report.locationFit.fit,
      },
      ctx.config,
      { now: ctx.now, candidateYoe: ctx.candidateYoe, applicationsToday, alreadyApplied },
    );
    // One preparation per canonical job, across runs: another listing already prepared / in progress wins.
    if (isStrong(evaluation.decision) && (await siblingPreparedOrInProgress(userId, canonical, app.id))) evaluation = asDuplicateListing(evaluation);

    const target: ApplicationStatus = evaluation.decision === "IGNORE" ? "REJECTED_BY_RULES" : evaluation.decision === "AUTO_ELIGIBLE" ? "AUTO_ELIGIBLE" : "MATCHED";
    const current = await prisma.application.findUnique({ where: { id: app.id }, select: { status: true, automationDecision: true, preparedAt: true } });
    if (!current || current.preparedAt || !EVALUATED.includes(current.status)) return null;
    const data = {
      automationDecision: evaluation.decision,
      decisionReasons: evaluation.checks as unknown as Prisma.InputJsonValue,
      decisionScore: evaluation.score,
      rulesVersion: ctx.rulesVersion,
      // Wall-clock time of this evaluation (after any rescoring in this run), so the "score changed since the last
      // evaluation" check does not see every job as changed on the next run.
      evaluatedAt: new Date(),
      mode: ctx.mode,
      automationRunId: ctx.runId,
    };
    if (current.status === target && current.automationDecision === evaluation.decision) {
      // Same status and decision: refresh the evaluation, only if nothing changed since it was read.
      const res = await prisma.application.updateMany({ where: { id: app.id, userId, status: current.status, automationDecision: current.automationDecision, preparedAt: null }, data });
      if (res.count === 0) return null;
    } else {
      try {
        await transitionApplication(userId, app.id, "evaluate", {
          to: target,
          from: EVALUATED,
          actor: "system",
          message: `${decisionHeadline(evaluation.decision)}: ${evaluation.reasons.slice(0, 3).join("; ")}`.slice(0, 500),
          data,
          metadata: { runId: ctx.runId, decision: evaluation.decision, engineVersion: AUTOMATION_RULES_VERSION, deferredByDailyLimit: evaluation.deferredByDailyLimit },
        });
      } catch (e) {
        if (movedOn(e)) return null;
        throw e;
      }
    }
    await automationRunsService.item(ctx.runId, userId, {
      stage: "rules",
      outcome: evaluation.decision,
      message: `${job.title} at ${job.company} - score ${evaluation.score}: ${evaluation.reasons[0] ?? decisionHeadline(evaluation.decision)}`,
      jobId: job.id,
      applicationId: app.id,
    });
    const strong = isStrong(evaluation.decision);
    return { applicationId: app.id, decision: evaluation.decision, prepare: strong, newlyStrong: strong && !isStrong(current.automationDecision) };
  },

  /** MATCHED / AUTO_ELIGIBLE -> PREPARING and queue the preparation task (drafts, answers, routing). */
  async startPreparation(userId: string, applicationId: string, runId: string | null): Promise<boolean> {
    try {
      await transitionApplication(userId, applicationId, "prepare", {
        actor: "system",
        message: "Preparing the application from your verified profile.",
        data: { preparationError: null, automationRunId: runId },
        from: ["MATCHED", "AUTO_ELIGIBLE", "DISCOVERED"],
      });
    } catch (e) {
      logger.warn("automation.prepare_skipped", { applicationId, error: e instanceof Error ? e.name : "unknown" });
      return false;
    }
    await enqueue("application.prepare", { applicationId }, { userId, dedupeKey: `application.prepare:${applicationId}` });
    return true;
  },

  /** Re-evaluate and route a single application (application.evaluate task). */
  async resumeApplication(userId: string, applicationId: string): Promise<void> {
    const app = await prisma.application.findFirst({ where: { id: applicationId, userId }, select: { status: true, jobId: true, origin: true } });
    if (!app) return;
    if (app.status === "NEEDS_INFORMATION") {
      await transitionApplication(userId, applicationId, "information_provided", { actor: "system", message: "Resuming preparation." });
      await enqueue("application.prepare", { applicationId }, { userId, dedupeKey: `application.prepare:${applicationId}` });
      return;
    }
    if (app.origin !== "AUTOMATION" || !EVALUABLE.includes(app.status)) return;
    const { settings, rule } = await automationSettingsService.ensure(userId);
    const job = await prisma.job.findFirst({ where: { id: app.jobId, ownerUserId: userId }, select: jobSelect });
    const profile = await prisma.candidateProfile.findUnique({ where: { userId }, select: { yoe: true } });
    if (!job) return;
    await recomputeMatchScores(prisma, userId, [job.id]);
    const score = await prisma.jobMatchScore.findUnique({ where: { userId_jobId: { userId, jobId: job.id } }, select: { report: true } });
    if (!score) return;
    const outcome = await this.evaluateJob(userId, job, score.report as unknown as JobMatchReport, {
      runId: null,
      config: ruleConfig(settings, rule),
      candidateYoe: profile?.yoe ?? null,
      mode: settings.mode,
      rulesVersion: settings.rulesVersion,
      timezone: settings.timezone,
      rescored: false,
      now: new Date(),
    });
    if (outcome?.prepare) await this.startPreparation(userId, applicationId, null);
  },

  /**
   * Deferred executions (quiet hours, daily limit) whose time has come, for every user, plus executions whose task was
   * lost. Each deferral is re-queued once (compare-and-set on nextActionAt) under its own queue key, so it can never
   * absorb a later task for the same application (e.g. the user's "Retry").
   */
  async redriveDeferred(now = new Date()): Promise<number> {
    const due = await prisma.application.findMany({
      where: { status: "APPROVED", mode: { in: ["REVIEW", "AUTO"] }, nextActionAt: { lte: now } },
      select: { id: true, userId: true },
      take: 100,
    });
    let queued = 0;
    for (const a of due) if (await redriveOne(a.id, a.userId, now)) queued++;
    return queued + (await this.sweepLostExecutions(now));
  },

  /**
   * APPROVED Review/Auto applications with no deferral, no running or successful execution and no change for 15
   * minutes: the execute task was lost (process restart with the memory driver, a failed queue write after the
   * approval committed). Each is claimed by touching updatedAt (compare-and-set), so it is re-driven at most once per
   * 15 minutes; a duplicate task is harmless (execute() claims the canonical job and compare-and-sets APPROVED ->
   * APPLYING). Policy approvals are only re-driven while the policy still allows submitting, and an application
   * execute() recently reported as blocked is not a lost task.
   */
  async sweepLostExecutions(now = new Date(), userId?: string): Promise<number> {
    const lost = await prisma.application.findMany({
      where: {
        ...(userId ? { userId } : {}),
        status: "APPROVED",
        mode: { in: ["REVIEW", "AUTO"] },
        nextActionAt: null,
        updatedAt: { lt: new Date(now.getTime() - LOST_EXECUTE_MS) },
        executions: { none: { status: { in: ["RUNNING", "SUCCEEDED"] } } },
        events: { none: { type: "execution_blocked", createdAt: { gte: new Date(now.getTime() - BLOCKED_REDRIVE_BACKOFF_MS) } } },
        // Policy approvals whose policy no longer allows submitting are swept too: execute() hands them back to the
        // user (WAITING_APPROVAL + notification) instead of leaving them "queued" forever.
      },
      select: { id: true, userId: true, updatedAt: true },
      orderBy: { updatedAt: "asc" },
      take: userId ? 20 : 100,
    });
    const bucket = Math.floor(now.getTime() / LOST_EXECUTE_MS);
    let queued = 0;
    for (const a of lost) {
      const claim = await prisma.application.updateMany({ where: { id: a.id, status: "APPROVED", nextActionAt: null, updatedAt: a.updatedAt }, data: { updatedAt: now } });
      if (claim.count !== 1) continue;
      await enqueue("application.execute", { applicationId: a.id }, { userId: a.userId, dedupeKey: executeDedupeKey(a.id, `sweep:${bucket}`) });
      logger.info("automation.lost_execution_requeued", { userId: a.userId, applicationId: a.id });
      queued++;
    }
    return queued;
  },

  /** Per-user recovery at the end of a run: re-queue preparations whose worker died, deferred and lost executions. */
  async redriveUser(userId: string, now: Date): Promise<void> {
    const stuck = await prisma.application.findMany({
      where: { userId, status: "PREPARING", updatedAt: { lt: new Date(now.getTime() - STALE_PREPARING_MS) } },
      select: { id: true },
      take: 20,
    });
    for (const a of stuck) await enqueue("application.prepare", { applicationId: a.id }, { userId, dedupeKey: `application.prepare:${a.id}` });
    const deferred = await prisma.application.findMany({ where: { userId, status: "APPROVED", mode: { in: ["REVIEW", "AUTO"] }, nextActionAt: { lte: now } }, select: { id: true }, take: 50 });
    for (const a of deferred) await redriveOne(a.id, userId, now);
    await this.sweepLostExecutions(now, userId);
  },

  /**
   * Queue daily summaries for users whose local summary hour has come (once per local day). Pages through every
   * enabled user (keyset on userId), so no user is left out however many there are.
   */
  async dailySummaryTick(now = new Date()): Promise<number> {
    let queued = 0;
    let after: string | null = null;
    for (;;) {
      const users: { userId: string; dailySummaryHour: number | null; timezone: string; lastDailySummaryDay: string | null }[] = await prisma.automationSettings.findMany({
        where: { enabled: true, dailySummaryHour: { not: null }, ...(after ? { userId: { gt: after } } : {}) },
        select: { userId: true, dailySummaryHour: true, timezone: true, lastDailySummaryDay: true },
        orderBy: { userId: "asc" },
        take: SUMMARY_PAGE_SIZE,
      });
      for (const u of users) {
        const day = dayKey(now, u.timezone);
        // Already sent today, or the summary hour has not come yet.
        if (u.lastDailySummaryDay === day || localHour(now, u.timezone) < (u.dailySummaryHour ?? 24)) continue;
        const claim = await prisma.automationSettings.updateMany({ where: { userId: u.userId, OR: [{ lastDailySummaryDay: null }, { lastDailySummaryDay: { not: day } }] }, data: { lastDailySummaryDay: day } });
        if (claim.count !== 1) continue;
        await enqueue("summary.daily", {}, { userId: u.userId, dedupeKey: `summary.daily:${u.userId}:${day}` });
        queued++;
      }
      if (users.length < SUMMARY_PAGE_SIZE) break;
      after = users[users.length - 1]!.userId;
    }
    return queued;
  },

  /** One notification with today's numbers (idempotent per local day). */
  async dailySummary(userId: string, now = new Date()): Promise<void> {
    const { settings } = await automationSettingsService.ensure(userId);
    const day = dayKey(now, settings.timezone);
    const since = new Date(now.getTime() - 24 * 60 * 60_000);
    const [discovered, strong, applied, attention, interviews] = await Promise.all([
      prisma.job.count({ where: { ownerUserId: userId, createdAt: { gte: since } } }),
      prisma.application.count({ where: { userId, automationDecision: { in: ["REVIEW", "AUTO_ELIGIBLE"] }, evaluatedAt: { gte: since } } }),
      dailyLimitService.countToday(userId, settings.timezone, now),
      prisma.application.count({ where: { userId, status: { in: ["WAITING_APPROVAL", "NEEDS_INFORMATION", "MANUAL_ACTION_REQUIRED", "FAILED"] } } }),
      prisma.application.count({ where: { userId, status: { in: ["INTERVIEW", "ASSESSMENT"] }, updatedAt: { gte: since } } }),
    ]);
    await notificationService.notify(userId, {
      type: "automation.daily_summary",
      title: `Today: ${applied} application${applied === 1 ? "" : "s"} sent, ${strong} strong match${strong === 1 ? "" : "es"}`,
      body: `${discovered} jobs discovered in the last 24 hours. ${attention} application${attention === 1 ? " needs" : "s need"} your attention.${interviews ? ` ${interviews} interview/assessment update${interviews === 1 ? "" : "s"}.` : ""} Daily limit: ${applied}/${effectiveDailyLimit(settings)}.`,
      link: "/dashboard",
      dedupeKey: `summary:${day}`,
      respectQuietHours: false,
    });
  },
};

/**
 * Re-queue one deferred execution whose time has come. The compare-and-set on nextActionAt makes the scheduler's
 * global pass and a run's per-user pass queue it once between them; the suffixed key never collapses with a later
 * task for the application (a user's retry uses its own key).
 */
async function redriveOne(applicationId: string, userId: string, now: Date): Promise<boolean> {
  const claim = await prisma.application.updateMany({ where: { id: applicationId, status: "APPROVED", nextActionAt: { lte: now } }, data: { nextActionAt: null } });
  if (claim.count !== 1) return false;
  await enqueue("application.execute", { applicationId }, { userId, dedupeKey: executeDedupeKey(applicationId, `redrive:${now.getTime()}`) });
  return true;
}

function decisionHeadline(d: AutomationDecision): string {
  switch (d) {
    case "IGNORE":
      return "Filtered out by your rules";
    case "RECOMMEND":
      return "Recommended";
    case "REVIEW":
      return "Worth applying - needs your review";
    case "AUTO_ELIGIBLE":
      return "Auto-eligible";
  }
}
