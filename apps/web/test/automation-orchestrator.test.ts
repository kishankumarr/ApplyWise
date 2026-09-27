import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, type Prisma } from "@applywise/database";
import type { RuleCheck } from "@applywise/types";
import { env } from "@/env";
import { enqueue, type TaskName } from "@/server/queue";
import type * as Queue from "@/server/queue";
import { automationOrchestrator } from "@/server/services/automation-orchestrator.service";
import { automationSettingsService } from "@/server/services/automation-settings.service";
import { dailyLimitService } from "@/server/services/daily-limit.service";
import { jobFeedsService, type FeedSyncResult } from "@/server/services/job-feeds.service";
import { appsByDemoKey, bareUser, disableTrackedUsers, enableAutomation, fabricateApp, importDemoJobs, onboardedUser, scopeGlobalQueriesToTrackedUsers, track } from "./automation-helpers";

/**
 * AutomationOrchestrator beyond the acceptance flow: scheduler claims under concurrency, disabled users, idempotent
 * run ids, the run lease (owned, renewed, released only by its run; interrupted runs reaped), re-evaluation after rule
 * changes, the per-run preparation cap, one preparation per canonical job, per-job error isolation, recovery of
 * deferred / stuck / lost work and the daily summary. The queue is the real inline driver; tests that only need to
 * observe WHAT gets queued switch to capture mode (the task is recorded, not run).
 */

type Captured = { name: TaskName; payload: Record<string, unknown>; opts: { userId: string | null; runAt?: Date; dedupeKey?: string } };
const h = vi.hoisted(() => ({ capture: false, calls: [] as Captured[], fail: new Set<string>() }));

vi.mock("@/server/queue", async (importOriginal) => {
  const actual = await importOriginal<typeof Queue>();
  return {
    ...actual,
    enqueue: async (...args: Parameters<typeof actual.enqueue>) => {
      const [name, payload, opts] = args;
      if (h.fail.has(name)) throw new Error("queue unavailable");
      if (!h.capture) return actual.enqueue(...args);
      h.calls.push({ name, payload, opts: opts ?? { userId: null } });
      return { taskId: "captured" };
    },
  };
});

const SLOW = 180_000;
const past = (ms = 60_000) => new Date(Date.now() - ms);
const FAR_FUTURE = new Date("2099-01-01T00:00:00Z");

/** Demo catalogue jobs (DEMO CONTENT) that score >= 95 for the onboarded demo candidate and submit successfully. */
const HIGH = ["aw-flowkit-automation-builder", "aw-sceneforge-scene-editor", "aw-uploadly-media-uploads", "aw-fanfolio-creator-dashboard", "aw-captionly-subtitle-editor", "aw-critiq-design-review"];
/** Low matches (score 19-48) filtered out by the match score only. */
const LOW = ["aw-kredito-java-backend", "aw-rapidpay-golang", "aw-pebblemark-product-designer"];

const captured = (name: TaskName, userId?: string) => h.calls.filter((c) => c.name === name && (userId === undefined || c.opts.userId === userId));
const settingsOf = (userId: string) => prisma.automationSettings.findUniqueOrThrow({ where: { userId } });

/** A user with a minimal profile and automation settings written directly (REVIEW mode, UTC, due now). */
async function schedulerUser(tag: string, s: Omit<Prisma.AutomationSettingsUncheckedCreateInput, "userId"> = {}): Promise<string> {
  const userId = await bareUser(tag, { profile: true });
  await prisma.automationSettings.create({ data: { userId, enabled: true, mode: "REVIEW", timezone: "UTC", nextRunAt: past(), ...s } });
  return userId;
}

/**
 * Make the next `parties` scheduler reads of AutomationSettings return only once all of them have read, so
 * overlapping ticks really observe the same due users before either claims (otherwise the connection pool may
 * serialise them and hide a non-atomic claim).
 */
function overlapNextSettingsReads(parties = 2) {
  const spy = vi.mocked(prisma.automationSettings.findMany);
  const read = spy.getMockImplementation()!;
  let arrived = 0;
  let release!: () => void;
  const allRead = new Promise<void>((r) => (release = r));
  const held = (async (...args: Parameters<typeof read>) => {
    const rows = await read(...args);
    if (++arrived === parties) release();
    await allRead;
    return rows;
  }) as unknown as typeof read;
  for (let i = 0; i < parties; i++) spy.mockImplementationOnce(held);
}

function withPrepareCap(cap: number) {
  let previous: number;
  beforeAll(() => {
    previous = env().AUTOMATION_MAX_PREPARE_PER_RUN;
    env().AUTOMATION_MAX_PREPARE_PER_RUN = cap;
  });
  afterAll(() => {
    env().AUTOMATION_MAX_PREPARE_PER_RUN = previous;
  });
}

let unscope: () => void;
beforeAll(() => {
  unscope = scopeGlobalQueriesToTrackedUsers();
});
afterAll(async () => {
  await disableTrackedUsers();
  unscope();
});
beforeEach(() => {
  h.capture = false;
  h.calls.length = 0;
  h.fail.clear();
});

/** A company-board source that is due, so a run syncs it (the sync itself is replaced in the lease tests). */
async function dueBoardFeed(userId: string) {
  return prisma.jobFeed.create({
    data: { userId, kind: "COMPANY_BOARD", provider: "greenhouse", label: "Lease test board", config: { slug: "lease-test", companyName: "Lease Test", boardUrl: "https://boards.greenhouse.io/lease-test", onlyRelevant: false }, intervalMinutes: 720, nextSyncAt: past() },
  });
}

const emptySync = (feedId: string): FeedSyncResult => ({ feedId, provider: "greenhouse", label: "Lease test board", fetched: 0, created: 0, merged: 0, skipped: 0, newJobIds: [], error: null });

/** A second Job row for the same canonical job (same match key): a repost or a racing import of the same listing. */
async function copyJob(jobId: string): Promise<string> {
  const { id: _id, createdAt: _c, updatedAt: _u, dedupeKey, feedId: _f, otherRequirements, skillRequirements, requirements, sources, ...rest } = await prisma.job.findUniqueOrThrow({
    where: { id: jobId },
    include: { skillRequirements: true, requirements: true, sources: true },
  });
  const copy = await prisma.job.create({
    data: {
      ...rest,
      otherRequirements: otherRequirements as Prisma.InputJsonValue,
      dedupeKey: `${dedupeKey}-copy-${Math.random().toString(36).slice(2, 8)}`,
      skillRequirements: { create: skillRequirements.map(({ id: _i, jobId: _j, ...s }) => s) },
      requirements: { create: requirements.map(({ id: _i, jobId: _j, ...r }) => r) },
      sources: { create: sources.map(({ id: _i, jobId: _j, createdAt: _sc, metadata, ...s }) => ({ ...s, metadata: metadata as Prisma.InputJsonValue })) },
    },
  });
  return copy.id;
}

