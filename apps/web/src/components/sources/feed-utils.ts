import type { AlertGuide, FeedView, ForwardingConfirmation, ImapPresetView, JobFeedsOverview, ProviderAttribution, SuggestedCompany } from "@/lib/client-types";
import { plural } from "@/lib/format";

/**
 * Small pure helpers for the "Job sources" screens. Several payload parts (alert guides, IMAP
 * presets, suggested companies) come from packages that may evolve, so they are read defensively.
 */

export const CONSENT_TEXT = "ApplyWise may read job-alert emails from job sites in this mailbox (read-only). Other emails are never downloaded or stored.";
/** Accurate about what an app password allows (full mailbox access) and what ApplyWise does with it. */
export const APP_PASSWORD_NOTE =
  `Name it "ApplyWise" and copy the password it shows. An app password gives access to this mailbox; ApplyWise uses it only to read job-alert emails (read-only). You can revoke it any time in your account's security settings.`;
export const CHECKING_NOW = "Checking now - new jobs will appear in your inbox.";

export function companyName(c: SuggestedCompany): string {
  const n = c.name ?? c.companyName ?? (typeof c.label === "string" ? c.label : null);
  return typeof n === "string" && n.trim() ? n : c.slug;
}

/** "India jobs" snapshot for a suggested company, when the package provides one. */
export function companyJobs(c: SuggestedCompany): number | null {
  for (const k of ["indiaJobs", "indiaJobCount", "jobsInIndia", "jobCount", "openJobs"]) {
    const v = c[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

export function attributionOf(a: ProviderAttribution): { text: string; url: string | null } | null {
  if (!a) return null;
  if (typeof a === "string") return { text: a, url: null };
  return a.text ? { text: a.text, url: a.url ?? null } : null;
}

export function alertGuides(overview: Pick<JobFeedsOverview, "alertGuides"> | undefined): (AlertGuide & { key: string; title: string })[] {
  const raw = overview?.alertGuides;
  const list: AlertGuide[] = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? Object.values(raw) : [];
  return list
    .filter((g): g is AlertGuide => !!g && typeof g === "object")
    .map((g, i) => ({
      ...g,
      key: String(g.platform ?? g.label ?? i),
      title: String(g.label ?? g.platform ?? "Job site"),
      steps: Array.isArray(g.steps) ? g.steps.filter((s): s is string => typeof s === "string") : [],
      createAlertUrl: typeof g.createAlertUrl === "string" && /^https?:\/\//.test(g.createAlertUrl) ? g.createAlertUrl : null,
    }));
}

export function presetNotes(p: ImapPresetView | null | undefined): string[] {
  if (!p?.notes) return [];
  return (Array.isArray(p.notes) ? p.notes : [p.notes]).filter((n): n is string => typeof n === "string" && n.trim().length > 0);
}

/** Microsoft mailboxes (Outlook.com, Hotmail, Live, Microsoft 365) do not accept app passwords. */
export const isMicrosoftPreset = (p: Pick<ImapPresetView, "id" | "label">) => /^(outlook|hotmail|microsoft|office365|live)$/i.test(p.id) || /outlook|hotmail|microsoft/i.test(p.label);

const DOMAIN_HINTS: [RegExp, string][] = [
  [/^(gmail|googlemail)\.com$/, "gmail"],
  [/^(yahoo\.[a-z.]+|ymail\.com|rocketmail\.com)$/, "yahoo"],
  [/^(icloud|me|mac)\.com$/, "icloud"],
  // Zoho's India data centre has its own IMAP server (imap.zoho.in): match it before the global rule.
  [/^(zohomail|zoho)\.in$/, "zoho_in"],
  [/^zoho(mail)?\.[a-z.]+$/, "zoho"],
  [/^(outlook|hotmail|live|msn|windowslive)\.[a-z.]+$/, "outlook"],
  [/^rediffmail\.com$/, "rediff"],
  [/^aol\.com$/, "aol"],
  [/^gmx\.[a-z.]+$/, "gmx"],
];

/**
 * Guess the provider from the email domain. Returns "microsoft" for Outlook/Hotmail addresses
 * (they need the Microsoft sign-in), a preset id when one matches, or null.
 */
export function guessPreset(email: string, presets: ImapPresetView[]): string | null {
  const domain = email.trim().toLowerCase().split("@")[1];
  if (!domain) return null;
  const hint = DOMAIN_HINTS.find(([re]) => re.test(domain))?.[1];
  if (!hint) return null;
  if (hint === "outlook") return "microsoft";
  const byId = presets.find((p) => p.id.toLowerCase() === hint);
  if (byId) return byId.id;
  // Region-specific presets are matched by id only: never fall back to the global server.
  if (hint.includes("_")) return null;
  return presets.find((p) => p.id.toLowerCase().includes(hint) || p.label.toLowerCase().includes(hint))?.id ?? null;
}

export function feedResultText(f: FeedView): string | null {
  const r = f.lastResult;
  if (!r || !f.lastSyncAt) return null;
  const created = r.created ?? 0;
  const merged = r.merged ?? 0;
  if (!created && !merged) return r.fetched ? "No new jobs" : "Nothing new";
  const parts = [];
  if (created) parts.push(`${created} new`);
  if (merged) parts.push(`${merged} updated`);
  return parts.join(", ");
}

/** "12 new jobs found" / "No new jobs" for a check that just finished successfully. */
export function newJobsText(f: FeedView): string {
  const created = f.lastResult?.created ?? 0;
  return created ? `${plural(created, "new job")} found` : "No new jobs";
}

/** Sources that "Sync now" / "Sync all" can check (forwarded alerts arrive by themselves). */
export const isCheckable = (f: FeedView) => f.provider !== "forwarding" && (f.status === "ACTIVE" || f.status === "ERROR");

/** Why "Sync all" had nothing to check, based on the sources the user has. */
export function nothingToCheckText(feeds: FeedView[] | undefined): string {
  const list = feeds ?? [];
  const forwarding = list.filter((f) => f.provider === "forwarding" && f.status !== "PAUSED").length;
  const attention = list.filter((f) => f.status === "NEEDS_ATTENTION").length;
  const paused = list.filter((f) => f.status === "PAUSED").length;
  const parts: string[] = [];
  if (forwarding) parts.push("Forwarded job alerts arrive by themselves - new jobs appear as soon as an alert email comes in, so there is nothing to check.");
  if (attention) parts.push(attention === 1 ? "1 source needs to be reconnected first." : `${attention} sources need to be reconnected first.`);
  if (paused) parts.push(paused === 1 ? "1 source is paused - resume it to check it." : `${paused} sources are paused - resume them to check them.`);
  return parts.length ? parts.join(" ") : "There are no sources to check yet. Add one on the Job sources page.";
}

/** Gmail's forwarding confirmation, only while it is still needed (no forwarded alert since it arrived). */
export function pendingConfirmation(f: FeedView | null | undefined): ForwardingConfirmation | null {
  if (!f?.forwardingConfirmation) return null;
  const c = f.forwardingConfirmation;
  if (f.lastSyncAt && Date.parse(f.lastSyncAt) >= Date.parse(c.receivedAt)) return null;
  return c;
}

/** A just-created source whose first check is still queued (the server has not started it yet). */
export function isFirstCheck(f: FeedView): boolean {
  return !f.lastSyncAt && !f.lastError && f.status === "ACTIVE" && f.provider !== "forwarding" && Date.now() - Date.parse(f.createdAt) < 5 * 60_000;
}

export const boardKey = (provider: string, slug: string) => `${provider}|${slug.toLowerCase()}`;

export function followedBoards(feeds: FeedView[]): Set<string> {
  return new Set(feeds.filter((f) => f.kind === "COMPANY_BOARD" && typeof f.config.slug === "string").map((f) => boardKey(f.provider, f.config.slug as string)));
}

/** Same identity the server uses to drop suggestions that are already saved: provider | keywords | location. */
export const searchKey = (provider: string, keywords: string, location: string | null | undefined) => `${provider}|${keywords.trim().toLowerCase()}|${(location ?? "").trim().toLowerCase()}`;

export function savedSearches(feeds: FeedView[]): Set<string> {
  return new Set(
    feeds.filter((f) => f.kind === "SEARCH" && typeof f.config.keywords === "string").map((f) => searchKey(f.provider, f.config.keywords as string, typeof f.config.location === "string" ? f.config.location : null)),
  );
}

export function gmailFilterQuery(domains: string[]): string {
  const list = [...new Set(domains.map((d) => d.trim()).filter(Boolean))];
  return list.length ? `from:(${list.join(" OR ")})` : "";
}

export function sourcesSummary(feeds: FeedView[]): string {
  const active = feeds.filter((f) => f.status === "ACTIVE" || f.status === "ERROR").length;
  const paused = feeds.filter((f) => f.status === "PAUSED").length;
  const parts = [`${plural(active, "source")} active`];
  if (paused) parts.push(`${paused} paused`);
  return parts.join(", ");
}
