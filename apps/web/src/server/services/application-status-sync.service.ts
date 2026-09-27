import "server-only";
import { prisma, type ApplicationStatus, type Prisma } from "@applywise/database";
import { applicationProviderForJob, type ProviderApplicationStatus, type ProviderEnv, type ProviderJobRef, type StatusCheckResult } from "@applywise/job-engine";
import { audit } from "../audit";
import { sha256Hex } from "../crypto";
import { canTransition } from "../domain/application-state";
import { AppError } from "../errors";
import { logger } from "../logger";
import { applicationEmailTrackingService, notifyApplicationStatus } from "./application-email-tracking.service";
import { transitionApplication } from "./application-transitions";

/**
 * Provider status sync.
 *
 * For sent applications with an external application id whose provider implements checkApplicationStatus
 * (STATUS_TRACKING), asks the provider for the current status and moves the application (status_update, actor
 * "system") when the state machine allows it. An employer message attached to the result (the demo provider
 * simulates recruiter emails this way) goes through email tracking first, so the classifier and the association
 * run on it exactly as on a real email. Checks run at most every 6 hours per application; demo jobs every 10 minutes
 * (their simulated employer replies should arrive during a demo, without re-checking every scheduler tick).
 */

/** Applications whose employer-side status can still change. */
const SYNC_STATUSES: ApplicationStatus[] = ["APPLIED", "SUBMITTED", "ASSESSMENT", "INTERVIEW"];
export const STATUS_SYNC_INTERVAL_MS = 6 * 60 * 60_000;
export const DEMO_STATUS_SYNC_INTERVAL_MS = 10 * 60_000;
/** Provider calls per user per run (the rest is picked up by the next run, oldest check first). */
const MAX_CHECKS_PER_RUN = 50;

const PROVIDER_STATUS_MAP: Partial<Record<ProviderApplicationStatus, ApplicationStatus>> = {
  ASSESSMENT: "ASSESSMENT",
  INTERVIEW: "INTERVIEW",
  REJECTED: "REJECTED",
  OFFER: "OFFER",
};

function dueWhere(now: Date, force: boolean): Prisma.ApplicationWhereInput {
  return {
    status: { in: SYNC_STATUSES },
    externalApplicationId: { not: null },
    ...(force
      ? {}
      : {
          OR: [
            { lastStatusSyncAt: null },
            { lastStatusSyncAt: { lte: new Date(now.getTime() - STATUS_SYNC_INTERVAL_MS) } },
            { job: { isDemo: true }, lastStatusSyncAt: { lte: new Date(now.getTime() - DEMO_STATUS_SYNC_INTERVAL_MS) } },
          ],
        }),
  };
}

function providerEnv(): ProviderEnv {
  return process.env as Record<string, string | undefined>;
}

function validDate(iso: string | null | undefined, fallback: Date): Date {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime()) ? d : fallback;
}

async function markChecked(userId: string, applicationId: string, now: Date): Promise<void> {
  await prisma.application.updateMany({ where: { id: applicationId, userId }, data: { lastStatusSyncAt: now } });
}