describe("scheduler tick", () => {
  it("claims a due user only once when two ticks run concurrently, and never while its run holds the lease", async () => {
    const userId = await schedulerUser("tick");
    h.capture = true;
    const now = new Date();
    overlapNextSettingsReads(2);
    const [a, b] = await Promise.all([automationOrchestrator.tick(now), automationOrchestrator.tick(now)]);
    expect(a.queued + b.queued).toBe(1);

    const runs = await prisma.automationRun.findMany({ where: { userId } });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ trigger: "schedule", status: "RUNNING", mode: "REVIEW" });
    const tasks = captured("automation.run", userId);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.payload).toEqual({ runId: runs[0]!.id, trigger: "schedule" });
    expect(tasks[0]!.opts.dedupeKey).toBe(`automation.run:${runs[0]!.id}`);
    const claimed = await settingsOf(userId);
    expect(claimed.runLeaseUntil!.getTime()).toBeGreaterThan(now.getTime());
    // The lease belongs to the run it was claimed for.
    expect(claimed.runLeaseRunId).toBe(runs[0]!.id);
    expect(claimed.nextRunAt!.getTime()).toBe(now.getTime() + claimed.searchFrequencyMinutes * 60_000);

    // Due again (e.g. new jobs arrived) but the queued run still holds the lease: nothing is claimed.
    await prisma.automationSettings.update({ where: { userId }, data: { nextRunAt: past() } });
    expect((await automationOrchestrator.tick(new Date())).queued).toBe(0);
    expect(await prisma.automationRun.count({ where: { userId } })).toBe(1);

    // The queued task runs the pipeline once and releases the lease.
    h.capture = false;
    const done = await automationOrchestrator.runForUser(userId, "schedule", { runId: runs[0]!.id });
    expect(done).toMatchObject({ id: runs[0]!.id, status: "COMPLETED", trigger: "schedule" });
    const released = await settingsOf(userId);
    expect(released.runLeaseUntil).toBeNull();
    expect(released.runLeaseRunId).toBeNull();
    expect(released.lastRunAt).not.toBeNull();
    expect(released.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it("re-running a run id that already COMPLETED is a no-op (retried or duplicated task)", async () => {
    const userId = await schedulerUser("noop");
    h.capture = true;
    await automationOrchestrator.tick(new Date());
    const [task] = captured("automation.run", userId);
    expect(task).toBeDefined();
    const runId = task!.payload.runId as string;

    // The worker runs the task through the real queue handler (inline driver).
    h.capture = false;
    await enqueue("automation.run", task!.payload, task!.opts);
    const first = await prisma.automationRun.findUniqueOrThrow({ where: { id: runId } });
    expect(first.status).toBe("COMPLETED");
    const settingsBefore = await settingsOf(userId);
    const itemsBefore = await prisma.automationRunItem.count({ where: { runId } });

    // A job arrives afterwards: re-running the finished run must not pick it up (only a new run would).
    await prisma.job.create({
      data: { ownerUserId: userId, platform: "COMPANY_CAREER_PAGE", title: "Frontend Engineer", company: "Late Arrival Co", description: "React work.", importMethod: "MANUAL_ENTRY", dedupeKey: `late-${runId}` },
    });
    const again = await automationOrchestrator.runForUser(userId, "schedule", { runId });
    expect(again).toMatchObject({ id: runId, status: "COMPLETED", completedAt: first.completedAt!.toISOString() });
    await enqueue("automation.run", task!.payload, task!.opts);

    expect(await prisma.automationRun.count({ where: { userId } })).toBe(1);
    expect(await prisma.automationRunItem.count({ where: { runId } })).toBe(itemsBefore);
    expect(await prisma.application.count({ where: { userId } })).toBe(0);
    const settingsAfter = await settingsOf(userId);
    expect(settingsAfter.lastRunAt).toEqual(settingsBefore.lastRunAt);
    expect(settingsAfter.nextRunAt).toEqual(settingsBefore.nextRunAt);
    expect(settingsAfter.runLeaseUntil).toBeNull();
    expect((await prisma.automationRun.findUniqueOrThrow({ where: { id: runId } })).completedAt).toEqual(first.completedAt);
  });

  it("never runs a user whose automation is off", async () => {
    const neverOn = await schedulerUser("off", { enabled: false });
    const switchedOff = await schedulerUser("switched-off");
    await automationSettingsService.update(switchedOff, { enabled: false });
    expect((await settingsOf(switchedOff)).nextRunAt).toBeNull();

    h.capture = true;
    expect((await automationOrchestrator.tick(new Date())).queued).toBe(0);
    // A direct scheduled call does not claim a disabled user either.
    expect(await automationOrchestrator.runForUser(neverOn, "schedule")).toBeNull();
    expect(await prisma.automationRun.count({ where: { userId: { in: [neverOn, switchedOff] } } })).toBe(0);
    expect(captured("automation.run")).toHaveLength(0);
    expect((await settingsOf(neverOn)).runLeaseUntil).toBeNull();
  });

  it("a run queued just before the user turned automation off finishes without doing anything", async () => {
    const userId = await schedulerUser("late-off");
    await fabricateApp(userId, { status: "DISCOVERED", mode: "REVIEW" }); // work the pipeline would otherwise evaluate
    h.capture = true;
    await automationOrchestrator.tick(new Date());
    const [task] = captured("automation.run", userId);
    expect(task).toBeDefined();
    await automationSettingsService.update(userId, { enabled: false });

    h.capture = false;
    expect(await automationOrchestrator.runForUser(userId, "schedule", { runId: task!.payload.runId as string })).toBeNull();
    const run = await prisma.automationRun.findUniqueOrThrow({ where: { id: task!.payload.runId as string } });
    expect(run).toMatchObject({ status: "COMPLETED", error: "Automation was turned off before the run started.", jobsMatched: 0 });
    expect((await prisma.application.findFirstOrThrow({ where: { userId } })).status).toBe("DISCOVERED");
    const s = await settingsOf(userId);
    expect(s.runLeaseUntil).toBeNull();
    expect(s.lastRunAt).toBeNull();
  });

  it("a run whose task cannot be queued is closed and its lease released (tick and Run now)", async () => {
    const userId = await schedulerUser("enqueue-fails");
    h.capture = true;
    h.fail.add("automation.run");
    await automationOrchestrator.tick(new Date());
    const [scheduled] = await prisma.automationRun.findMany({ where: { userId } });
    expect(scheduled).toMatchObject({ trigger: "schedule", status: "FAILED", error: expect.stringMatching(/could not be queued/) });
    let s = await settingsOf(userId);
    expect(s).toMatchObject({ runLeaseUntil: null, runLeaseRunId: null });

    // "Run now" reports the failure and leaves nothing behind that would block the next attempt.
    await expect(automationOrchestrator.runNow(userId, "manual")).rejects.toThrow(/queue unavailable/);
    const runs = await prisma.automationRun.findMany({ where: { userId } });
    expect(runs).toHaveLength(2);
    expect(runs.every((r) => r.status === "FAILED")).toBe(true);
    s = await settingsOf(userId);
    expect(s).toMatchObject({ runLeaseUntil: null, runLeaseRunId: null });
    h.fail.clear();
    const retried = await automationOrchestrator.runNow(userId, "manual");
    expect(retried.status).toBe("RUNNING");
    h.capture = false;
    expect(await automationOrchestrator.runForUser(userId, "manual", { runId: retried.id })).toMatchObject({ status: "COMPLETED" });
  });
});

