import type { HandoffItem, PrefillPayload } from "./types";

/**
 * Manual handoff helpers (pure). A handoff is an application the automation could not finish (or that the user
 * applies to themselves): the user opens the official apply page, optionally prefills reviewed values with a
 * prefill code, and submits it THEMSELVES. Nothing here touches a page.
 */

const STATUS_LABELS: Record<string, string> = {
  MANUAL_ACTION_REQUIRED: "Needs you",
  FAILED: "Automation failed",
  APPROVED: "Approved",
  OPENED_APPLY_PAGE: "Apply page opened",
};

export function handoffStatusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status.replace(/_/g, " ").toLowerCase();
}

/** Only http(s) apply URLs are ever opened (never javascript:, data:, file: or extension URLs). */
export function safeApplyUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}

function parse(url: string | null | undefined): URL | null {
  const safe = safeApplyUrl(url);
  return safe ? new URL(safe) : null;
}

const siteHost = (u: URL) => u.hostname.toLowerCase().replace(/^www\./, "");
const trimPath = (p: string) => p.replace(/\/+$/, "");

/** True when the tab is on the same host as the apply URL (ignoring "www."). */
export function onApplySite(applyUrl: string | null | undefined, tabUrl: string | null | undefined): boolean {
  const apply = parse(applyUrl);
  const tab = parse(tabUrl);
  return !!apply && !!tab && siteHost(apply) === siteHost(tab);
}

/**
 * The handoff whose apply page is open in the current tab: the longest apply-URL path that prefixes the tab's
 * path on the same host; otherwise the only handoff on that host. Ambiguous matches return null.
 */
export function handoffForTab(items: HandoffItem[], tabUrl: string | null | undefined): HandoffItem | null {
  const tab = parse(tabUrl);
  if (!tab) return null;
  const tabPath = trimPath(tab.pathname);
  const sameHost: { item: HandoffItem; applyPath: string }[] = [];
  for (const item of items) {
    const apply = parse(item.job.applyUrl);
    if (apply && siteHost(apply) === siteHost(tab)) sameHost.push({ item, applyPath: trimPath(apply.pathname) });
  }
  let best: { item: HandoffItem; applyPath: string } | null = null;
  for (const c of sameHost) {
    if (!c.applyPath || (tabPath !== c.applyPath && !tabPath.startsWith(`${c.applyPath}/`))) continue;
    if (!best || c.applyPath.length > best.applyPath.length) best = c;
  }
  if (best) return best.item;
  return sameHost.length === 1 ? sameHost[0]!.item : null;
}

export interface HandoffHint {
  tone: "warn" | "info";
  text: string;
}

/** Guidance shown with a handoff; SUBMISSION_UNCERTAIN warns against applying twice. */
export function handoffHint(item: Pick<HandoffItem, "reason" | "status">): HandoffHint | null {
  switch (item.reason) {
    case "SUBMISSION_UNCERTAIN":
      return { tone: "warn", text: "Automation may already have sent this application. Check your email or the employer's portal first - do not apply twice." };
    case "CAPTCHA":
      return { tone: "info", text: "Complete the CAPTCHA yourself on the employer's page. ApplyWise never solves or bypasses it." };
    case "MFA":
    case "LOGIN_REQUIRED":
      return { tone: "info", text: "Sign in and complete any verification on the employer's page yourself. ApplyWise never stores or enters your credentials." };
    case "UNKNOWN_REQUIRED_QUESTION":
      return { tone: "info", text: "A required question has no verified answer - answer it yourself on the page." };
    default:
      return item.status === "FAILED" ? { tone: "info", text: "Check the application in ApplyWise before applying manually." } : null;
  }
}

/** A prefill code must belong to the selected handoff; returns an error message when it does not. */
export function prefillMismatch(payload: Pick<PrefillPayload, "applicationId" | "job">, selected: Pick<HandoffItem, "applicationId" | "job"> | null): string | null {
  if (!selected || payload.applicationId === selected.applicationId) return null;
  return `This prefill code is for "${payload.job.title}" at ${payload.job.company}, not "${selected.job.title}" at ${selected.job.company}. Create a code for the selected application.`;
}

/** ApplyWise page where the user creates the prefill code for an application. */
export function applicationPageUrl(baseUrl: string, applicationId: string): string {
  return `${baseUrl.replace(/\/$/, "")}/applications/${encodeURIComponent(applicationId)}`;
}