export const applicationStatusSyncService = {
  async syncUser(userId: string, opts: { force?: boolean } = {}): Promise<{ checked: number; updated: number; messages: number; failed: number }> {
    const now = new Date();
    const apps = await prisma.application.findMany({
      where: { userId, ...dueWhere(now, opts.force === true) },
      select: {
        id: true,
        status: true,
        externalApplicationId: true,
        appliedAt: true,
        submittedAt: true,
        createdAt: true,
        job: {
          select: {
            id: true,
            platform: true,
            title: true,
            company: true,
            applyMethod: true,
            applyUrl: true,
            sourceUrl: true,
            sourceExternalId: true,
            hrEmail: true,
            isDemo: true,
            feed: { select: { provider: true } },
            sources: { orderBy: { createdAt: "asc" }, take: 1, select: { metadata: true } },
          },
        },
      },
      orderBy: { lastStatusSyncAt: { sort: "asc", nulls: "first" } },
      take: MAX_CHECKS_PER_RUN,
    });

    let checked = 0;
    let updated = 0;
    let messages = 0;
    let failed = 0;
    for (const app of apps) {
      const job = app.job;
      const ref: ProviderJobRef = {
        jobId: job.id,
        platform: job.platform,
        title: job.title,
        company: job.company,
        applyMethod: job.applyMethod,
        applyUrl: job.applyUrl,
        sourceUrl: job.sourceUrl,
        sourceExternalId: job.sourceExternalId,
        hrEmail: job.hrEmail,
        isDemo: job.isDemo,
        feedProvider: job.feed?.provider ?? null,
        sourceMetadata: (job.sources[0]?.metadata ?? {}) as Record<string, unknown>,
      };
      let providerId = "unknown";
      let result: StatusCheckResult;
      try {
        const provider = applicationProviderForJob(ref);
        providerId = provider.id;
        if (!provider.checkApplicationStatus) {
          // No status tracking for this provider: nothing to ask (checked again after the interval).
          await markChecked(userId, app.id, now);
          continue;
        }
        checked++;
        result = await provider.checkApplicationStatus(
          { externalApplicationId: app.externalApplicationId!, job: ref, appliedAt: app.appliedAt ?? app.submittedAt ?? app.createdAt },
          { env: providerEnv(), now },
        );
      } catch (e) {
        failed++;
        logger.warn("status_sync.check_failed", { userId, applicationId: app.id, providerId, error: e instanceof Error ? e.name : "unknown" });
        await markChecked(userId, app.id, now);
        continue;
      }

      // The employer's message first: email tracking classifies it, associates it and may move the application.
      if (result.message) {
        messages++;
        const m = result.message;
        const subjectKey = sha256Hex(m.subject ?? "").slice(0, 16);
        try {
          const ingested = await applicationEmailTrackingService.ingest(
            userId,
            {
              // Stable per application + reported status: a repeated check never stores the same message twice.
              messageId: `status-sync:${providerId}:${app.id}:${result.status}:${subjectKey}`,
              from: m.from ?? "",
              subject: m.subject ?? "",
              text: m.text ?? "",
              receivedAt: validDate(m.receivedAt, now),
            },
            job.isDemo ? "demo" : "mailbox",
          );
          if (ingested.statusApplied && ingested.applicationId === app.id) updated++;
        } catch (e) {
          // The provider's status below still applies; the message is retried with the next check.
          logger.warn("status_sync.message_failed", { userId, applicationId: app.id, providerId, error: e instanceof Error ? e.name : "unknown" });
        }
      }

      // Then the provider's own status, when it is still ahead of the application.
      const target = PROVIDER_STATUS_MAP[result.status];
      const current = (await prisma.application.findFirst({ where: { id: app.id, userId }, select: { status: true } }))?.status;
      if (target && current && current !== target && canTransition(current, "status_update", target)) {
        try {
          await transitionApplication(userId, app.id, "status_update", {
            to: target,
            from: [current],
            actor: "system",
            message: `Status reported by the provider: ${target.toLowerCase()}`,
            data: { lastStatusSyncAt: now },
            metadata: { providerId, providerStatus: result.status },
          });
          updated++;
          // Keyed by the transition: a repeated report of the same change never notifies twice, but a genuine later
          // change to the same status (e.g. a second interview round after an assessment) does.
          await notifyApplicationStatus(userId, { id: app.id, title: job.title, company: job.company }, target, {
            dedupeKey: `status:${app.id}:${current}->${target}`,
            via: job.isDemo ? "The demo provider" : "The job provider",
          });
          await audit(userId, "application.status_detected", { entityType: "Application", entityId: app.id, metadata: { via: "provider_status", providerId, status: target } });
        } catch (e) {
          // Changed concurrently (e.g. by the user): their change wins.
          if (!(e instanceof AppError)) throw e;
        }
      }
      await markChecked(userId, app.id, now);
    }
    if (apps.length) logger.info("status_sync.completed", { userId, due: apps.length, checked, updated, messages, failed });
    return { checked, updated, messages, failed };
  },

  /** Users with sent applications due for a status check (for the scheduler); never-checked ones first. */
  async dueUsers(now = new Date(), limit = 50): Promise<string[]> {
    const where = dueWhere(now, false);
    const never = await prisma.application.groupBy({ by: ["userId"], where: { ...where, lastStatusSyncAt: null }, orderBy: { userId: "asc" }, take: limit });
    const users = never.map((r) => r.userId);
    if (users.length >= limit) return users;
    const rest = await prisma.application.groupBy({
      by: ["userId"],
      where: { ...where, userId: { notIn: users }, lastStatusSyncAt: { not: null } },
      _min: { lastStatusSyncAt: true },
      orderBy: { _min: { lastStatusSyncAt: "asc" } },
      take: limit - users.length,
    });
    return [...users, ...rest.map((r) => r.userId)];
  },
};
