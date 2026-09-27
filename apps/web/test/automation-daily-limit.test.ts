import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@applywise/database";
import { applicationService } from "@/server/services/application.service";
import { applicationExecutionService } from "@/server/services/application-execution.service";
import { automationOrchestrator } from "@/server/services/automation-orchestrator.service";
import { automationSettingsService } from "@/server/services/automation-settings.service";
import { dayKey } from "@/server/services/automation-time";
import { disableTrackedUsers, enableAutomation, importDemoJobs, onboardedUser } from "./automation-helpers";

/**
 * The per-user daily submission limit in AUTO mode, end to end through the real pipeline (inline queue, demo provider):
 * a run submits at most the limit, the rest stay APPROVED and are deferred to the next local day, retries and
 * user approvals never exceed it, and the deferred applications go out the next day - again within the limit.
 */

const SLOW = 180_000;
const LIMIT = 3;
const TZ = "Asia/Kolkata"; // the settings default
/** Six demo jobs (DEMO CONTENT) that are auto-eligible for the onboarded demo candidate and submit successfully. */
const HIGH = ["aw-flowkit-automation-builder", "aw-sceneforge-scene-editor", "aw-uploadly-media-uploads", "aw-fanfolio-creator-dashboard", "aw-captionly-subtitle-editor", "aw-critiq-design-review"];

let userId: string;
const counted = async () => (await prisma.dailyApplicationCounter.findMany({ where: { userId } })).reduce((n, c) => n + c.count, 0);
const byStatus = async (status: "APPLIED" | "APPROVED") => prisma.application.findMany({ where: { userId, status }, orderBy: { id: "asc" } });

beforeAll(async () => {
  userId = await onboardedUser("limit");
  await enableAutomation(userId, "AUTO", { maxApplicationsPerDay: LIMIT }, "connection");
  await importDemoJobs(userId, HIGH);
}, SLOW);

afterAll(disableTrackedUsers);

describe("daily application limit (AUTO mode)", () => {
  it(`submits at most ${LIMIT} in a run; the rest stay APPROVED and are deferred to the next local day`, async () => {
    const started = new Date();
    const run = await automationOrchestrator.runForUser(userId, "manual");
    expect(run).toMatchObject({ status: "COMPLETED", autoEligible: 6, applicationsPrepared: 6, applicationsSubmitted: LIMIT });

    const applied = await byStatus("APPLIED");
    const deferred = await byStatus("APPROVED");
    expect(applied).toHaveLength(LIMIT);
    expect(deferred).toHaveLength(6 - LIMIT);
    for (const a of deferred) {
      expect(a.approvalSource).toBe("policy");
      expect(a.appliedAt).toBeNull();
      expect(a.nextActionAt!.getTime()).toBeGreaterThan(Date.now());
      expect(a.nextActionAt!.getTime()).toBeLessThanOrEqual(started.getTime() + 24 * 3_600_000 + 60_000);
      expect(dayKey(a.nextActionAt!, TZ)).not.toBe(dayKey(started, TZ));
      const event = await prisma.applicationEvent.findFirst({ where: { applicationId: a.id, type: "daily_limit_reached" } });
      expect(event?.message).toMatch(new RegExp(`^Daily limit of ${LIMIT} applications reached`));
    }

    // Exactly the limit is counted, on today's (local) counter.
    const counters = await prisma.dailyApplicationCounter.findMany({ where: { userId } });
    expect(counters).toEqual([expect.objectContaining({ day: dayKey(new Date(), TZ), count: LIMIT })]);
    // The deferred ones hold an idempotency claim but no attempt and no slot.
    const executions = await prisma.applicationExecution.findMany({ where: { userId } });
    expect(executions.filter((e) => e.status === "SUCCEEDED")).toHaveLength(LIMIT);
    const pending = executions.filter((e) => e.status === "PENDING");
    expect(pending.map((e) => e.applicationId).sort()).toEqual(deferred.map((a) => a.id).sort());
    expect(pending.every((e) => e.attempts === 0 && e.slotDay === null)).toBe(true);
    expect(await prisma.automationRunItem.count({ where: { runId: run!.id, stage: "execute", outcome: "DEFERRED" } })).toBe(6 - LIMIT);

    const view = await automationSettingsService.getView(userId);
    expect(view.status).toMatchObject({ applicationsToday: LIMIT, dailyLimit: LIMIT });
  }, SLOW);

  it(`never counts more than ${LIMIT}: concurrent retries, a user approval and another run are all deferred`, async () => {
    const deferred = await byStatus("APPROVED");
    const reports = await Promise.all(deferred.map((a) => applicationExecutionService.execute(userId, a.id)));
    expect(reports.map((r) => r.outcome)).toEqual(deferred.map(() => "DEFERRED"));

    // "Approve & apply" by the user is subject to the same limit.
    const viaUser = await applicationService.applyNow(userId, deferred[0]!.id, {});
    expect(viaUser.status).toBe("APPROVED");
    expect(viaUser.automation.nextActionAt!.getTime()).toBeGreaterThan(Date.now());

    const run = await automationOrchestrator.runForUser(userId, "manual");
    expect(run).toMatchObject({ status: "COMPLETED", newJobs: 0, applicationsSubmitted: 0 });

    expect(await counted()).toBe(LIMIT);
    expect(await prisma.applicationExecution.count({ where: { userId, status: "SUCCEEDED" } })).toBe(LIMIT);
    expect(await byStatus("APPROVED")).toHaveLength(6 - LIMIT);
    expect(await byStatus("APPLIED")).toHaveLength(LIMIT);
  }, SLOW);

  it("the next day the deferred applications are submitted by the run's recovery step - again within the limit", async () => {
    // Simulate midnight: today's submissions become an earlier day's, and the deferral time has passed.
    await prisma.dailyApplicationCounter.updateMany({ where: { userId }, data: { day: "2000-01-01" } });
    await prisma.application.updateMany({ where: { userId, status: "APPROVED" }, data: { nextActionAt: new Date(Date.now() - 60_000) } });

    const run = await automationOrchestrator.runForUser(userId, "manual");
    expect(run?.status).toBe("COMPLETED");

    expect(await byStatus("APPLIED")).toHaveLength(6);
    expect(await byStatus("APPROVED")).toHaveLength(0);
    const counters = await prisma.dailyApplicationCounter.findMany({ where: { userId }, orderBy: { day: "asc" } });
    expect(counters.map((c) => [c.day, c.count])).toEqual([
      ["2000-01-01", LIMIT],
      [dayKey(new Date(), TZ), 6 - LIMIT],
    ]);
    // One submission per canonical job, ever.
    const keys = await prisma.applicationExecution.groupBy({ by: ["idempotencyKey"], where: { userId }, _count: true });
    expect(keys).toHaveLength(6);
    expect(keys.every((k) => k._count === 1)).toBe(true);
    expect(await prisma.applicationExecution.count({ where: { userId, status: "SUCCEEDED" } })).toBe(6);
  }, SLOW);
});
