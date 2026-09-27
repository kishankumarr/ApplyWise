import "server-only";
import { randomBytes } from "node:crypto";
import { prisma } from "@applywise/database";
import type { AutomationRunSummary } from "@applywise/types";
import { Errors } from "../errors";
import { automationOrchestrator } from "./automation-orchestrator.service";
import { demoProviderEnabled, jobFeedsService } from "./job-feeds.service";
import { providerConnectionsService } from "./provider-connections.service";

/**
 * Demo of the automation pipeline without real job-platform accounts (DEMO CONTENT).
 *
 * Adds the fictional demo provider as an automatic source and connects it with a demo token; the run itself is
 * the real pipeline (feed sync -> normalise/dedupe/merge -> deterministic match -> rules -> preparation from
 * verified facts -> routing -> executor). Only the remote provider is simulated. The user's automation settings
 * (mode, thresholds, consent) are never changed here.
 */
export const demoAutomationService = {
  async setup(userId: string, opts: { run?: boolean } = {}, requestId?: string): Promise<{ feedId: string; connected: boolean; run: AutomationRunSummary | null }> {
    if (!demoProviderEnabled()) throw Errors.providerNotConfigured("The demo provider is disabled on this server.");
    const existing = await prisma.jobFeed.findFirst({ where: { userId, kind: "DEMO" }, select: { id: true } });
    const feedId = existing?.id ?? (await jobFeedsService.createDemo(userId, requestId)).id;
    const connection = await providerConnectionsService.statusFor(userId, "demo");
    if (!connection || connection.status !== "CONNECTED") {
      await providerConnectionsService.connect(userId, "demo", { token: `demo-${randomBytes(12).toString("hex")}`, accountLabel: "Demo account (fictional)" }, requestId);
    }
    const run = opts.run === false ? null : await automationOrchestrator.runNow(userId, "demo", requestId);
    return { feedId, connected: true, run };
  },
};
