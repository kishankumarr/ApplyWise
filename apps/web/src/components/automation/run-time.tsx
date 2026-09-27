"use client";

import { useEffect, useState } from "react";
import type { AutomationRunSummary } from "@applywise/types";
import { formatDateTime, timeAgo } from "@/lib/format";
import { formatDuration, runDurationMs } from "./run-format";

/**
 * The current time, or null during server rendering and hydration: local times and "x ago" depend on the browser's
 * clock and time zone, so they are only rendered on the client. Re-renders every `tickMs` when given.
 */
export function useNow(tickMs: number | false = false): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    if (!tickMs) return;
    const id = setInterval(() => setNow(Date.now()), tickMs);
    return () => clearInterval(id);
  }, [tickMs]);
  return now;
}

/** Deterministic text for the server render: "2026-09-27 10:31 UTC". */
const utc = (iso: string, withSeconds = false) => `${iso.slice(0, 10)} ${iso.slice(11, withSeconds ? 19 : 16)} UTC`;

/** "27 Sep, 10:31 am" in the viewer's time zone (UTC text until hydrated; `now` from useNow). */
export const localDateTime = (iso: string, now: number | null) => (now == null ? utc(iso) : formatDateTime(iso));
/** "10:31:05 am" in the viewer's time zone. */
export const localTime = (iso: string, now: number | null) =>
  now == null ? utc(iso, true) : new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
/** "5 min ago" (empty until hydrated). */
export const relativeTime = (iso: string, now: number | null) => (now == null ? "" : timeAgo(iso));

/** A timestamp in the viewer's time zone. Pass `now` when rendering many (one clock for the whole list). */
export function RunTimestamp({ iso, format = "datetime", now: shared, className }: { iso: string; format?: "datetime" | "time" | "relative"; now?: number | null; className?: string }) {
  const own = useNow(shared === undefined && format === "relative" ? 30_000 : false);
  const now = shared === undefined ? own : shared;
  const text = format === "time" ? localTime(iso, now) : format === "relative" ? relativeTime(iso, now) : localDateTime(iso, now);
  return (
    <time dateTime={iso} className={className} title={now == null ? undefined : new Date(iso).toLocaleString("en-IN")}>
      {text}
    </time>
  );
}

/** How long the run took, or has been running so far (ticks every second while it runs). */
export function RunDuration({ run, className }: { run: Pick<AutomationRunSummary, "startedAt" | "completedAt" | "status">; className?: string }) {
  const running = run.status === "RUNNING" && !run.completedAt;
  const now = useNow(running ? 1_000 : false);
  const ms = runDurationMs(run, now);
  return <span className={className}>{ms == null ? "—" : running ? `${formatDuration(ms)} so far` : formatDuration(ms)}</span>;
}
