/**
 * Labels, explanations and small pure helpers for the automation run history and run inspection pages.
 * No React and no server imports: safe for server pages and client components alike.
 */
import {
  APPLICATION_MODE_DESCRIPTIONS,
  APPLICATION_MODE_LABELS,
  AUTOMATION_DECISION_LABELS,
  type ApplicationMode,
  type AutomationRunStatus,
  type AutomationRunSummary,
} from "@applywise/types";
import type { BadgeProps } from "@applywise/ui";

export type BadgeVariant = NonNullable<BadgeProps["variant"]>;

/** Runs requested per page (first server render and every "Load more"). */
export const RUNS_PAGE_SIZE = 20;
/** Timeline steps per page on the run page (a large run records thousands). */
export const RUN_ITEMS_PAGE_SIZE = 50;

// ---------------------------------------------------------------- polling

/** While a run is in progress, pages refresh this often. */
export const RUN_POLL_MS = 5_000;
/**
 * Preparation and submission are queued tasks that can finish shortly after a run is marked complete, and they still
 * update the run's counters and timeline. Keep refreshing gently for a little while after completion.
 */
export const LATE_RESULTS_POLL_MS = 15_000;
export const LATE_RESULTS_WINDOW_MS = 3 * 60_000;

export function recentlyFinished(run: Pick<AutomationRunSummary, "status" | "completedAt">, now = Date.now()): boolean {
  return run.status !== "RUNNING" && !!run.completedAt && now - Date.parse(run.completedAt) < LATE_RESULTS_WINDOW_MS;
}

/** TanStack refetchInterval for a set of runs: fast while one is running, gently just after one finished, else off. */
export function runPollInterval(runs: readonly Pick<AutomationRunSummary, "status" | "completedAt">[]): number | false {
  if (runs.some((r) => r.status === "RUNNING")) return RUN_POLL_MS;
  const now = Date.now();
  if (runs.some((r) => recentlyFinished(r, now))) return LATE_RESULTS_POLL_MS;
  return false;
}

// ---------------------------------------------------------------- run status / trigger / mode

export const RUN_STATUS_META: Record<AutomationRunStatus, { label: string; variant: BadgeVariant }> = {
  RUNNING: { label: "Running", variant: "info" },
  COMPLETED: { label: "Completed", variant: "success" },
  FAILED: { label: "Failed", variant: "destructive" },
};

const TRIGGER_LABELS: Record<string, string> = { schedule: "Scheduled", manual: "Run now", demo: "Demo" };
const TRIGGER_DESCRIPTIONS: Record<string, string> = {
  schedule: "Started automatically on your search schedule.",
  manual: "Started with Run now.",
  demo: "Started by the demo (fictional demo provider).",
};

export const triggerLabel = (t: string) => TRIGGER_LABELS[t] ?? humanize(t);
export const triggerDescription = (t: string) => TRIGGER_DESCRIPTIONS[t] ?? "";
export const modeLabel = (m: string) => APPLICATION_MODE_LABELS[m as ApplicationMode] ?? humanize(m);
export const modeDescription = (m: string) => APPLICATION_MODE_DESCRIPTIONS[m as ApplicationMode] ?? "";

// ---------------------------------------------------------------- time

