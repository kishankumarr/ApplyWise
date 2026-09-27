import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@applywise/database";
import { DEMO_SINGAPORE_PERMIT_QUESTION, DEMO_WORK_AUTH_QUESTION } from "@applywise/job-engine";
import type { PendingQuestion } from "@applywise/types";
import { provideInformation } from "@/server/services/application-routing.service";
import { applicationService } from "@/server/services/application.service";
import { automationOrchestrator } from "@/server/services/automation-orchestrator.service";
import { automationRunsService } from "@/server/services/automation-runs.service";
import { consentService } from "@/server/services/consent.service";
import { dashboardService } from "@/server/services/dashboard.service";
import { reviewQueueService } from "@/server/services/review-queue.service";
import { disableTrackedUsers, enableAutomation, onboardedUser, scopeGlobalQueriesToTrackedUsers } from "./automation-helpers";

/**
 * End-to-end acceptance of the automation pipeline (service level, real pipeline, inline queue, no AI, no network):
 *
 *   resume upload -> profile -> preferences -> automation enabled -> scheduler tick -> demo provider sync (100+ jobs)
 *   -> duplicates merged -> deterministic match -> rules (ignore / review / auto-eligible) -> resume selection ->
 *   preparation -> verified answers -> truth validation -> executor -> APPLIED -> events -> run metrics -> dashboard;
 *   then: unknown required question -> NEEDS_INFORMATION -> answered -> APPLIED, and unsupported provider ->
 *   MANUAL_ACTION_REQUIRED with a handoff. Only the remote side (the demo provider) is simulated.
 *
 * Isolation: the users come from the shared automation helpers (tracked), the scheduler tick only sees this file's
 * users (the unit database is shared with other files and runs), and every user's automation is switched off after
 * the file so no later scheduler tick elsewhere picks them up.
 */

const SLOW = 240_000;

afterAll(disableTrackedUsers);

async function appsByScenario(userId: string) {
  const apps = await prisma.application.findMany({
    where: { userId },
    include: { job: { include: { sources: { orderBy: { createdAt: "asc" }, take: 1, select: { metadata: true } } } } },
  });
  return apps.map((a) => ({ ...a, scenario: (a.job.sources[0]?.metadata as { demoScenario?: string } | null)?.demoScenario ?? null }));
}

