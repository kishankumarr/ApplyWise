import "server-only";
import { prisma, type Prisma } from "@applywise/database";
import { logger } from "../logger";
import { dayKey, inQuietHours, quietHoursEndAt } from "./automation-time";

/**
 * Single entry point for in-app notifications (reuses the Notification table).
 *
 * - dedupeKey makes notifications idempotent: a retried task or an overlapping scheduler never notifies twice.
 * - During the user's quiet hours a notification is created with scheduledFor = end of quiet hours; the
 *   notification.dispatch task releases it then (the API hides scheduled notifications until they are due).
 * - accumulate() keeps one notification per key that is updated in place (e.g. "12 new jobs" for one day).
 */

export type NotificationType =
  | "jobs.new_matches"
  | "feeds.needs_attention"
  | "feeds.forwarding_confirmation"
  | "application.reminder"
  | "automation.strong_match"
  | "automation.daily_summary"
  | "automation.run_failed"
  | "application.approval_required"
  | "application.information_required"
  | "application.manual_action_required"
  | "application.submitted"
  | "application.failed"
  | "application.recruiter_response"
  | "application.assessment"
  | "application.interview"
  | "application.offer"
  | "application.rejected"
  | "provider.needs_attention";

export interface NotifyInput {
  type: NotificationType;
  title: string;
  body: string;
  link?: string | null;
  dedupeKey?: string | null;
  /** Defer to the end of quiet hours (default true). Security-relevant notices pass false. */
  respectQuietHours?: boolean;
}

/** Timezone for users without automation settings (the AutomationSettings default). */
const DEFAULT_TIMEZONE = "Asia/Kolkata";

/** Only notifications that are due are visible (quiet-hour ones appear when released). */
export function visibleNotificationsWhere(userId: string, now = new Date()): Prisma.NotificationWhereInput {
  return { userId, OR: [{ scheduledFor: null }, { scheduledFor: { lte: now } }] };
}

/** When a notification created now becomes visible: null = immediately, else the end of the user's quiet hours. */
async function scheduledForNow(userId: string, respectQuietHours: boolean | undefined, now: Date): Promise<Date | null> {
  if (respectQuietHours === false) return null;
  const s = await prisma.automationSettings.findUnique({ where: { userId }, select: { quietHoursStart: true, quietHoursEnd: true, timezone: true } });
  return s && inQuietHours(s, now) ? quietHoursEndAt(s, now) : null;
}

export const notificationService = {
  async notify(userId: string, input: NotifyInput, now = new Date()): Promise<{ created: boolean; id: string | null }> {
    const scheduledFor = await scheduledForNow(userId, input.respectQuietHours, now);
    try {
      // skipDuplicates = ON CONFLICT DO NOTHING on (userId, dedupeKey): an already-sent notification is not repeated.
      const [n] = await prisma.notification.createManyAndReturn({
        data: [{ userId, type: input.type, title: input.title.slice(0, 200), body: input.body.slice(0, 1000), link: input.link ?? null, dedupeKey: input.dedupeKey ?? null, scheduledFor }],
        skipDuplicates: true,
        select: { id: true },
      });
      return n ? { created: true, id: n.id } : { created: false, id: null };
    } catch (e) {
      logger.warn("notification.create_failed", { userId, type: input.type, error: e instanceof Error ? e.name : "unknown" });
      throw e;
    }
  },

  /**
   * One notification per dedupe key that accumulates: the first call creates it, later calls update it in place with
   * `merge(previous)` (compare-and-set, so concurrent updates are not lost). When the user already read it, `merge`
   * gets null (start counting again) and the notification is shown as new again.
   */
  async accumulate(
    userId: string,
    input: Omit<NotifyInput, "title" | "body" | "dedupeKey"> & { dedupeKey: string },
    merge: (previous: { title: string; body: string } | null) => { title: string; body: string },
    now = new Date(),
  ): Promise<{ created: boolean; id: string | null }> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const existing = await prisma.notification.findFirst({ where: { userId, dedupeKey: input.dedupeKey }, select: { id: true, title: true, body: true, readAt: true } });
      if (!existing) {
        const created = await this.notify(userId, { ...input, ...merge(null) }, now);
        if (created.created) return created;
        continue; // created concurrently: merge into it
      }
      const next = merge(existing.readAt ? null : { title: existing.title, body: existing.body });
      const reopen = existing.readAt ? { readAt: null, createdAt: now, scheduledFor: await scheduledForNow(userId, input.respectQuietHours, now) } : {};
      const res = await prisma.notification.updateMany({
        where: { id: existing.id, title: existing.title, readAt: existing.readAt },
        data: { title: next.title.slice(0, 200), body: next.body.slice(0, 1000), ...reopen },
      });
      if (res.count === 1) return { created: false, id: existing.id };
    }
    logger.warn("notification.accumulate_conflict", { userId, type: input.type });
    return { created: false, id: null };
  },

  /** The user's local calendar day (automation timezone), for per-day notification keys. */
  async localDay(userId: string, now = new Date()): Promise<string> {
    const s = await prisma.automationSettings.findUnique({ where: { userId }, select: { timezone: true } });
    return dayKey(now, s?.timezone ?? DEFAULT_TIMEZONE);
  },

  /** Release notifications deferred by quiet hours (they then show up as new). */
  async dispatchDue(now = new Date()): Promise<{ released: number }> {
    const res = await prisma.notification.updateMany({ where: { scheduledFor: { lte: now } }, data: { scheduledFor: null, createdAt: now } });
    return { released: res.count };
  },
};
