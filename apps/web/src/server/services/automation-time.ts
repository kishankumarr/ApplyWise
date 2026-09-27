/**
 * Time helpers for the automation (pure, no I/O). Days and quiet hours are evaluated in the user's
 * timezone so "30 applications per day" means the user's calendar day.
 */

function parts(date: Date, timeZone: string): { year: string; month: string; day: string; hour: number; minute: number } {
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  } catch {
    fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  }
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  return { year: p.year!, month: p.month!, day: p.day!, hour: Number(p.hour) % 24, minute: Number(p.minute) };
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** YYYY-MM-DD of `date` in `timeZone`. */
export function dayKey(date: Date, timeZone: string): string {
  const p = parts(date, timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}

/** Minutes after local midnight. */
export function localMinutes(date: Date, timeZone: string): number {
  const p = parts(date, timeZone);
  return p.hour * 60 + p.minute;
}

export function localHour(date: Date, timeZone: string): number {
  return parts(date, timeZone).hour;
}

export interface QuietHours {
  quietHoursStart: number | null;
  quietHoursEnd: number | null;
  timezone: string;
}

/** Quiet hours may wrap midnight (e.g. 22:00-07:00). start === end means "off". */
export function inQuietHours(q: QuietHours, now: Date): boolean {
  if (q.quietHoursStart == null || q.quietHoursEnd == null || q.quietHoursStart === q.quietHoursEnd) return false;
  const m = localMinutes(now, q.timezone);
  return q.quietHoursStart < q.quietHoursEnd ? m >= q.quietHoursStart && m < q.quietHoursEnd : m >= q.quietHoursStart || m < q.quietHoursEnd;
}

/** When the current quiet period ends (now if not in quiet hours). Minute precision. */
export function quietHoursEndAt(q: QuietHours, now: Date): Date {
  if (!inQuietHours(q, now)) return now;
  const m = localMinutes(now, q.timezone);
  const end = q.quietHoursEnd!;
  const delta = (end - m + 1440) % 1440 || 1440;
  return new Date(now.getTime() + delta * 60_000 - now.getSeconds() * 1000 - now.getMilliseconds());
}

/** Start of the next local day (for "daily limit reached - retry tomorrow"). */
export function nextLocalDayStart(now: Date, timeZone: string): Date {
  const m = localMinutes(now, timeZone);
  return new Date(now.getTime() + (1440 - m) * 60_000 - now.getSeconds() * 1000 - now.getMilliseconds() + 60_000);
}
