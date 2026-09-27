import { APPLICATION_STATUS_LABELS, PLATFORM_LABELS, type ApplicationStatus, type JobPlatform } from "@applywise/types";

export const platformLabel = (p: string) => PLATFORM_LABELS[p as JobPlatform] ?? p;
export const statusLabel = (s: string) => APPLICATION_STATUS_LABELS[s as ApplicationStatus] ?? s;

export function yoeRange(min: number | null, max: number | null): string {
  if (min == null && max == null) return "—";
  if (max == null) return `${min}+ yrs`;
  if (min == null) return `up to ${max} yrs`;
  return `${min}-${max} yrs`;
}

export function relativeDate(iso: string | null | Date): string {
  if (!iso) return "—";
  const d = typeof iso === "string" ? new Date(iso) : iso;
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "1 day ago";
  if (days < 30) return `${days} days ago`;
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

export function formatDateTime(iso: string | Date | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function lpa(amount: number | null): string {
  if (amount == null) return "";
  return `${(amount / 100000).toFixed(amount % 100000 === 0 ? 0 : 1)} LPA`;
}

export const APPLY_METHOD_LABELS: Record<string, string> = {
  PLATFORM: "Job board",
  CAREER_PAGE: "Career page / ATS",
  EMAIL: "Email to HR",
  MANUAL: "Manual",
};

export const WORK_MODE_LABELS: Record<string, string> = { remote: "Remote", hybrid: "Hybrid", onsite: "Onsite", unknown: "Not stated", any: "Any" };

export function scoreVariant(label: string | null): "success" | "warning" | "secondary" {
  if (label === "strong") return "success";
  if (label === "moderate") return "warning";
  return "secondary";
}

/** "just now", "5 min ago", "3 h ago", "2 days ago" (finer than relativeDate, for sync times). */
export function timeAgo(iso: string | Date | null): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  return relativeDate(iso);
}

/** "in 5 min", "in about 3 h", "soon" for a future time. */
export function timeUntil(iso: string | Date | null): string {
  if (!iso) return "";
  const min = Math.round((new Date(iso).getTime() - Date.now()) / 60_000);
  if (min <= 1) return "soon";
  if (min < 60) return `in ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `in about ${h} h`;
  const d = Math.round(h / 24);
  return `in ${d} day${d === 1 ? "" : "s"}`;
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
