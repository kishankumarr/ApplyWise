import "server-only";
import { prisma } from "@applywise/database";
import { dayKey } from "./automation-time";

/**
 * Atomic per-user daily submission limit.
 *
 * reserve() increments DailyApplicationCounter only while count < limit, in one conditional UPDATE. PostgreSQL
 * re-checks the WHERE clause after acquiring the row lock, so any number of parallel workers can never push the
 * count past the limit (5 workers x 7 jobs with a limit of 30 => exactly 30 reservations).
 * release() gives a slot back when an attempt definitely did not submit.
 */
export const dailyLimitService = {
  dayKey,

  async countToday(userId: string, timeZone: string, now = new Date()): Promise<number> {
    const row = await prisma.dailyApplicationCounter.findUnique({ where: { userId_day: { userId, day: dayKey(now, timeZone) } }, select: { count: true } });
    return row?.count ?? 0;
  },

  /** Returns the reserved day key, or null when the limit is reached. */
  async reserve(userId: string, limit: number, timeZone: string, now = new Date()): Promise<string | null> {
    if (limit <= 0) return null;
    const day = dayKey(now, timeZone);
    // Ensure the row exists (no-op when it already does), then take a slot conditionally.
    await prisma.$executeRaw`INSERT INTO "DailyApplicationCounter" ("userId", "day", "count", "updatedAt") VALUES (${userId}, ${day}, 0, NOW()) ON CONFLICT ("userId", "day") DO NOTHING`;
    const taken = await prisma.dailyApplicationCounter.updateMany({ where: { userId, day, count: { lt: limit } }, data: { count: { increment: 1 } } });
    return taken.count === 1 ? day : null;
  },

  async release(userId: string, day: string): Promise<void> {
    await prisma.dailyApplicationCounter.updateMany({ where: { userId, day, count: { gt: 0 } }, data: { count: { decrement: 1 } } });
  },
};
