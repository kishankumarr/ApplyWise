import "server-only";
import { prisma } from "@applywise/database";
import { audit } from "../audit";
import { anonymize, decryptText } from "../crypto";
import { Errors } from "../errors";
import { logger } from "../logger";
import { getStorage, userPrefix } from "../storage";

export const accountService = {
  /** GET /api/account/export - everything we hold about the user, as JSON. */
  async export(userId: string, requestId?: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        createdAt: true,
        consents: true,
        profile: { include: { preference: true, truthBankItems: true, experiences: true, educations: true, projects: true, skills: true } },
        resumes: { select: { id: true, originalFileName: true, mimeType: true, sizeBytes: true, status: true, createdAt: true, extractedTextEnc: true, parserProvider: true, parserVersion: true } },
        resumeVersions: true,
        ownedJobs: { select: { id: true, title: true, company: true, importMethod: true, sourceUrl: true, createdAt: true } },
        jobStates: true,
        questionnaires: { include: { questions: { include: { answer: true } } } },
        applications: { include: { events: true, tailoredResume: true, coverLetter: true, screeningDrafts: true, emailDraft: true } },
        notifications: true,
        auditLogs: { orderBy: { createdAt: "desc" }, take: 1000 },
        extensionTokens: { select: { id: true, name: true, createdAt: true, lastUsedAt: true, expiresAt: true, revokedAt: true } },
        // Automatic job sources without credentials or provider cursors.
        jobFeeds: { select: { id: true, kind: true, provider: true, label: true, config: true, status: true, lastSyncAt: true, createdAt: true } },
        // Automation: settings, rules, runs, submissions, reusable answers, status emails (metadata only) and provider
        // connections - never the encrypted credential.
        automationSettings: true,
        automationRule: true,
        automationRuns: { orderBy: { startedAt: "desc" }, take: 200, include: { items: { take: 2000 } } },
        applicationExecutions: true,
        candidateAnswers: true,
        applicationMessages: true,
        dailyApplicationCounters: true,
        providerConnections: { select: { id: true, provider: true, authType: true, status: true, accountLabel: true, expiresAt: true, lastCheckedAt: true, lastError: true, createdAt: true } },
      },
    });
    if (!user) throw Errors.notFound("Account");
    const jobFeeds = user.jobFeeds.map((f) => {
      const { token: _token, ...config } = f.config as Record<string, unknown>;
      return { ...f, config };
    });
    const resumes = user.resumes.map(({ extractedTextEnc, ...r }) => ({ ...r, extractedText: extractedTextEnc ? decryptText(extractedTextEnc) : null }));
    await audit(userId, "account.exported", { requestId });
    return { exportedAt: new Date().toISOString(), format: "applywise-export-v1", ...user, resumes, jobFeeds };
  },

  /**
   * POST /api/account/delete - delete stored files, then the user row (all personal data
   * cascades). A single anonymised audit record is kept to evidence the deletion.
   */
  async delete(userId: string, requestId?: string) {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) throw Errors.notFound("Account");
    try {
      await getStorage().deletePrefix(userPrefix(userId));
    } catch (e) {
      logger.error("account.delete.storage_failed", { requestId, error: e instanceof Error ? e.message : "unknown" });
      throw e;
    }
    // Revoke mailbox access we hold before the encrypted tokens are deleted with the account.
    const { jobFeedsService } = await import("./job-feeds.service");
    await jobFeedsService.revokeAll(userId).catch((e: unknown) => logger.warn("account.delete.revoke_failed", { requestId, error: e instanceof Error ? e.name : "unknown" }));
    await prisma.user.delete({ where: { id: userId } });
    await audit(null, "account.deleted", { requestId, metadata: { subject: anonymize(userId) } });
    return { deleted: true };
  },
};
