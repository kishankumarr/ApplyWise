import "server-only";
import { prisma, recomputeMatchScores } from "@applywise/database";
import { generateApplicationEmail } from "@applywise/ai";
import { logger } from "../logger";
import { applicationService } from "../services/application.service";
import { applicationExecutionService } from "../services/application-execution.service";
import { applicationStatusSyncService } from "../services/application-status-sync.service";
import { automationOrchestrator } from "../services/automation-orchestrator.service";
import { aiConfigFor, buildGenerationContext } from "../services/context.service";
import { emailService } from "../services/email.service";
import { emailVerificationService } from "../services/email-verification.service";
import { jobFeedsService } from "../services/job-feeds.service";
import { notificationService } from "../services/notification.service";
import { resumeService } from "../services/resume.service";
import { registerHandler } from "./index";

const requireUser = (userId: string | null): string => {
  if (!userId) throw new Error("Task requires a user");
  return userId;
};

registerHandler("cv.parse", async (p, ctx) => {
  await resumeService.runParse(requireUser(ctx.userId), String(p.resumeId), p.requestId as string | undefined);
});

registerHandler("job.match", async (p, ctx) => {
  const userId = requireUser(ctx.userId);
  await recomputeMatchScores(prisma, userId, Array.isArray(p.jobIds) ? (p.jobIds as string[]) : undefined);
});

// Normalisation happens synchronously on import; this task re-normalises on demand.
registerHandler("job.normalize", async (p, ctx) => {
  const userId = requireUser(ctx.userId);
  await recomputeMatchScores(prisma, userId, [String(p.jobId)]);
});

registerHandler("application.prepare", async (p, ctx) => {
  await applicationService.runPrepare(requireUser(ctx.userId), String(p.applicationId), p.requestId as string | undefined);
});

registerHandler("email.draft", async (p, ctx) => {
  const userId = requireUser(ctx.userId);
  const app = await prisma.application.findFirst({ where: { id: String(p.applicationId), userId }, include: { tailoredResume: true, job: true } });
  if (!app?.job.hrEmail) return;
  const gctx = await buildGenerationContext(userId, app.jobId);
  const draft = await generateApplicationEmail(gctx, app.tailoredResume?.editedSummary ?? null, { logger, config: await aiConfigFor(userId), hasCoverLetter: true });
  await prisma.applicationEmailDraft.upsert({
    where: { applicationId: app.id },
    create: { userId, applicationId: app.id, to: app.job.hrEmail, subject: draft.data.subject, body: draft.data.body, originalBody: draft.data.body, provider: draft.meta.provider, modelId: draft.meta.modelId, promptVersion: draft.meta.promptVersion },
    update: { subject: draft.data.subject, body: draft.data.body, originalBody: draft.data.body, status: "DRAFT", previewDigest: null, provider: draft.meta.provider, modelId: draft.meta.modelId, promptVersion: draft.meta.promptVersion },
  });
});

registerHandler("feeds.sync", async (p) => {
  await jobFeedsService.runSync(String(p.feedId), String(p.trigger ?? "schedule"));
});

registerHandler("email.verification", async (p, ctx) => {
  await emailVerificationService.send(requireUser(ctx.userId), (p.requestId as string | null) ?? undefined);
});

registerHandler("email.send", async (p, ctx) => {
  await emailService.runSend(requireUser(ctx.userId), String(p.applicationId), String(p.token), p.requestId as string | undefined);
});

registerHandler("reminder.dispatch", async (p, ctx) => {
  await applicationService.dispatchReminder(requireUser(ctx.userId), String(p.applicationId));
});

// ---------------------------------------------------------------- automation
// Handlers stay thin: all business logic lives in the domain services.

registerHandler("automation.run", async (p, ctx) => {
  const trigger = p.trigger === "manual" || p.trigger === "demo" ? p.trigger : "schedule";
  await automationOrchestrator.runForUser(requireUser(ctx.userId), trigger, { runId: typeof p.runId === "string" ? p.runId : undefined });
});

registerHandler("application.evaluate", async (p, ctx) => {
  await automationOrchestrator.resumeApplication(requireUser(ctx.userId), String(p.applicationId));
});

registerHandler("application.execute", async (p, ctx) => {
  await applicationExecutionService.execute(requireUser(ctx.userId), String(p.applicationId), {
    runId: typeof p.runId === "string" ? p.runId : null,
    retry: p.retry === true,
    // Deferred tasks carry the approval they were scheduled under; a changed approval makes them skip.
    approvedAt: typeof p.approvedAt === "string" ? p.approvedAt : null,
  });
});

registerHandler("application.status_sync", async (_p, ctx) => {
  await applicationStatusSyncService.syncUser(requireUser(ctx.userId));
});

registerHandler("notification.dispatch", async () => {
  await notificationService.dispatchDue();
});

registerHandler("summary.daily", async (_p, ctx) => {
  await automationOrchestrator.dailySummary(requireUser(ctx.userId));
});

registerHandler("execution.recover", async () => {
  await applicationExecutionService.recoverStale();
});
