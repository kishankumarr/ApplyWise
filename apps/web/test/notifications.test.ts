import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@applywise/database";
import { notificationService, visibleNotificationsWhere } from "@/server/services/notification.service";
import { bareUser, disableTrackedUsers } from "./automation-helpers";

/**
 * Notifications: dedupe keys make them idempotent; during quiet hours they are scheduled for the end of the quiet
 * period, hidden from the notifications API until notification.dispatch (dispatchDue) releases them.
 *
 * Fixed dates in 2020 keep dispatchDue (which releases every user's due notifications) away from other tests' data.
 */

const notify = notificationService.notify.bind(notificationService);
const input = (dedupeKey: string | null, extra: Partial<Parameters<typeof notify>[1]> = {}) => ({ type: "automation.strong_match" as const, title: "2 strong matches found", body: "Review them.", link: "/automation", dedupeKey, ...extra });
const visible = (userId: string, now: Date) => prisma.notification.findMany({ where: visibleNotificationsWhere(userId, now), orderBy: { createdAt: "asc" } });

/** Quiet hours 22:00-07:00 in the given timezone. */
async function quietUser(tag: string, timezone = "UTC"): Promise<string> {
  const userId = await bareUser(tag);
  await prisma.automationSettings.create({ data: { userId, quietHoursStart: 22 * 60, quietHoursEnd: 7 * 60, timezone } });
  return userId;
}

afterAll(disableTrackedUsers);

describe("dedupe keys", () => {
  it("never notify twice for the same key, even concurrently; keys are per user", async () => {
    const u = await bareUser("notify-dedupe");
    const other = await bareUser("notify-dedupe-other");
    const first = await notify(u, input("strong:run-1"));
    expect(first).toMatchObject({ created: true, id: expect.any(String) });
    expect(await notify(u, input("strong:run-1", { title: "A retried task" }))).toEqual({ created: false, id: null });

    const results = await Promise.all(Array.from({ length: 5 }, () => notify(u, input("strong:run-2"))));
    expect(results.filter((r) => r.created)).toHaveLength(1);

    expect((await notify(other, input("strong:run-1"))).created).toBe(true);
    // Without a key every call creates a notification.
    await notify(u, input(null));
    await notify(u, input(null));

    const rows = await prisma.notification.findMany({ where: { userId: u } });
    expect(rows).toHaveLength(4);
    expect(rows.find((r) => r.dedupeKey === "strong:run-1")!.title).toBe("2 strong matches found");
    expect(rows.filter((r) => r.dedupeKey === null)).toHaveLength(2);
  });
});

describe("accumulating notifications (one per key, updated in place)", () => {
  const counting = (n: number) => (previous: { title: string } | null) => {
    const total = n + (previous ? Number(/^(\d+)/.exec(previous.title)?.[1] ?? 0) : 0);
    return { title: `${total} new jobs match your profile`, body: "Open your job inbox to see them." };
  };

  it("counts up in one notification, also under concurrency, and shows it as new again after it was read", async () => {
    const u = await bareUser("notify-accumulate");
    const add = (n: number, now?: Date) => notificationService.accumulate(u, { type: "jobs.new_matches", link: "/jobs?new=true", dedupeKey: "new-matches:2020-02-01" }, counting(n), now);
    expect((await add(2)).created).toBe(true);
    expect((await add(3)).created).toBe(false);
    await Promise.all([add(1), add(1), add(1)]);
    let rows = await prisma.notification.findMany({ where: { userId: u } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: "8 new jobs match your profile", dedupeKey: "new-matches:2020-02-01", readAt: null, link: "/jobs?new=true" });

    // Read: the next arrivals start a fresh count and the notification is new (unread, recent) again.
    const readAt = new Date(Date.now() - 60_000);
    await prisma.notification.update({ where: { id: rows[0]!.id }, data: { readAt, createdAt: new Date("2020-02-01T08:00:00Z") } });
    const later = new Date();
    await add(4, later);
    rows = await prisma.notification.findMany({ where: { userId: u } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: "4 new jobs match your profile", readAt: null, createdAt: later });
  });

  it("uses the user's local day (automation timezone, else the default) for per-day keys", async () => {
    const at = new Date("2020-01-15T20:00:00Z"); // 01:30 on the 16th in Kolkata
    const utcUser = await quietUser("notify-day-utc", "UTC");
    const noSettings = await bareUser("notify-day-default");
    expect(await notificationService.localDay(utcUser, at)).toBe("2020-01-15");
    expect(await notificationService.localDay(noSettings, at)).toBe("2020-01-16");
  });
});

