import { afterAll, describe, expect, it } from "vitest";
import { prisma, recomputeMatchScores } from "@applywise/database";
import { applicationExecutionService } from "@/server/services/application-execution.service";
import { transitionApplication } from "@/server/services/application-transitions";
import { applicationService } from "@/server/services/application.service";
import { automationSettingsService } from "@/server/services/automation-settings.service";
import { prefillBlockedReason } from "@/server/services/extension.service";
import { profileRepo } from "@/server/repositories/profile.repo";
import { bareUser, disableTrackedUsers, enableAutomation, fabricateApp } from "./automation-helpers";

/**
 * Regression tests for the residual paths found when re-checking the review fixes:
 *  - an application whose last attempt may already have reached the employer is never touched by automatic tasks, and
 *    only a user retry that explicitly acknowledges the uncertainty resubmits it (re-stamping the approval);
 *  - the approval an attempt was checked against must still be current when it moves to APPLYING;
 *  - the AUTO policy never acts on a decision made before a profile/preference change;
 *  - a scheduled automatic retry keeps the extension from offering a manual handoff.
 */

afterAll(disableTrackedUsers);

describe("uncertain submissions", () => {
  it("are never touched by automatic tasks and are retried only after an explicit acknowledgement", async () => {
    const userId = await bareUser("uncertain", { profile: true });
    await enableAutomation(userId, "AUTO", {}, "none");
    const { appId } = await fabricateApp(userId, { status: "MANUAL_ACTION_REQUIRED", mode: "AUTO" });
    const oldApproval = new Date(Date.now() - 60_000);
    await prisma.application.update({ where: { id: appId }, data: { manualActionReason: "SUBMISSION_UNCERTAIN", manualActionDetail: "No confirmation after submit.", approvedAt: oldApproval, approvalSource: "user" } });

    // A leftover automatic retry (with or without the approval stamp) leaves it alone.
    for (const stamp of [undefined, oldApproval.toISOString()]) {
      const r = await applicationExecutionService.execute(userId, appId, { retry: true, approvedAt: stamp });
      expect(r.outcome).toBe("SKIPPED");
    }
    let row = await prisma.application.findUniqueOrThrow({ where: { id: appId } });
    expect(row).toMatchObject({ status: "MANUAL_ACTION_REQUIRED", manualActionReason: "SUBMISSION_UNCERTAIN" });

    // The user must say they checked it was not received.
    await expect(applicationService.applyNow(userId, appId, { retry: true })).rejects.toMatchObject({ code: "INVALID_STATE" });
    row = await prisma.application.findUniqueOrThrow({ where: { id: appId } });
    expect(row.manualActionReason).toBe("SUBMISSION_UNCERTAIN");

    // Acknowledged: the lock is lifted and the approval re-stamped, so older deferred tasks can no longer run.
    await applicationService.applyNow(userId, appId, { retry: true, acknowledgeUncertain: true });
    row = await prisma.application.findUniqueOrThrow({ where: { id: appId } });
    expect(row.manualActionReason).not.toBe("SUBMISSION_UNCERTAIN");
    expect(row.approvedAt!.getTime()).toBeGreaterThan(oldApproval.getTime());
    const stale = await applicationExecutionService.execute(userId, appId, { retry: true, approvedAt: oldApproval.toISOString() });
    expect(stale.outcome).toBe("SKIPPED");
  });
});

describe("approval fencing", () => {
  it("does not move an application to APPLYING when its approval changed since it was checked", async () => {
    const userId = await bareUser("fence", { profile: true });
    const { appId } = await fabricateApp(userId, { status: "APPROVED", mode: "REVIEW" });
    await expect(
      transitionApplication(userId, appId, "execute_started", { actor: "executor", message: "test", from: ["APPROVED"], expect: { approvedAt: new Date(0) } }),
    ).rejects.toMatchObject({ status: 409 });
    expect((await prisma.application.findUniqueOrThrow({ where: { id: appId } })).status).toBe("APPROVED");
  });
});

describe("stale automation decisions", () => {
  it("returns a policy approval to the user when the profile changed after the job was evaluated", async () => {
    const userId = await bareUser("stale", { profile: true });
    await enableAutomation(userId, "AUTO", {}, "none");
    const { settings } = await automationSettingsService.ensure(userId);

    const fresh = await fabricateApp(userId, { status: "APPROVED", mode: "AUTO" });
    const stale = await fabricateApp(userId, { status: "APPROVED", mode: "AUTO" });
    await recomputeMatchScores(prisma, userId, [fresh.jobId, stale.jobId]);
    const evaluatedAt = new Date();
    await prisma.application.updateMany({ where: { id: { in: [fresh.appId, stale.appId] } }, data: { automationDecision: "AUTO_ELIGIBLE", rulesVersion: settings.rulesVersion, evaluatedAt } });

    // Control: the unchanged decision is acted on (this fixture's career page has no automatic executor -> handoff).
    const ok = await applicationExecutionService.execute(userId, fresh.appId);
    expect(ok.outcome).toBe("MANUAL_ACTION_REQUIRED");

    // A verified fact / preference changed: the stored AUTO_ELIGIBLE decision no longer counts.
    await profileRepo.bumpFactsVersion(userId);
    const r = await applicationExecutionService.execute(userId, stale.appId);
    expect(r.outcome).not.toBe("APPLIED");
    const row = await prisma.application.findUniqueOrThrow({ where: { id: stale.appId } });
    expect(row.status).toBe("WAITING_APPROVAL");
    expect(row.approvalSource).toBeNull();
    const events = await prisma.applicationEvent.findMany({ where: { applicationId: stale.appId }, orderBy: { createdAt: "desc" }, take: 1 });
    expect(events[0]!.message).toMatch(/profile or preferences changed/);
  });
});

describe("manual handoff while an automatic retry is scheduled", () => {
  it("is refused for FAILED and MANUAL_ACTION_REQUIRED alike", () => {
    const at = new Date(Date.now() + 60_000);
    for (const status of ["FAILED", "MANUAL_ACTION_REQUIRED"] as const) {
      expect(prefillBlockedReason({ status, mode: "REVIEW", nextActionAt: at })).toMatch(/automatic retry is scheduled/);
      expect(prefillBlockedReason({ status, mode: "REVIEW", nextActionAt: null })).toBeNull();
      expect(prefillBlockedReason({ status, mode: null, nextActionAt: at })).toBeNull();
    }
  });
});
