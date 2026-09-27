import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@applywise/database";
import { automationOrchestrator } from "@/server/services/automation-orchestrator.service";
import { jobSourcesService } from "@/server/services/job-sources.service";
import { connectDemo, disableTrackedUsers, enableAutomation, importDemoJobs, onboardedUser } from "./automation-helpers";

/**
 * An expired provider session in AUTO mode (demo provider, API-key connection with an expiry): the connection moves to
 * NEEDS_ATTENTION with a single notification and nothing is submitted. Approved applications for that provider are
 * held ("paused until you reconnect") - not handed off one by one - and go out by themselves after reconnecting.
 */

const SLOW = 180_000;
const demoConnection = (userId: string) => prisma.providerConnection.findUniqueOrThrow({ where: { userId_provider: { userId, provider: "demo" } } });
const reconnectNotices = (userId: string) => prisma.notification.count({ where: { userId, type: "provider.needs_attention" } });
const isPaused = (a: { status: string; manualActionReason: string | null; nextActionAt: Date | null }) => a.status === "APPROVED" && a.manualActionReason === "LOGIN_REQUIRED" && a.nextActionAt === null;

afterAll(disableTrackedUsers);

describe("expired provider session", () => {
  it("holds approved applications while the connection needs attention (one notice, nothing sent) and resumes them on reconnect", async () => {
    const userId = await onboardedUser("expired");
    await enableAutomation(userId, "AUTO", {}, "none");
    await connectDemo(userId, new Date(Date.now() + 3_600_000));
    await importDemoJobs(userId, ["aw-sceneforge-scene-editor", "aw-flowkit-automation-builder"]);
    // The token expires before the automation gets to use it.
    await prisma.providerConnection.update({ where: { userId_provider: { userId, provider: "demo" } }, data: { expiresAt: new Date(Date.now() - 1_000) } });

    const run = await automationOrchestrator.runForUser(userId, "manual");
    expect(run).toMatchObject({ status: "COMPLETED", autoEligible: 2, applicationsPrepared: 2, applicationsSubmitted: 0 });

    const connection = await demoConnection(userId);
    expect(connection.status).toBe("NEEDS_ATTENTION");
    expect(connection.lastError).toMatch(/expired/i);
    expect(await reconnectNotices(userId)).toBe(1);

    const apps = await prisma.application.findMany({ where: { userId } });
    expect(apps).toHaveLength(2);
    for (const a of apps) {
      expect(a).toMatchObject({ manualActionReason: "LOGIN_REQUIRED", appliedAt: null, externalApplicationId: null });
      // Held by the execution service, or routed to the user before any approval (the routing's decision).
      expect(isPaused(a) || a.status === "MANUAL_ACTION_REQUIRED").toBe(true);
    }
    // The first application was approved and reached the execution service, which found the expired token before
    // claiming anything: it is held, with no per-application "apply manually" notification.
    const paused = apps.filter(isPaused);
    expect(paused.length).toBeGreaterThanOrEqual(1);
    for (const a of paused) {
      expect(a.manualActionDetail).toMatch(/Paused until you reconnect/);
      expect(await prisma.notification.count({ where: { userId, type: "application.manual_action_required", dedupeKey: { startsWith: `manual:${a.id}` } } })).toBe(0);
    }
    // Nothing was claimed, sent or counted.
    expect(await prisma.applicationExecution.count({ where: { userId } })).toBe(0);
    expect(await prisma.applicationEvent.count({ where: { userId, type: "execute_succeeded" } })).toBe(0);
    expect((await prisma.dailyApplicationCounter.findMany({ where: { userId } })).reduce((n, c) => n + c.count, 0)).toBe(0);
    // Job sources show the demo source as needing re-authentication.
    expect((await jobSourcesService.cards(userId)).find((c) => c.id === "demo")?.cardStatus).toBe("NEEDS_AUTHENTICATION");

    // A later run with a new job does not notify again (and does not submit).
    await importDemoJobs(userId, ["aw-uploadly-media-uploads"]);
    const run2 = await automationOrchestrator.runForUser(userId, "manual");
    expect(run2).toMatchObject({ status: "COMPLETED", applicationsSubmitted: 0 });
    expect(await reconnectNotices(userId)).toBe(1);
    expect(await prisma.applicationExecution.count({ where: { userId, status: "SUCCEEDED" } })).toBe(0);

    // Reconnecting resumes every held application by itself (inline queue: they are submitted right away).
    const held = (await prisma.application.findMany({ where: { userId } })).filter(isPaused).map((a) => a.id);
    expect(held.length).toBeGreaterThanOrEqual(1);
    await connectDemo(userId);
    expect((await demoConnection(userId)).status).toBe("CONNECTED");
    for (const id of held) {
      expect(await prisma.application.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "APPLIED", manualActionReason: null });
    }
    expect(await prisma.applicationExecution.count({ where: { userId, status: "SUCCEEDED" } })).toBe(held.length);
    // Applications handed to the user before any approval are never submitted by a reconnect.
    for (const a of await prisma.application.findMany({ where: { userId, id: { notIn: held } } })) expect(a.status).toBe("MANUAL_ACTION_REQUIRED");
    expect(await reconnectNotices(userId)).toBe(1);
    expect((await prisma.dailyApplicationCounter.findMany({ where: { userId } })).reduce((n, c) => n + c.count, 0)).toBe(held.length);
  }, SLOW);
});