describe("quiet hours", () => {
  const IN_QUIET = new Date("2020-01-15T23:30:00Z");
  const QUIET_ENDS = new Date("2020-01-16T07:00:00Z");

  it("schedules notifications for the end of quiet hours and hides them until dispatchDue releases them", async () => {
    const u = await quietUser("notify-quiet");
    await notify(u, input("strong:quiet"), IN_QUIET);
    // Same key again during quiet hours: still one.
    expect((await notify(u, input("strong:quiet"), new Date(IN_QUIET.getTime() + 60_000))).created).toBe(false);
    const row = await prisma.notification.findFirstOrThrow({ where: { userId: u, dedupeKey: "strong:quiet" } });
    expect(row.scheduledFor).toEqual(QUIET_ENDS);

    // Hidden from the notifications API during quiet hours...
    expect(await visible(u, IN_QUIET)).toEqual([]);
    expect(await visible(u, new Date(QUIET_ENDS.getTime() - 60_000))).toEqual([]);
    // ...a dispatch before the end releases nothing of it...
    await notificationService.dispatchDue(new Date(QUIET_ENDS.getTime() - 60_000));
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: row.id } })).scheduledFor).toEqual(QUIET_ENDS);

    // ...and the dispatch at the end releases it as a new notification.
    const { released } = await notificationService.dispatchDue(QUIET_ENDS);
    expect(released).toBeGreaterThanOrEqual(1);
    const after = await prisma.notification.findUniqueOrThrow({ where: { id: row.id } });
    expect(after).toMatchObject({ scheduledFor: null, createdAt: QUIET_ENDS, readAt: null });
    expect((await visible(u, QUIET_ENDS)).map((n) => n.id)).toEqual([row.id]);
    expect((await visible(u, new Date())).map((n) => n.id)).toEqual([row.id]);
  });

  it("delivers immediately outside quiet hours, for security-relevant notices, and for users without settings", async () => {
    const u = await quietUser("notify-quiet-kolkata", "Asia/Kolkata");
    // 12:00 UTC = 17:30 in Kolkata: outside quiet hours.
    await notify(u, input("outside"), new Date("2020-01-15T12:00:00Z"));
    // 18:00 UTC = 23:30 in Kolkata: quiet hours, but the notice opts out of deferral.
    await notify(u, input("urgent", { type: "provider.needs_attention", respectQuietHours: false }), new Date("2020-01-15T18:00:00Z"));
    // 18:00 UTC in quiet hours: deferred to 07:00 Kolkata = 01:30 UTC.
    await notify(u, input("deferred"), new Date("2020-01-15T18:00:00Z"));
    const rows = new Map((await prisma.notification.findMany({ where: { userId: u } })).map((n) => [n.dedupeKey, n]));
    expect(rows.get("outside")!.scheduledFor).toBeNull();
    expect(rows.get("urgent")!.scheduledFor).toBeNull();
    expect(rows.get("deferred")!.scheduledFor).toEqual(new Date("2020-01-16T01:30:00Z"));
    expect((await visible(u, new Date("2020-01-15T18:00:00Z"))).map((n) => n.dedupeKey).sort()).toEqual(["outside", "urgent"]);

    const noSettings = await bareUser("notify-no-settings");
    await notify(noSettings, input("plain"), IN_QUIET);
    expect((await prisma.notification.findFirstOrThrow({ where: { userId: noSettings } })).scheduledFor).toBeNull();
  });
});
