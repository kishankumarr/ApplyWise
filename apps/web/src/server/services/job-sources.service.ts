import "server-only";
import { prisma } from "@applywise/database";
import { providerInfos } from "@applywise/job-engine";
import type { ProviderInfo, ProviderSourceCard, SourceCardStatus } from "@applywise/types";
import { automationSettingsService } from "./automation-settings.service";
import { demoProviderEnabled } from "./job-feeds.service";
import { providerConnectionsService } from "./provider-connections.service";

/**
 * Settings -> Job sources: one card per provider with its honest capability status for this server, the user's
 * connection (never the secret) and the automatic sources (JobFeed) that use it.
 */

/** JobFeed.provider values that belong to a registry provider. */
function providerOfFeed(feedProvider: string): string {
  return ["imap", "gmail", "outlook", "microsoft", "forwarding"].includes(feedProvider) ? "job_alert_email" : feedProvider;
}

function cardStatus(info: ProviderInfo, connection: ProviderSourceCard["connection"], feeds: { status: string }[]): SourceCardStatus {
  if (connection && (connection.status === "NEEDS_AUTHENTICATION" || connection.status === "NEEDS_ATTENTION")) return "NEEDS_AUTHENTICATION";
  if (connection?.status === "ERROR" || feeds.some((f) => f.status === "NEEDS_ATTENTION" || f.status === "ERROR")) return "ERROR";
  const { DISCOVERY, AUTO_APPLY } = info.capabilities;
  if ((info.auth === "api_key" || info.auth === "oauth_token") && AUTO_APPLY.status === "SUPPORTED" && !connection) return "NEEDS_AUTHENTICATION";
  if (connection?.status === "CONNECTED") return "CONNECTED";
  if (feeds.length && DISCOVERY.status !== "NOT_CONFIGURED") return info.manualOnly ? "LIMITED" : "WORKING";
  if (DISCOVERY.status === "NOT_CONFIGURED" && AUTO_APPLY.status !== "SUPPORTED") return "NOT_CONFIGURED";
  if (info.manualOnly && DISCOVERY.status !== "AVAILABLE") return "MANUAL_ONLY";
  if (DISCOVERY.status === "LIMITED" || AUTO_APPLY.status === "EXPERIMENTAL" || AUTO_APPLY.status === "LIMITED") return "LIMITED";
  return info.manualOnly ? "MANUAL_ONLY" : "WORKING";
}

export const jobSourcesService = {
  async cards(userId: string): Promise<ProviderSourceCard[]> {
    const { settings } = await automationSettingsService.ensure(userId);
    const [connections, feeds, jobCounts] = await Promise.all([
      providerConnectionsService.list(userId),
      prisma.jobFeed.findMany({ where: { userId }, select: { provider: true, status: true } }),
      prisma.jobFeed.findMany({ where: { userId }, select: { provider: true, _count: { select: { jobs: true } } } }),
    ]);
    return providerInfos(process.env)
      .filter((p) => p.id !== "demo" || demoProviderEnabled())
      .map((info) => {
        const ownFeeds = feeds.filter((f) => providerOfFeed(f.provider) === info.id);
        const connection = connections[info.id] ?? null;
        return {
          ...info,
          cardStatus: cardStatus(info, connection, ownFeeds),
          enabledForAutomation: settings.enabledProviders.length === 0 || settings.enabledProviders.includes(info.id),
          connection,
          feeds: ownFeeds.length,
          jobsFound: jobCounts.filter((f) => providerOfFeed(f.provider) === info.id).reduce((n, f) => n + f._count.jobs, 0),
        };
      });
  },
};