/** "<1 s", "42 s", "3 min 12 s", "1 h 4 min". */
export function formatDuration(ms: number): string {
  if (ms < 1_000) return "<1 s";
  const s = Math.round(ms / 1_000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs ? `${m} min ${rs} s` : `${m} min`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h} h ${rm} min` : `${h} h`;
}

/** Duration of a finished run, or the time elapsed so far when it is still running (`now` required). */
export function runDurationMs(run: Pick<AutomationRunSummary, "startedAt" | "completedAt">, now: number | null): number | null {
  const start = Date.parse(run.startedAt);
  if (run.completedAt) return Math.max(0, Date.parse(run.completedAt) - start);
  return now == null ? null : Math.max(0, now - start);
}

// ---------------------------------------------------------------- counters

export type RunCounterKey = keyof Pick<
  AutomationRunSummary,
  | "providersChecked"
  | "jobsFound"
  | "newJobs"
  | "duplicates"
  | "jobsMatched"
  | "ignored"
  | "recommended"
  | "reviewRequired"
  | "autoEligible"
  | "applicationsPrepared"
  | "applicationsSubmitted"
  | "needsInformation"
  | "manualActions"
  | "failures"
>;

export type RunMetricGroup = "discovery" | "decisions" | "applications";
/** How a non-zero value should read: neutral, good news, or something that needs the user. */
export type RunMetricTone = "neutral" | "positive" | "attention" | "problem";

export interface RunMetric {
  key: RunCounterKey;
  label: string;
  /** Column header in the runs table. */
  short: string;
  description: string;
  group: RunMetricGroup;
  tone: RunMetricTone;
}

export const RUN_METRIC_GROUPS: { key: RunMetricGroup; title: string; description: string }[] = [
  { key: "discovery", title: "Discovery", description: "What your job sources returned." },
  { key: "decisions", title: "Matching and rules", description: "How each job scored against your verified profile and your rules." },
  { key: "applications", title: "Applications", description: "What happened to the applications this run prepared." },
];

export const RUN_METRICS: RunMetric[] = [
  { key: "providersChecked", label: "Providers checked", short: "Providers", description: "Job providers queried in this run.", group: "discovery", tone: "neutral" },
  { key: "jobsFound", label: "Jobs found", short: "Found", description: "Listings returned by all providers, before removing duplicates.", group: "discovery", tone: "neutral" },
  { key: "newJobs", label: "New jobs", short: "New", description: "Jobs not seen before - added to your inbox.", group: "discovery", tone: "positive" },
  { key: "duplicates", label: "Duplicates", short: "Duplicates", description: "Already known, or merged with the same job from another provider.", group: "discovery", tone: "neutral" },
  { key: "jobsMatched", label: "Jobs matched", short: "Matched", description: "Jobs scored against your verified profile (new jobs plus earlier ones due for a re-check).", group: "decisions", tone: "neutral" },
  { key: "ignored", label: "Ignored", short: "Ignored", description: "Below your recommend score or excluded by one of your rules. Nothing is prepared.", group: "decisions", tone: "neutral" },
  { key: "recommended", label: "Recommended", short: "Recommended", description: "Worth a look but below your minimum match score - shown in your inbox, not prepared.", group: "decisions", tone: "neutral" },
  { key: "reviewRequired", label: "Review", short: "Review", description: "Good matches - an application is prepared for you to review.", group: "decisions", tone: "positive" },
  {
    key: "autoEligible",
    label: "Auto-eligible",
    short: "Auto-eligible",
    description: "Met every rule and your auto-apply score. Submitted automatically only in Auto mode, with your consent, where the provider supports it.",
    group: "decisions",
    tone: "positive",
  },
  { key: "applicationsPrepared", label: "Prepared", short: "Prepared", description: "Applications drafted from your verified profile: resume, cover letter and answers.", group: "applications", tone: "positive" },
  { key: "applicationsSubmitted", label: "Submitted", short: "Submitted", description: "Applications sent to the employer by an executor - by policy in Auto mode, or after you approved them. Manual mode never submits on its own.", group: "applications", tone: "positive" },
  { key: "manualActions", label: "Manual actions", short: "Manual", description: "You finish these yourself - e.g. the provider has no automatic submission, or asked for a login or CAPTCHA.", group: "applications", tone: "attention" },
  { key: "needsInformation", label: "Needs information", short: "Needs info", description: "A required question has no verified answer yet. Answer it once and it is reused.", group: "applications", tone: "attention" },
  { key: "failures", label: "Failures", short: "Failures", description: "Provider errors, or preparation or submission attempts that failed.", group: "applications", tone: "problem" },
];

/** The counters shown as columns in the runs table (in order). */
export const RUN_TABLE_METRICS: RunCounterKey[] = [
  "providersChecked",
  "jobsFound",
  "newJobs",
  "duplicates",
  "jobsMatched",
  "autoEligible",
  "reviewRequired",
  "applicationsPrepared",
  "applicationsSubmitted",
  "manualActions",
  "needsInformation",
  "failures",
];

export const runMetric = (key: RunCounterKey) => RUN_METRICS.find((m) => m.key === key)!;

/** Tailwind text classes for a counter value: zero is muted, non-zero follows the metric's tone. */
export function metricValueClass(tone: RunMetricTone, value: number): string {
  if (!value) return "text-muted-foreground";
  if (tone === "problem") return "font-semibold text-destructive";
  if (tone === "attention") return "font-semibold text-amber-700 dark:text-amber-300";
  if (tone === "positive") return "font-semibold";
  return "";
}

// ---------------------------------------------------------------- run items (timeline)

export interface RunStage {
  key: string;
  label: string;
  description: string;
}

export const RUN_STAGES: RunStage[] = [
  { key: "discovery", label: "Discovery", description: "Job sources checked for new listings." },
  { key: "rules", label: "Rules", description: "Each matched job scored against your rules: ignore, recommend, review or auto-eligible." },
  { key: "prepare", label: "Preparation", description: "Applications drafted from your verified profile, or held back until something is resolved." },
  { key: "route", label: "Routing", description: "Where each prepared application went next, based on your mode and the safety checks." },
  { key: "execute", label: "Submission", description: "Submission attempts by an executor - only when your mode, your consent and the provider allow it." },
];

export function runStage(key: string): RunStage {
  return RUN_STAGES.find((s) => s.key === key) ?? { key, label: humanize(key), description: "" };
}

/** Known stages first (pipeline order), then any other stage the server recorded. */
export function orderStages(keys: Iterable<string>): string[] {
  const set = new Set(keys);
  const known = RUN_STAGES.map((s) => s.key).filter((k) => set.has(k));
  const other = [...set].filter((k) => !RUN_STAGES.some((s) => s.key === k)).sort();
  return [...known, ...other];
}

export interface RunOutcomeMeta {
  label: string;
  variant: BadgeVariant;
  description: string;
}

export const RUN_OUTCOMES: Record<string, RunOutcomeMeta> = {
  OK: { label: "Checked", variant: "success", description: "The job source was checked." },
  ERROR: { label: "Error", variant: "destructive", description: "The job source could not be checked - the message says why." },
  IGNORE: { label: AUTOMATION_DECISION_LABELS.IGNORE, variant: "secondary", description: "Below your recommend score or excluded by one of your rules. Nothing is prepared." },
  RECOMMEND: { label: AUTOMATION_DECISION_LABELS.RECOMMEND, variant: "outline", description: "Worth a look but below your minimum match score - shown in your inbox, not prepared." },
  REVIEW: { label: AUTOMATION_DECISION_LABELS.REVIEW, variant: "info", description: "A good match - an application is prepared for you to review." },
  AUTO_ELIGIBLE: {
    label: AUTOMATION_DECISION_LABELS.AUTO_ELIGIBLE,
    variant: "success",
    description: "Met every rule and your auto-apply score. It is only submitted automatically in Auto mode, with your consent, where the provider supports it.",
  },
  WAITING_APPROVAL: { label: "Waiting approval", variant: "info", description: "Prepared and waiting for you to approve it before anything is submitted." },
  NEEDS_INFORMATION: { label: "Needs information", variant: "warning", description: "A required question has no verified answer. Answer it to continue." },
  MANUAL_ACTION_REQUIRED: { label: "Manual action", variant: "warning", description: "Automatic submission is not possible here - everything is prepared for you to apply yourself." },
  APPLIED: { label: "Applied", variant: "success", description: "The application was submitted to the employer." },
  FAILED: { label: "Failed", variant: "destructive", description: "The submission did not go through. You can retry or apply on the official page." },
  AUTH_FAILED: { label: "Sign-in failed", variant: "destructive", description: "The saved provider connection is missing or expired. Reconnect it, then retry." },
  SUBMISSION_UNCERTAIN: {
    label: "Check submission",
    variant: "warning",
    description: "Automation was interrupted and the application may have been sent. Check on the official page before retrying.",
  },
  RETRY_SCHEDULED: { label: "Retry scheduled", variant: "secondary", description: "An attempt failed; another attempt is scheduled automatically." },
  DEFERRED: { label: "Deferred", variant: "secondary", description: "Postponed by the per-run preparation cap, your daily limit or quiet hours - it continues later." },
  SKIPPED: { label: "Skipped", variant: "secondary", description: "Not submitted - e.g. already applied via another listing, or automation was paused." },
};

/** Display order of outcome filter chips (unknown outcomes follow, alphabetically). */
const OUTCOME_ORDER = [
  "OK",
  "ERROR",
  "IGNORE",
  "RECOMMEND",
  "REVIEW",
  "AUTO_ELIGIBLE",
  "WAITING_APPROVAL",
  "NEEDS_INFORMATION",
  "MANUAL_ACTION_REQUIRED",
  "APPLIED",
  "FAILED",
  "AUTH_FAILED",
  "SUBMISSION_UNCERTAIN",
  "RETRY_SCHEDULED",
  "DEFERRED",
  "SKIPPED",
];

export function runOutcome(outcome: string): RunOutcomeMeta {
  return RUN_OUTCOMES[outcome] ?? { label: humanize(outcome), variant: "outline", description: "" };
}

export function orderOutcomes(outcomes: Iterable<string>): string[] {
  const rank = (o: string) => {
    const i = OUTCOME_ORDER.indexOf(o);
    return i === -1 ? OUTCOME_ORDER.length : i;
  };
  return [...new Set(outcomes)].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

// ---------------------------------------------------------------- misc

/** "MANUAL_ACTION_REQUIRED" / "manual_action" -> "Manual action required". */
export function humanize(s: string): string {
  const t = s.replace(/[_-]+/g, " ").trim().toLowerCase();
  return t ? t[0]!.toUpperCase() + t.slice(1) : s;
}
