import "server-only";
import { prisma } from "@applywise/database";
import type { DashboardSummary } from "@applywise/types";
import { automationSettingsService, effectiveDailyLimit } from "./automation-settings.service";
import { dailyLimitService } from "./daily-limit.service";

/** Start of the user's local day as a UTC instant (minute precision is enough for dashboard counts). */
function startOfLocalDay(now: Date, timeZone: string): Date {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const p = Object.fromEntries(fmt.formatToParts(now).map((x) => [x.type, x.value]));
  const minutes = (Number(p.hour) % 24) * 60 + Number(p.minute);
  return new Date(now.getTime() - minutes * 60_000 - now.getSeconds() * 1000 - now.getMilliseconds());
}

export const dashboardService = {
  async summary(userId: string, now = new Date()): Promise<DashboardSummary> {
    const { settings } = await automationSettingsService.ensure(userId);
    const today = startOfLocalDay(now, settings.timezone);
    const weekAgo = new Date(today.getTime() - 6 * 86_400_000);
    const sentWhere = (since: Date) => ({
      userId,
      OR: [{ appliedAt: { gte: since } }, { submittedAt: { gte: since } }, { emailSentAt: { gte: since } }],
    });
    const [discovered, newMatches, strong, appliedToday, appliedWeek, byStatus] = await Promise.all([
      prisma.job.count({ where: { ownerUserId: userId, createdAt: { gte: today } } }),
      prisma.jobMatchScore.count({ where: { userId, score: { gte: settings.minMatchScore }, job: { ownerUserId: userId, createdAt: { gte: today } } } }),
      prisma.jobMatchScore.count({ where: { userId, score: { gte: 90 }, job: { ownerUserId: userId, NOT: { states: { some: { userId, ignored: true } } } } } }),
      prisma.application.count({ where: sentWhere(today) }),
      prisma.application.count({ where: sentWhere(weekAgo) }),
      prisma.application.groupBy({ by: ["status"], where: { userId }, _count: true }),
    ]);
    const count = (...s: string[]) => byStatus.filter((b) => s.includes(b.status)).reduce((n, b) => n + b._count, 0);
    // The atomic counter is authoritative for "today" when it is higher (it also counts in-flight submissions).
    const counter = await dailyLimitService.countToday(userId, settings.timezone, now);
    return {
      jobsDiscoveredToday: discovered,
      newMatches,
      strongMatches: strong,
      applicationsToday: Math.max(appliedToday, counter),
      applicationsThisWeek: appliedWeek,
      waitingApproval: count("WAITING_APPROVAL", "READY_FOR_REVIEW"),
      needsInformation: count("NEEDS_INFORMATION"),
      manualActionRequired: count("MANUAL_ACTION_REQUIRED", "FAILED"),
      interviews: count("INTERVIEW"),
      assessments: count("ASSESSMENT"),
      offers: count("OFFER"),
      rejections: count("REJECTED"),
      automation: {
        enabled: settings.enabled,
        mode: settings.mode,
        lastRunAt: settings.lastRunAt?.toISOString() ?? null,
        nextRunAt: settings.enabled ? (settings.nextRunAt?.toISOString() ?? null) : null,
        dailyLimit: effectiveDailyLimit(settings),
      },
    };
  },
};