describe("automation acceptance (AUTO mode)", () => {
  let userId: string;
  let runId: string;

  beforeAll(async () => {
    userId = await onboardedUser("auto");
    await enableAutomation(userId, "AUTO");
  }, SLOW);

  it("the scheduler discovers, matches, routes, prepares and submits", async () => {
    // Only this file's users are visible to the scheduler's cross-user queries during the tick.
    const unscope = scopeGlobalQueriesToTrackedUsers();
    try {
      const tick = await automationOrchestrator.tick(new Date());
      expect(tick.queued).toBe(1);
    } finally {
      unscope();
    }
    const run = await prisma.automationRun.findFirstOrThrow({ where: { userId, trigger: "schedule" }, orderBy: { startedAt: "desc" } });
    runId = run.id;
    expect(run.trigger).toBe("schedule");
    expect(run.status).toBe("COMPLETED");

    // Discovery: 100+ demo jobs, cross-provider duplicates merged into one job each.
    expect(run.jobsFound).toBeGreaterThanOrEqual(120);
    expect(run.newJobs).toBeGreaterThanOrEqual(100);
    expect(run.duplicates).toBeGreaterThanOrEqual(12);
    const jobs = await prisma.job.count({ where: { ownerUserId: userId } });
    const sources = await prisma.jobSource.count({ where: { job: { ownerUserId: userId } } });
    expect(jobs).toBe(run.newJobs);
    expect(sources).toBeGreaterThan(jobs);

    // Matching + rules.
    expect(run.jobsMatched).toBeGreaterThanOrEqual(100);
    expect(run.ignored).toBeGreaterThan(0);
    expect(run.reviewRequired).toBeGreaterThan(0);
    expect(run.autoEligible).toBeGreaterThanOrEqual(15);
    expect(run.applicationsPrepared).toBeGreaterThan(0);
    expect(run.applicationsSubmitted).toBeGreaterThanOrEqual(5);
    expect(run.needsInformation).toBeGreaterThanOrEqual(1);
    expect(run.manualActions).toBeGreaterThanOrEqual(1);
  }, SLOW);

  it("ignores low matches, sends medium matches to review and applies to high matches", async () => {
    const apps = await appsByScenario(userId);
    const ignored = apps.filter((a) => a.status === "REJECTED_BY_RULES");
    expect(ignored.length).toBeGreaterThan(0);
    expect(ignored.every((a) => a.automationDecision === "IGNORE")).toBe(true);

    const review = apps.filter((a) => a.status === "WAITING_APPROVAL");
    expect(review.length).toBeGreaterThan(0);
    expect(review.every((a) => a.automationDecision === "REVIEW" || a.automationDecision === "AUTO_ELIGIBLE")).toBe(true);

    const applied = apps.filter((a) => a.appliedAt && a.scenario === "auto_success");
    expect(applied.length).toBeGreaterThanOrEqual(3);
    const app = applied[0]!;
    expect(app.automationDecision).toBe("AUTO_ELIGIBLE");
    expect(app.approvalSource).toBe("policy");
    expect(app.executorId).toBe("api:demo");
    expect(app.externalApplicationId).toMatch(/^demo-app-/);
    // Resume selected with a reason.
    expect(app.selectedResumeVersionId).not.toBeNull();
    expect(app.resumeSelectionReason).toMatch(/verified evidence/);
    // Known questions answered from verified data only.
    const drafts = await prisma.screeningAnswerDraft.findMany({ where: { applicationId: app.id } });
    const workAuth = drafts.find((d) => d.question === DEMO_WORK_AUTH_QUESTION);
    expect(workAuth).toMatchObject({ answer: "Yes", resolved: true, answerSource: "CANDIDATE_ANSWER" });
    expect(drafts.find((d) => /notice period/i.test(d.question))).toMatchObject({ resolved: true, answerSource: "PREFERENCE" });
    // One successful execution, and the full event history.
    const executions = await prisma.applicationExecution.findMany({ where: { applicationId: app.id } });
    expect(executions).toHaveLength(1);
    expect(executions[0]!.status).toBe("SUCCEEDED");
    expect(executions[0]!.confirmation).toMatch(/^DEMO-/);
    const events = await prisma.applicationEvent.findMany({ where: { applicationId: app.id }, orderBy: { createdAt: "asc" } });
    const types = events.map((e) => e.type);
    for (const t of ["discovered", "match_completed", "evaluate", "prepare", "prepared", "policy_approve", "execute_started", "execute_succeeded"]) expect(types).toContain(t);
    expect(events.find((e) => e.type === "execute_succeeded")).toMatchObject({ fromStatus: "APPLYING", toStatus: "APPLIED", actor: "executor" });
    expect(events.find((e) => e.type === "policy_approve")).toMatchObject({ toStatus: "APPROVED", actor: "policy" });
  });

  it("records run metrics and run items, and updates the dashboard", async () => {
    const detail = await automationRunsService.get(userId, runId);
    expect(detail.providers.some((p) => p.providerId === "demo" && p.fetched >= 120)).toBe(true);
    // The timeline is paged (oldest first, stable order) with per-stage / per-outcome counts for the filters.
    const first = await automationRunsService.items(userId, runId, { pageSize: 25 });
    expect(first).toMatchObject({ page: 1, pageSize: 25 });
    expect(first.items).toHaveLength(25);
    expect(first.total).toBe(first.runTotal);
    expect(first.runTotal).toBeGreaterThan(50);
    expect(Object.values(first.stages).reduce((n, c) => n + c, 0)).toBe(first.runTotal);
    expect(first.outcomes.AUTO_ELIGIBLE).toBeGreaterThan(0);
    const second = await automationRunsService.items(userId, runId, { page: 2, pageSize: 25 });
    expect(second.items.map((i) => i.id).some((id) => first.items.some((i) => i.id === id))).toBe(false);
    expect(first.items.at(-1)!.createdAt <= second.items[0]!.createdAt).toBe(true);
    const autoEligible = await automationRunsService.items(userId, runId, { stage: "rules", outcome: "AUTO_ELIGIBLE" });
    expect(autoEligible.total).toBeGreaterThan(0);
    expect(autoEligible.items.every((i) => i.stage === "rules" && i.outcome === "AUTO_ELIGIBLE" && i.job !== null)).toBe(true);
    expect(autoEligible.stages.rules).toBe(autoEligible.total);
    expect(autoEligible.outcomes.AUTO_ELIGIBLE).toBe(autoEligible.total);
    expect(autoEligible.runTotal).toBe(first.runTotal);
    const { job } = autoEligible.items[0]!;
    const searched = await automationRunsService.items(userId, runId, { q: `${job!.title} at ${job!.company}`.toUpperCase() });
    expect(searched.items.some((i) => i.id === autoEligible.items[0]!.id)).toBe(true);
    // Another user's run is not found.
    await expect(automationRunsService.items("someone-else", runId)).rejects.toMatchObject({ status: 404 });
    const summary = await dashboardService.summary(userId);
    expect(summary.jobsDiscoveredToday).toBeGreaterThanOrEqual(100);
    expect(summary.strongMatches).toBeGreaterThan(0);
    expect(summary.applicationsToday).toBeGreaterThanOrEqual(5);
    expect(summary.applicationsToday).toBeLessThanOrEqual(30);
    expect(summary.waitingApproval).toBeGreaterThan(0);
    expect(summary.needsInformation).toBeGreaterThan(0);
    expect(summary.manualActionRequired).toBeGreaterThan(0);
    expect(summary.automation).toMatchObject({ enabled: true, mode: "AUTO", dailyLimit: 30 });
    const counter = await prisma.dailyApplicationCounter.findMany({ where: { userId } });
    expect(counter.reduce((n, c) => n + c.count, 0)).toBeLessThanOrEqual(30);
  });

  it("an unknown required question stops at NEEDS_INFORMATION, and resumes to APPLIED once answered", async () => {
    const apps = await appsByScenario(userId);
    const app = apps.find((a) => a.scenario === "unknown_question" && a.status === "NEEDS_INFORMATION");
    expect(app).toBeDefined();
    const pending = app!.pendingQuestions as unknown as PendingQuestion[];
    const q = pending.find((p) => p.question === DEMO_SINGAPORE_PERMIT_QUESTION);
    expect(q).toBeDefined();
    // Never invented: no draft claims an answer to it.
    const draft = await prisma.screeningAnswerDraft.findFirst({ where: { applicationId: app!.id, question: DEMO_SINGAPORE_PERMIT_QUESTION } });
    expect(draft).toMatchObject({ resolved: false, answer: "" });
    expect(await prisma.notification.count({ where: { userId, type: "application.information_required" } })).toBeGreaterThanOrEqual(1);

    await provideInformation(userId, app!.id, [{ key: q!.key, question: q!.question, answer: "No", remember: true }]);
    const after = await prisma.application.findUniqueOrThrow({ where: { id: app!.id } });
    expect(after.status).toBe("APPLIED");
    // Saved for reuse by later applications.
    expect(await prisma.candidateAnswer.count({ where: { userId, questionKey: q!.key } })).toBe(1);
  }, SLOW);

  it("an unsupported provider ends in MANUAL_ACTION_REQUIRED with a complete handoff", async () => {
    const apps = await appsByScenario(userId);
    const app = apps.find((a) => a.scenario === "manual_only" && a.status === "MANUAL_ACTION_REQUIRED");
    expect(app).toBeDefined();
    expect(app!.manualActionReason).toBe("PROVIDER_RESTRICTION");
    expect(await prisma.applicationExecution.count({ where: { applicationId: app!.id, status: "SUCCEEDED" } })).toBe(0);
    const handoff = await applicationService.handoff(userId, app!.id);
    expect(handoff.reason).toBe("PROVIDER_RESTRICTION");
    expect(handoff.reasonLabel).toBeTruthy();
    expect(handoff.job.applyUrl).toMatch(/^https:\/\//);
    expect(handoff.coverLetter?.length).toBeGreaterThan(50);
    expect(handoff.screeningAnswers.some((a) => a.question === DEMO_WORK_AUTH_QUESTION && a.answer === "Yes")).toBe(true);
    expect(handoff.match.score).toBeGreaterThanOrEqual(90);
    // CAPTCHA / login / MFA are never bypassed.
    const challenged = apps.filter((a) => ["login_required", "mfa"].includes(a.scenario ?? "") && a.status === "MANUAL_ACTION_REQUIRED");
    expect(new Set(challenged.map((a) => a.manualActionReason))).toEqual(new Set(["LOGIN_REQUIRED", "MFA"]));
  });

  it("is idempotent: a second run creates nothing and submits nothing twice", async () => {
    const before = {
      apps: await prisma.application.count({ where: { userId } }),
      jobs: await prisma.job.count({ where: { ownerUserId: userId } }),
      succeeded: await prisma.applicationExecution.count({ where: { userId, status: "SUCCEEDED" } }),
      counter: (await prisma.dailyApplicationCounter.findMany({ where: { userId } })).reduce((n, c) => n + c.count, 0),
    };
    const run = await automationOrchestrator.runNow(userId, "manual");
    const done = await prisma.automationRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(done.status).toBe("COMPLETED");
    expect(done.newJobs).toBe(0);
    expect(done.applicationsSubmitted).toBe(0);
    expect(await prisma.application.count({ where: { userId } })).toBe(before.apps);
    expect(await prisma.job.count({ where: { ownerUserId: userId } })).toBe(before.jobs);
    expect(await prisma.applicationExecution.count({ where: { userId, status: "SUCCEEDED" } })).toBe(before.succeeded);
    // One submission per canonical job, ever.
    const keys = await prisma.applicationExecution.groupBy({ by: ["idempotencyKey"], where: { userId }, _count: true });
    expect(keys.every((k) => k._count === 1)).toBe(true);
  }, SLOW);

  it("allows only one run per user at a time", async () => {
    const results = await Promise.allSettled([automationOrchestrator.runNow(userId, "manual"), automationOrchestrator.runNow(userId, "manual")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
    expect(rejected?.reason).toMatchObject({ status: 409 });
  }, SLOW);

  it("review queue: approve & apply submits, decline withdraws", async () => {
    const queue = await reviewQueueService.page(userId, { pageSize: 50 });
    expect(queue.total).toBe(queue.items.length);
    const waiting = queue.items.filter((i) => i.status === "WAITING_APPROVAL");
    expect(waiting.length).toBeGreaterThanOrEqual(2);
    expect(waiting[0]!.match.factors.length).toBeGreaterThan(0);
    expect(waiting[0]!.resume.label).toBeTruthy();
    const [toApply, toDecline] = waiting;
    const applied = await applicationService.applyNow(userId, toApply!.applicationId, {});
    expect(["APPLIED", "MANUAL_ACTION_REQUIRED", "NEEDS_INFORMATION", "FAILED"]).toContain(applied.status);
    const row = await prisma.application.findUniqueOrThrow({ where: { id: toApply!.applicationId } });
    expect(row.approvalSource).toBe("user");
    const declined = await applicationService.decline(userId, toDecline!.applicationId, "Not interested");
    expect(declined.status).toBe("WITHDRAWN");
  }, SLOW);
});

describe("application modes", () => {
  it("MANUAL mode prepares but never submits", async () => {
    const userId = await onboardedUser("manual");
    await enableAutomation(userId, "MANUAL");
    const run = await automationOrchestrator.runForUser(userId, "manual");
    expect(run?.status).toBe("COMPLETED");
    const apps = await prisma.application.findMany({ where: { userId } });
    expect(apps.some((a) => a.status === "READY_FOR_REVIEW")).toBe(true);
    expect(apps.some((a) => ["APPROVED", "APPLYING", "APPLIED", "WAITING_APPROVAL"].includes(a.status))).toBe(false);
    expect(await prisma.applicationExecution.count({ where: { userId } })).toBe(0);
  }, SLOW);

  it("REVIEW mode waits for approval before any submission", async () => {
    const userId = await onboardedUser("review");
    await enableAutomation(userId, "REVIEW");
    await automationOrchestrator.runForUser(userId, "manual");
    const apps = await appsByScenario(userId);
    expect(apps.some((a) => a.status === "APPLIED" || a.status === "APPLYING")).toBe(false);
    expect(await prisma.applicationExecution.count({ where: { userId } })).toBe(0);
    const waiting = apps.find((a) => a.status === "WAITING_APPROVAL" && a.scenario === "auto_success");
    expect(waiting).toBeDefined();
    // The user approves: now the executor runs.
    const after = await applicationService.applyNow(userId, waiting!.id, {});
    expect(after.status).toBe("APPLIED");
  }, SLOW);

  it("AUTO without the auto-apply consent does not submit", async () => {
    const userId = await onboardedUser("noconsent");
    await enableAutomation(userId, "AUTO");
    await consentService.update(userId, { autoApply: false });
    await automationOrchestrator.runForUser(userId, "manual");
    expect(await prisma.applicationExecution.count({ where: { userId, status: "SUCCEEDED" } })).toBe(0);
    const apps = await prisma.application.findMany({ where: { userId, automationDecision: "AUTO_ELIGIBLE" } });
    expect(apps.length).toBeGreaterThan(0);
    expect(apps.some((a) => a.status === "APPLIED")).toBe(false);
    expect(apps.some((a) => a.status === "WAITING_APPROVAL")).toBe(true);
  }, SLOW);
});