describe("run lease (owned by the run, renewed while it works)", () => {
  it("renews the lease when a queued run starts after waiting longer than the lease, and while it syncs", async () => {
    const userId = await schedulerUser("lease-renew", { nextRunAt: FAR_FUTURE });
    await dueBoardFeed(userId);
    h.capture = true;
    const run = await automationOrchestrator.runNow(userId, "manual");
    expect(await settingsOf(userId)).toMatchObject({ runLeaseRunId: run.id });
    // The task waited in the queue past the lease; no other run took it over.
    await prisma.automationSettings.update({ where: { userId }, data: { runLeaseUntil: past() } });

    const leaseDuringSync: Date[] = [];
    const sync = vi.spyOn(jobFeedsService, "runSync").mockImplementation(async (feedId) => {
      leaseDuringSync.push((await settingsOf(userId)).runLeaseUntil!);
      return emptySync(feedId);
    });
    try {
      h.capture = false;
      expect(await automationOrchestrator.runForUser(userId, "manual", { runId: run.id })).toMatchObject({ id: run.id, status: "COMPLETED" });
    } finally {
      sync.mockRestore();
    }
    expect(leaseDuringSync).toHaveLength(1);
    expect(leaseDuringSync[0]!.getTime()).toBeGreaterThan(Date.now() + 10 * 60_000);
    expect(await settingsOf(userId)).toMatchObject({ runLeaseUntil: null, runLeaseRunId: null });
  });

  it("a queued run whose lease was taken over by a newer run stops before doing anything", async () => {
    const userId = await schedulerUser("lease-taken", { nextRunAt: FAR_FUTURE });
    const app = await fabricateApp(userId, { status: "DISCOVERED", mode: "REVIEW" });
    h.capture = true;
    const run = await automationOrchestrator.runNow(userId, "manual");
    const newer = new Date(Date.now() + 10 * 60_000);
    await prisma.automationSettings.update({ where: { userId }, data: { runLeaseRunId: "newer-run", runLeaseUntil: newer } });

    h.capture = false;
    expect(await automationOrchestrator.runForUser(userId, "manual", { runId: run.id })).toBeNull();
    const row = await prisma.automationRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(row).toMatchObject({ status: "FAILED", error: expect.stringMatching(/newer run took over/), jobsMatched: 0 });
    expect(await prisma.automationRunItem.count({ where: { runId: run.id } })).toBe(0);
    expect((await prisma.application.findUniqueOrThrow({ where: { id: app.appId } })).status).toBe("DISCOVERED");
    // The newer run's lease is untouched, and no failure is reported for a superseded run.
    expect(await settingsOf(userId)).toMatchObject({ runLeaseRunId: "newer-run", runLeaseUntil: newer });
    expect(await prisma.notification.count({ where: { userId, type: "automation.run_failed" } })).toBe(0);
  });

  it("a run that loses its lease while working stops at the next checkpoint and leaves the newer run's lease alone", async () => {
    const userId = await schedulerUser("lease-lost", { nextRunAt: FAR_FUTURE });
    await dueBoardFeed(userId);
    const app = await fabricateApp(userId, { status: "DISCOVERED", mode: "REVIEW" });
    h.capture = true;
    const run = await automationOrchestrator.runNow(userId, "manual");
    const sync = vi.spyOn(jobFeedsService, "runSync").mockImplementation(async (feedId) => {
      // Meanwhile the lease expired and a newer run claimed it.
      await prisma.automationSettings.update({ where: { userId }, data: { runLeaseRunId: "newer-run", runLeaseUntil: new Date(Date.now() + 10 * 60_000) } });
      return emptySync(feedId);
    });
    try {
      h.capture = false;
      expect(await automationOrchestrator.runForUser(userId, "manual", { runId: run.id })).toBeNull();
    } finally {
      sync.mockRestore();
    }
    const row = await prisma.automationRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(row).toMatchObject({ status: "FAILED", error: expect.stringMatching(/newer run took over/), jobsMatched: 0 });
    expect((await prisma.application.findUniqueOrThrow({ where: { id: app.appId } })).status).toBe("DISCOVERED");
    expect(await settingsOf(userId)).toMatchObject({ runLeaseRunId: "newer-run" });
    expect((await settingsOf(userId)).runLeaseUntil).not.toBeNull();
    expect(await prisma.notification.count({ where: { userId, type: "automation.run_failed" } })).toBe(0);
  });

  it("a failing run releases only its own lease", async () => {
    const userId = await schedulerUser("lease-fail", { nextRunAt: FAR_FUTURE });
    await dueBoardFeed(userId);
    h.capture = true;
    const run = await automationOrchestrator.runNow(userId, "manual");
    const sync = vi.spyOn(jobFeedsService, "runSync").mockImplementation(async () => {
      await prisma.automationSettings.update({ where: { userId }, data: { runLeaseRunId: "newer-run", runLeaseUntil: new Date(Date.now() + 10 * 60_000) } });
      throw new Error("provider exploded");
    });
    try {
      h.capture = false;
      expect(await automationOrchestrator.runForUser(userId, "manual", { runId: run.id })).toBeNull();
    } finally {
      sync.mockRestore();
    }
    expect((await prisma.automationRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe("FAILED");
    const s = await settingsOf(userId);
    expect(s.runLeaseRunId).toBe("newer-run");
    expect(s.runLeaseUntil).not.toBeNull();

    // Its own lease is released when it fails.
    await prisma.automationSettings.update({ where: { userId }, data: { runLeaseRunId: null, runLeaseUntil: null } });
    const own = await bareUser("lease-fail-own"); // no profile: the run fails at the match step
    await prisma.automationSettings.create({ data: { userId: own, enabled: true, mode: "REVIEW", timezone: "UTC", nextRunAt: FAR_FUTURE } });
    expect(await automationOrchestrator.runForUser(own, "manual")).toBeNull();
    expect(await settingsOf(own)).toMatchObject({ runLeaseUntil: null, runLeaseRunId: null });
    expect(await prisma.automationRun.findFirstOrThrow({ where: { userId: own } })).toMatchObject({ status: "FAILED", error: expect.stringMatching(/Create your profile/) });
  });

  it("the scheduler closes runs that were interrupted, but not a long run that keeps renewing its lease", async () => {
    const lost = await schedulerUser("reap-lost", { nextRunAt: FAR_FUTURE });
    const expired = await schedulerUser("reap-expired", { nextRunAt: FAR_FUTURE });
    const alive = await schedulerUser("reap-alive", { nextRunAt: FAR_FUTURE });
    const started = new Date(Date.now() - 40 * 60_000);
    // The task was lost (e.g. the dev server restarted): no lease at all.
    const lostRun = await prisma.automationRun.create({ data: { userId: lost, trigger: "schedule", mode: "REVIEW", startedAt: started } });
    // The worker crashed: it still owns a lease that expired.
    const expiredRun = await prisma.automationRun.create({ data: { userId: expired, trigger: "schedule", mode: "REVIEW", startedAt: started } });
    await prisma.automationSettings.update({ where: { userId: expired }, data: { runLeaseRunId: expiredRun.id, runLeaseUntil: past(5 * 60_000) } });
    // A long run that is still working (it renewed its lease a minute ago).
    const aliveRun = await prisma.automationRun.create({ data: { userId: alive, trigger: "schedule", mode: "REVIEW", startedAt: started } });
    await prisma.automationSettings.update({ where: { userId: alive }, data: { runLeaseRunId: aliveRun.id, runLeaseUntil: new Date(Date.now() + 14 * 60_000) } });

    h.capture = true;
    const r = await automationOrchestrator.tick(new Date());
    expect(r.reaped).toBeGreaterThanOrEqual(2);
    for (const id of [lostRun.id, expiredRun.id]) {
      expect(await prisma.automationRun.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "FAILED", error: expect.stringMatching(/interrupted/), completedAt: expect.any(Date) });
    }
    // The expired lease was revoked, so the crashed run could never renew it.
    expect(await settingsOf(expired)).toMatchObject({ runLeaseRunId: null, runLeaseUntil: null });
    expect((await prisma.automationRun.findUniqueOrThrow({ where: { id: aliveRun.id } })).status).toBe("RUNNING");
    expect(await settingsOf(alive)).toMatchObject({ runLeaseRunId: aliveRun.id });

    // A new claim for the user closes any run that can no longer hold the lease.
    await prisma.automationSettings.update({ where: { userId: alive }, data: { runLeaseUntil: past() } });
    const next = await automationOrchestrator.runNow(alive, "manual");
    expect((await prisma.automationRun.findUniqueOrThrow({ where: { id: aliveRun.id } })).status).toBe("FAILED");
    expect(await settingsOf(alive)).toMatchObject({ runLeaseRunId: next.id });
    h.capture = false;
    expect(await automationOrchestrator.runForUser(alive, "manual", { runId: next.id })).toMatchObject({ status: "COMPLETED" });
  });
});

describe("preparation cap per run", () => {
  withPrepareCap(3);

  it("prepares the best matches up to the cap and leaves the rest for the next run, which prepares them", async () => {
    const userId = await onboardedUser("cap");
    await enableAutomation(userId, "REVIEW", {}, "connection");
    await importDemoJobs(userId, [...HIGH, LOW[0]!]);

    const run1 = await automationOrchestrator.runForUser(userId, "manual");
    expect(run1).toMatchObject({ status: "COMPLETED", autoEligible: 6, ignored: 1, applicationsPrepared: 3 });
    const deferredItems = await prisma.automationRunItem.findMany({ where: { runId: run1!.id, stage: "prepare", outcome: "DEFERRED" } });
    expect(deferredItems).toHaveLength(3);

    let apps = await prisma.application.findMany({ where: { userId } });
    const prepared = apps.filter((a) => a.preparedAt);
    const waiting = apps.filter((a) => !a.preparedAt && a.automationDecision === "AUTO_ELIGIBLE");
    expect(prepared).toHaveLength(3);
    expect(prepared.every((a) => a.status === "WAITING_APPROVAL")).toBe(true);
    expect(waiting.map((a) => a.id).sort()).toEqual(deferredItems.map((i) => i.applicationId).sort());
    expect(waiting.every((a) => a.status === "AUTO_ELIGIBLE")).toBe(true);
    // Best matches first.
    expect(Math.min(...prepared.map((a) => a.decisionScore!))).toBeGreaterThanOrEqual(Math.max(...waiting.map((a) => a.decisionScore!)));
    const strongNotices = () => prisma.notification.findMany({ where: { userId, type: "automation.strong_match" } });
    expect((await strongNotices()).map((n) => n.title)).toEqual([expect.stringMatching(/^6 .*strong matches found$/)]);

    // The next run discovers nothing new but prepares exactly the deferred ones.
    const run2 = await automationOrchestrator.runForUser(userId, "manual");
    expect(run2).toMatchObject({ status: "COMPLETED", newJobs: 0, applicationsPrepared: 3 });
    expect(await prisma.automationRunItem.count({ where: { runId: run2!.id, outcome: "DEFERRED" } })).toBe(0);
    apps = await prisma.application.findMany({ where: { userId } });
    for (const w of waiting) {
      const now = apps.find((a) => a.id === w.id)!;
      expect(now.preparedAt).not.toBeNull();
      expect(now.status).toBe("WAITING_APPROVAL");
      expect(now.automationRunId).toBe(run2!.id);
    }
    expect(apps.filter((a) => a.status === "WAITING_APPROVAL")).toHaveLength(6);
    // The deferred jobs were already announced as strong matches by run 1: run 2 does not announce them again.
    expect(await strongNotices()).toHaveLength(1);

    // Nothing is left: a third run prepares nothing. REVIEW mode never submitted anything.
    const run3 = await automationOrchestrator.runForUser(userId, "manual");
    expect(run3).toMatchObject({ status: "COMPLETED", applicationsPrepared: 0 });
    expect(await strongNotices()).toHaveLength(1);
    expect(await prisma.applicationExecution.count({ where: { userId } })).toBe(0);
    expect(await prisma.application.count({ where: { userId, status: "PREPARING" } })).toBe(0);
  }, SLOW);
});

describe("rule changes re-evaluate applications that are still in the pipeline", () => {
  withPrepareCap(3);

  it("raising autoApplyScore turns deferred AUTO_ELIGIBLE applications into REVIEW; lowering recommendScore turns score-filtered ones into recommendations", async () => {
    const userId = await onboardedUser("rules");
    await enableAutomation(userId, "AUTO", {}, "connection");
    await importDemoJobs(userId, [...HIGH, ...LOW]);

    // Run 1: 6 auto-eligible, the 3 best (score 100) prepared + submitted (cap), 3 deferred; the low matches are ignored.
    const run1 = await automationOrchestrator.runForUser(userId, "manual");
    expect(run1).toMatchObject({ status: "COMPLETED", autoEligible: 6, ignored: 3, applicationsPrepared: 3, applicationsSubmitted: 3 });
    const v1 = (await settingsOf(userId)).rulesVersion;
    let byKey = await appsByDemoKey(userId);
    const high = HIGH.map((k) => byKey.get(k)!);
    const sent = high.filter((a) => a.preparedAt);
    const deferred = high.filter((a) => !a.preparedAt);
    expect(sent.map((a) => a.status)).toEqual(["APPLIED", "APPLIED", "APPLIED"]);
    expect(deferred).toHaveLength(3);
    expect(deferred.every((a) => a.status === "AUTO_ELIGIBLE" && a.automationDecision === "AUTO_ELIGIBLE" && a.rulesVersion === v1)).toBe(true);
    // Scores are 0-100: the threshold below can only exclude the deferred ones if they score below 100.
    expect(Math.max(...deferred.map((a) => a.decisionScore!))).toBeLessThan(100);
    const low = LOW.map((k) => byKey.get(k)!);
    expect(low.every((a) => a.status === "REJECTED_BY_RULES" && a.automationDecision === "IGNORE")).toBe(true);

    // Raising the threshold above every deferred score bumps the rules version...
    env().AUTOMATION_MAX_PREPARE_PER_RUN = 2;
    await automationSettingsService.update(userId, { autoApplyScore: 100 });
    const v2 = (await settingsOf(userId)).rulesVersion;
    expect(v2).toBe(v1 + 1);

    // ...so the next run re-evaluates what is not prepared yet: nothing is auto-eligible (or submitted) any more.
    const run2 = await automationOrchestrator.runForUser(userId, "manual");
    expect(run2).toMatchObject({ status: "COMPLETED", autoEligible: 0, reviewRequired: 3, ignored: 3, applicationsPrepared: 2, applicationsSubmitted: 0 });
    byKey = await appsByDemoKey(userId);
    for (const d of deferred) {
      const a = [...byKey.values()].find((x) => x.id === d.id)!;
      expect(a).toMatchObject({ automationDecision: "REVIEW", rulesVersion: v2 });
      expect(["MATCHED", "WAITING_APPROVAL"]).toContain(a.status);
      expect(a.approvalSource).toBeNull();
      const evaluated = await prisma.applicationEvent.findFirst({ where: { applicationId: a.id, type: "evaluate", fromStatus: "AUTO_ELIGIBLE", toStatus: "MATCHED" } });
      expect(evaluated).not.toBeNull();
    }
    expect(deferred.filter((d) => [...byKey.values()].find((x) => x.id === d.id)!.status === "WAITING_APPROVAL")).toHaveLength(2);
    // Applications already sent are never re-evaluated.
    for (const s of sent) expect([...byKey.values()].find((x) => x.id === s.id)).toMatchObject({ status: "APPLIED", automationDecision: "AUTO_ELIGIBLE", rulesVersion: v1 });
    expect(await prisma.applicationExecution.count({ where: { userId } })).toBe(3);

    // Lowering the recommend threshold: jobs filtered out by the score alone become recommendations (MATCHED).
    await automationSettingsService.update(userId, { recommendScore: 10 });
    const v3 = (await settingsOf(userId)).rulesVersion;
    expect(v3).toBe(v2 + 1);
    const run3 = await automationOrchestrator.runForUser(userId, "manual");
    expect(run3).toMatchObject({ status: "COMPLETED", recommended: 3, ignored: 0, reviewRequired: 1, applicationsPrepared: 1, applicationsSubmitted: 0 });
    byKey = await appsByDemoKey(userId);
    for (const k of LOW) {
      const a = byKey.get(k)!;
      expect(a).toMatchObject({ status: "MATCHED", automationDecision: "RECOMMEND", rulesVersion: v3, preparedAt: null });
      const scoreCheck = (a.decisionReasons as unknown as RuleCheck[]).find((c) => c.key === "match_score");
      expect(scoreCheck?.outcome).not.toBe("fail");
    }
    // The REVIEW application still waiting for preparation was prepared in this run.
    expect(await prisma.application.count({ where: { userId, status: "WAITING_APPROVAL" } })).toBe(3);
    expect(await prisma.applicationExecution.count({ where: { userId } })).toBe(3);
  }, SLOW);
});

describe("one preparation per canonical job, across runs", () => {
  it("prepares one listing of a job; the other listing is kept as a recommendation and not re-selected by later runs", async () => {
    const userId = await onboardedUser("canonical");
    await enableAutomation(userId, "REVIEW", {}, "connection");
    const jobA = (await importDemoJobs(userId, [HIGH[0]!])).get(HIGH[0]!)!;
    const jobB = await copyJob(jobA);

    // Run 1 finds both listings: one is prepared, the other is persisted as RECOMMEND (not left awaiting preparation).
    const run1 = await automationOrchestrator.runForUser(userId, "manual");
    expect(run1).toMatchObject({ status: "COMPLETED", applicationsPrepared: 1 });
    let apps = await prisma.application.findMany({ where: { userId } });
    expect(apps).toHaveLength(2);
    const prepared = apps.find((a) => a.preparedAt)!;
    const duplicate = apps.find((a) => !a.preparedAt)!;
    expect(prepared.status).toBe("WAITING_APPROVAL");
    expect(duplicate).toMatchObject({ status: "MATCHED", automationDecision: "RECOMMEND" });
    expect((duplicate.decisionReasons as unknown as RuleCheck[]).find((c) => c.key === "already_applied")).toMatchObject({ outcome: "fail", effect: "cap_recommend" });
    expect((await prisma.notification.findMany({ where: { userId, type: "automation.strong_match" } })).map((n) => n.title)).toEqual(["1 new strong match found"]);
    const duplicateEvents = await prisma.applicationEvent.count({ where: { applicationId: duplicate.id } });

    // Run 2: nothing to prepare, and the duplicate is not selected (or annotated) again.
    const run2 = await automationOrchestrator.runForUser(userId, "manual");
    expect(run2).toMatchObject({ status: "COMPLETED", applicationsPrepared: 0 });
    expect(await prisma.automationRunItem.count({ where: { runId: run2!.id, applicationId: duplicate.id } })).toBe(0);
    expect(await prisma.applicationEvent.count({ where: { applicationId: duplicate.id } })).toBe(duplicateEvents);
    expect(await prisma.application.findUniqueOrThrow({ where: { id: duplicate.id } })).toMatchObject({ status: "MATCHED", automationDecision: "RECOMMEND", preparedAt: null });

    // A later listing of the same job (e.g. a repost) is evaluated in its own run: the prepared sibling wins.
    const jobC = await copyJob(jobA);
    const run3 = await automationOrchestrator.runForUser(userId, "manual");
    expect(run3).toMatchObject({ status: "COMPLETED", applicationsPrepared: 0, recommended: 1 });
    const third = await prisma.application.findUniqueOrThrow({ where: { userId_jobId: { userId, jobId: jobC } } });
    expect(third).toMatchObject({ status: "MATCHED", automationDecision: "RECOMMEND", preparedAt: null });
    apps = await prisma.application.findMany({ where: { userId } });
    expect(apps.filter((a) => a.preparedAt)).toHaveLength(1);
    expect(apps.filter((a) => a.status === "WAITING_APPROVAL")).toHaveLength(1);
    expect(await prisma.notification.count({ where: { userId, type: "automation.strong_match" } })).toBe(1);
    expect([jobA, jobB]).toContain(prepared.jobId);
  }, SLOW);
});

describe("per-job isolation in the rules stage", () => {
  it("a job the user moves on concurrently is skipped and a job that errors is recorded; the run still completes", async () => {
    const userId = await onboardedUser("isolation");
    await enableAutomation(userId, "REVIEW", {}, "connection");
    await importDemoJobs(userId, HIGH.slice(0, 3));
    const original = dailyLimitService.countToday.bind(dailyLimitService);
    let calls = 0;
    // countToday runs inside evaluateJob, between reading the application and writing the decision.
    const spy = vi.spyOn(dailyLimitService, "countToday").mockImplementation(async (...args: Parameters<typeof original>) => {
      calls++;
      if (calls === 1) {
        // The user declines the job being evaluated (Jobs inbox) while the run evaluates it.
        const current = await prisma.application.findFirstOrThrow({ where: { userId, status: "MATCHED" }, orderBy: { updatedAt: "desc" } });
        await prisma.application.update({ where: { id: current.id }, data: { status: "WITHDRAWN" } });
      }
      if (calls === 2) throw new Error("transient database error");
      return original(...args);
    });
    let run;
    try {
      run = await automationOrchestrator.runForUser(userId, "manual");
    } finally {
      spy.mockRestore();
    }
    expect(run).toMatchObject({ status: "COMPLETED", autoEligible: 1, applicationsPrepared: 1, failures: 1 });
    const apps = await prisma.application.findMany({ where: { userId } });
    expect(apps.filter((a) => a.status === "WITHDRAWN")).toHaveLength(1);
    // The withdrawn application was not overwritten by the evaluation.
    expect(apps.find((a) => a.status === "WITHDRAWN")!.automationDecision).toBeNull();
    expect(apps.filter((a) => a.status === "WAITING_APPROVAL")).toHaveLength(1);
    expect(await prisma.automationRunItem.count({ where: { runId: run!.id, stage: "rules", outcome: "ERROR" } })).toBe(1);
    expect(await prisma.notification.count({ where: { userId, type: "automation.run_failed" } })).toBe(0);
  }, SLOW);

  describe("with a preparation cap of 1", () => {
    withPrepareCap(1);

    it("re-evaluating an unchanged decision never overwrites an application the user just moved on", async () => {
      const userId = await onboardedUser("isolation-cas");
      await enableAutomation(userId, "REVIEW", {}, "connection");
      await importDemoJobs(userId, HIGH.slice(0, 2));
      const run1 = await automationOrchestrator.runForUser(userId, "manual");
      expect(run1).toMatchObject({ status: "COMPLETED", applicationsPrepared: 1 });
      const deferred = await prisma.application.findFirstOrThrow({ where: { userId, preparedAt: null } });
      expect(deferred).toMatchObject({ status: "AUTO_ELIGIBLE", automationDecision: "AUTO_ELIGIBLE", automationRunId: run1!.id });

      // Run 2 re-reads the deferred application; right after that read the user clicks "Prepare" (PREPARING).
      type Read = (args: { where?: { id?: string }; select?: Record<string, unknown> }) => Promise<unknown>;
      const delegate = prisma.application as unknown as Record<"findUnique" | "findUniqueOrThrow", Read>;
      const restore: (() => void)[] = [];
      for (const method of ["findUnique", "findUniqueOrThrow"] as const) {
        const read = delegate[method].bind(delegate);
        const spy = vi.spyOn(delegate, method).mockImplementation(async (args) => {
          const row = await read(args);
          if (args.where?.id === deferred.id && args.select?.automationDecision && !args.select?.origin) {
            await prisma.application.update({ where: { id: deferred.id }, data: { status: "PREPARING" } });
          }
          return row;
        });
        // mockRestore() cannot restore a property of Prisma's model proxy: delegate to the original instead.
        restore.push(() => spy.mockImplementation(read));
      }
      let run2;
      try {
        run2 = await automationOrchestrator.runForUser(userId, "manual");
      } finally {
        restore.forEach((r) => r());
      }
      expect(run2).toMatchObject({ status: "COMPLETED", applicationsPrepared: 0 });
      const after = await prisma.application.findUniqueOrThrow({ where: { id: deferred.id } });
      expect(after).toMatchObject({ status: "PREPARING", automationRunId: run1!.id });
      expect(after.evaluatedAt).toEqual(deferred.evaluatedAt);
    }, SLOW);
  });
});

describe("recovery of deferred and stuck work", () => {
  it("redriveDeferred re-queues APPROVED Review/Auto applications whose nextActionAt passed, once", async () => {
    const userId = await bareUser("redrive");
    const due = await fabricateApp(userId, { status: "APPROVED", mode: "AUTO", nextActionAt: past() });
    const dueReview = await fabricateApp(userId, { status: "APPROVED", mode: "REVIEW", nextActionAt: past(1_000) });
    const later = await fabricateApp(userId, { status: "APPROVED", mode: "AUTO", nextActionAt: new Date(Date.now() + 3_600_000) });
    const manual = await fabricateApp(userId, { status: "APPROVED", mode: "MANUAL", nextActionAt: past() });
    const notApproved = await fabricateApp(userId, { status: "WAITING_APPROVAL", mode: "AUTO", nextActionAt: past() });
    const notDeferred = await fabricateApp(userId, { status: "APPROVED", mode: "AUTO", nextActionAt: null });

    h.capture = true;
    expect(await automationOrchestrator.redriveDeferred(new Date())).toBe(2);
    const tasks = captured("application.execute", userId);
    expect(tasks.map((t) => t.payload.applicationId).sort()).toEqual([due.appId, dueReview.appId].sort());
    // Own queue keys: a re-drive never holds the bare key, so it cannot absorb a later task (e.g. the user's Retry).
    for (const t of tasks) {
      expect(t.opts.dedupeKey).toMatch(new RegExp(`^application\\.execute:${String(t.payload.applicationId)}:redrive:\\d+$`));
      expect(t.opts.dedupeKey).not.toBe(`application.execute:${String(t.payload.applicationId)}`);
    }

    const rows = new Map((await prisma.application.findMany({ where: { userId } })).map((a) => [a.id, a]));
    expect(rows.get(due.appId)!.nextActionAt).toBeNull();
    expect(rows.get(dueReview.appId)!.nextActionAt).toBeNull();
    expect(rows.get(later.appId)!.nextActionAt!.getTime()).toBeGreaterThan(Date.now());
    expect(rows.get(manual.appId)!.nextActionAt).not.toBeNull();
    expect(rows.get(notApproved.appId)!.nextActionAt).not.toBeNull();
    expect(rows.get(notDeferred.appId)!.status).toBe("APPROVED");

    // Already re-queued: the next scheduler pass finds nothing.
    expect(await automationOrchestrator.redriveDeferred(new Date())).toBe(0);
    expect(captured("application.execute", userId)).toHaveLength(2);
  });

  it("a run re-queues preparations stuck in PREPARING for more than 30 minutes (and due deferred executions)", async () => {
    const userId = await schedulerUser("stale", { nextRunAt: FAR_FUTURE });
    const stuck = await fabricateApp(userId, { status: "PREPARING", mode: "REVIEW" });
    const fresh = await fabricateApp(userId, { status: "PREPARING", mode: "REVIEW" });
    const deferred = await fabricateApp(userId, { status: "APPROVED", mode: "AUTO", nextActionAt: past() });
    await prisma.$executeRaw`UPDATE "Application" SET "updatedAt" = NOW() - INTERVAL '45 minutes' WHERE "id" = ${stuck.appId}`;

    h.capture = true;
    const run = await automationOrchestrator.runForUser(userId, "manual");
    expect(run?.status).toBe("COMPLETED");
    const prepares = captured("application.prepare", userId);
    expect(prepares.map((t) => t.payload.applicationId)).toEqual([stuck.appId]);
    expect(prepares[0]!.opts.dedupeKey).toBe(`application.prepare:${stuck.appId}`);
    expect(prepares.some((t) => t.payload.applicationId === fresh.appId)).toBe(false);
    expect(captured("application.execute", userId).map((t) => t.payload.applicationId)).toEqual([deferred.appId]);
    // Re-queued, not moved: the preparation task itself finishes the job.
    expect((await prisma.application.findUniqueOrThrow({ where: { id: stuck.appId } })).status).toBe("PREPARING");
  });

  it("the scheduler's pass and a run's pass re-queue a due deferral once between them", async () => {
    const userId = await bareUser("redrive-once");
    const due = await fabricateApp(userId, { status: "APPROVED", mode: "AUTO", nextActionAt: past() });
    h.capture = true;
    const now = new Date();
    await Promise.all([automationOrchestrator.redriveDeferred(now), automationOrchestrator.redriveUser(userId, now)]);
    expect(captured("application.execute", userId).map((t) => t.payload.applicationId)).toEqual([due.appId]);
  });

  it("re-queues APPROVED Review/Auto applications whose execute task was lost, at most once per 15 minutes", async () => {
    const userId = await bareUser("lost-execute", { profile: true });
    await prisma.automationSettings.create({ data: { userId, enabled: true, mode: "AUTO", timezone: "UTC", nextRunAt: FAR_FUTURE } });
    await prisma.userConsent.create({ data: { userId, type: "AUTO_APPLY", granted: true, grantedAt: new Date() } });
    const offUser = await bareUser("lost-execute-off");
    await prisma.automationSettings.create({ data: { userId: offUser, enabled: false, mode: "AUTO", timezone: "UTC" } });

    const lostPolicy = await fabricateApp(userId, { status: "APPROVED", mode: "AUTO" });
    const lostUser = await fabricateApp(userId, { status: "APPROVED", mode: "REVIEW" });
    await prisma.application.update({ where: { id: lostUser.appId }, data: { approvalSource: "user" } });
    const fresh = await fabricateApp(userId, { status: "APPROVED", mode: "AUTO" });
    const running = await fabricateApp(userId, { status: "APPROVED", mode: "AUTO" });
    await prisma.applicationExecution.create({ data: { userId, applicationId: running.appId, idempotencyKey: `lost-test:${running.appId}`, executorKind: "API", executorId: "api:demo", status: "RUNNING", leaseUntil: new Date(Date.now() + 60_000) } });
    const blocked = await fabricateApp(userId, { status: "APPROVED", mode: "AUTO" });
    await prisma.applicationEvent.create({ data: { applicationId: blocked.appId, userId, type: "execution_blocked", message: "Automatic submission paused.", actor: "policy" } });
    const manual = await fabricateApp(userId, { status: "APPROVED", mode: "MANUAL" });
    // Approved by the policy, but the user turned the automation off since: swept too - execute() hands it back.
    const policyOff = await fabricateApp(offUser, { status: "APPROVED", mode: "AUTO" });
    const old = [lostPolicy, lostUser, running, blocked, manual, policyOff].map((a) => a.appId);
    await prisma.$executeRaw`UPDATE "Application" SET "updatedAt" = NOW() - INTERVAL '20 minutes' WHERE "id" = ANY(${old})`;

    h.capture = true;
    const now = new Date();
    // (>=: other tests of this file may have left work behind; the tasks below are exact for these users.)
    expect(await automationOrchestrator.redriveDeferred(now)).toBeGreaterThanOrEqual(2);
    const tasks = [...captured("application.execute", userId), ...captured("application.execute", offUser)];
    expect(tasks.map((t) => t.payload.applicationId).sort()).toEqual([lostPolicy.appId, lostUser.appId, policyOff.appId].sort());
    for (const t of tasks) expect(t.opts.dedupeKey).toMatch(/:sweep:\d+$/);
    expect((await prisma.application.findUniqueOrThrow({ where: { id: fresh.appId } })).status).toBe("APPROVED");

    // Claimed (updatedAt touched): neither the next scheduler pass nor the user's run re-queues it within 15 minutes.
    expect(await automationOrchestrator.sweepLostExecutions(new Date())).toBe(0);
    await automationOrchestrator.redriveUser(userId, new Date());
    expect(captured("application.execute", userId)).toHaveLength(2);
    expect(captured("application.execute", offUser)).toHaveLength(1);
  });
});

describe("daily summary", () => {
  // 06:00 UTC = 11:30 in Asia/Kolkata: before the default 20:00 summary hour of every other user in this file.
  const NOW = new Date("2031-03-10T06:00:00Z");
  const NEXT_DAY = new Date("2031-03-11T06:00:00Z");

  it("is sent once per local day, even during quiet hours", async () => {
    const userId = await schedulerUser("summary", { dailySummaryHour: 0, nextRunAt: FAR_FUTURE, quietHoursStart: 0, quietHoursEnd: 12 * 60 });
    await automationOrchestrator.dailySummary(userId, NOW);
    await automationOrchestrator.dailySummary(userId, new Date(NOW.getTime() + 3_600_000));
    let rows = await prisma.notification.findMany({ where: { userId, type: "automation.daily_summary" } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ dedupeKey: "summary:2031-03-10", scheduledFor: null, link: "/dashboard", title: "Today: 0 applications sent, 0 strong matches" });
    expect(rows[0]!.body).toContain("Daily limit: 0/10.");

    await automationOrchestrator.dailySummary(userId, NEXT_DAY);
    rows = await prisma.notification.findMany({ where: { userId, type: "automation.daily_summary" }, orderBy: { dedupeKey: "asc" } });
    expect(rows.map((r) => r.dedupeKey)).toEqual(["summary:2031-03-10", "summary:2031-03-11"]);
  });

  it("dailySummaryTick claims each user once per local day, even with overlapping ticks", async () => {
    const due = await schedulerUser("summary-tick", { dailySummaryHour: 5, nextRunAt: FAR_FUTURE });
    const notYet = await schedulerUser("summary-late", { dailySummaryHour: 23, nextRunAt: FAR_FUTURE });
    const off = await schedulerUser("summary-off", { dailySummaryHour: null, nextRunAt: FAR_FUTURE });
    const disabled = await schedulerUser("summary-disabled", { enabled: false, dailySummaryHour: 0 });

    h.capture = true;
    overlapNextSettingsReads(2);
    const [a, b] = await Promise.all([automationOrchestrator.dailySummaryTick(NOW), automationOrchestrator.dailySummaryTick(NOW)]);
    expect(a + b).toBe(captured("summary.daily").length);
    const tasks = captured("summary.daily", due);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.opts.dedupeKey).toBe(`summary.daily:${due}:2031-03-10`);
    expect((await settingsOf(due)).lastDailySummaryDay).toBe("2031-03-10");
    for (const other of [notYet, off, disabled]) {
      expect(captured("summary.daily", other)).toHaveLength(0);
      expect((await settingsOf(other)).lastDailySummaryDay).toBeNull();
    }

    // Later the same day: already claimed. The next local day: claimed again.
    await automationOrchestrator.dailySummaryTick(new Date(NOW.getTime() + 2 * 3_600_000));
    expect(captured("summary.daily", due)).toHaveLength(1);
    await automationOrchestrator.dailySummaryTick(NEXT_DAY);
    expect(captured("summary.daily", due).map((t) => t.opts.dedupeKey)).toEqual([`summary.daily:${due}:2031-03-10`, `summary.daily:${due}:2031-03-11`]);
  });

  it("dailySummaryTick reaches every enabled user, not only the first page of 500", async () => {
    const AT = new Date("2032-05-10T12:00:00Z");
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const emails = Array.from({ length: 501 }, (_, i) => `auto-summary-page-${stamp}-${i}@example.test`);
    await prisma.user.createMany({ data: emails.map((email) => ({ email, name: "Paging User", passwordHash: "unused-in-tests", emailVerifiedAt: new Date() })) });
    const ids = (await prisma.user.findMany({ where: { email: { in: emails } }, select: { id: true } })).map((u) => track(u.id));
    expect(ids).toHaveLength(501);
    await prisma.automationSettings.createMany({ data: ids.map((userId) => ({ userId, enabled: true, mode: "REVIEW" as const, timezone: "UTC", dailySummaryHour: 0, nextRunAt: FAR_FUTURE })) });
    try {
      h.capture = true;
      await automationOrchestrator.dailySummaryTick(AT);
      const reached = new Set(captured("summary.daily").map((t) => t.opts.userId));
      expect(ids.filter((id) => !reached.has(id))).toEqual([]);
      // Already sent today: a second tick skips all of them.
      h.calls.length = 0;
      await automationOrchestrator.dailySummaryTick(new Date(AT.getTime() + 60_000));
      expect(captured("summary.daily").filter((t) => ids.includes(t.opts.userId!))).toHaveLength(0);
    } finally {
      await prisma.automationSettings.updateMany({ where: { userId: { in: ids } }, data: { enabled: false } });
    }
  });
});
