import { gunzipSync } from "node:zlib";
import type { JobPlatform } from "@applywise/types";

/**
 * Job links in alert emails -> a stable job id and a canonical URL on the job site.
 * Redirect/tracking wrappers are unwrapped offline (query parameters, Indeed's gzip+base64url
 * "cts" tokens); nothing here ever requests a URL. Canonical URLs are rebuilt from the id, so
 * per-member tokens (otpToken, midToken, tk, alid, sid, utm_*, ...) never survive.
 */

export interface JobLink {
  platform: JobPlatform;
  /** Stable id on the job site (LinkedIn numeric id, Indeed jk, Naukri job id, ...); null for opaque click-through links. */
  id: string | null;
  /** Canonical job URL with tracking removed. */
  url: string;
  /** True when the id is not stable across emails (Glassdoor reissues ids, opaque redirects): dedupe on content. */
  contentKey: boolean;
  /** A click-through redirect that may point anywhere (footer and settings links use it too). */
  opaque?: boolean;
}

const REDIRECT_PARAMS = new Set([
  "url", "u", "redirect", "redirect_url", "redirecturl", "redirect_to", "dest", "destination", "target", "link", "continue",
  "next", "goto", "to", "q", "rurl", "returnurl", "return_url",
]);
const MAX_UNWRAP_DEPTH = 4;
/** Upper bound for a decoded Indeed click token (real ones are well under 1 KB). */
const MAX_CTS_BYTES = 64 * 1024;

function toUrl(value: string): URL | null {
  const s = value.trim().replace(/&amp;/g, "&");
  if (!/^https?:\/\//i.test(s) || s.length > 8192) return null;
  try {
    return new URL(s);
  } catch {
    return null;
  }
}

const onHost = (u: URL, re: RegExp) => re.test(u.hostname.toLowerCase());

/**
 * Indeed wraps every link as cts.indeed.com/v3/<base64url(gzip(JSON))>/<sig> with JSON
 * {"u": target, "m": {"clickType": "viewjob" | "homepage" | "bad-match" | ...}}. Decoded offline;
 * only job clicks (or tokens without a clickType) yield a target.
 */
export function decodeIndeedClickToken(url: URL): string | null {
  const m = /^\/v\d+\/([A-Za-z0-9_-]{16,})/.exec(url.pathname);
  if (!m) return null;
  try {
    const json = JSON.parse(gunzipSync(Buffer.from(m[1]!, "base64url"), { maxOutputLength: MAX_CTS_BYTES }).toString("utf8")) as {
      u?: unknown;
      m?: { clickType?: unknown };
    };
    const clickType = json?.m?.clickType;
    if (typeof json?.u !== "string") return null;
    return clickType === undefined || clickType === "viewjob" ? json.u : null;
  } catch {
    return null;
  }
}

function linkedIn(u: URL): JobLink | null {
  const view = /^\/(?:comm\/)?jobs\/view\/(?:[^/]*-)?(\d{6,20})\/?$/i.exec(u.pathname);
  const current = u.searchParams.get("currentJobId");
  const id = view?.[1] ?? (/^\/(?:comm\/)?jobs\//i.test(u.pathname) && current && /^\d{6,20}$/.test(current) ? current : null);
  return id ? { platform: "LINKEDIN", id, url: `https://www.linkedin.com/jobs/view/${id}/`, contentKey: false } : null;
}

const INDEED_NON_JOB_HOSTS = /^(subscriptions|profile|secure|employers|match|cts|myjobs|smartapply|apply|messages|resume|onboarding|jobseekers)\./i;

function indeed(u: URL): JobLink | null {
  const raw = u.hostname.toLowerCase();
  if (INDEED_NON_JOB_HOSTS.test(raw)) return null;
  // Keep the country site (in.indeed.com, indeed.co.uk); mail hosts such as jobalert.indeed.com have no job pages.
  const host = /^(?:www\.)?indeed\.[a-z.]+$|^[a-z]{2}\.indeed\.com$/.test(raw) ? raw : "www.indeed.com";
  const p = u.pathname;
  const jk = u.searchParams.get("jk") ?? u.searchParams.get("vjk");
  if (jk && /^[0-9a-f]{16}$/i.test(jk) && /^\/(rc\/clk(\/dl)?|viewjob|m\/viewjob|m\/basecamp\/viewjob|pagead\/clk(\/dl)?|jobs|m\/jobs|q-[^/]+\.html|cmp\/[^/]+\/jobs)\/?$/i.test(p)) {
    const id = jk.toLowerCase();
    return { platform: "INDEED", id, url: `https://${host}/viewjob?jk=${id}`, contentKey: false };
  }
  // Sponsored results: an opaque, per-mail ad token and no jk.
  const ad = u.searchParams.get("ad");
  if (/^\/pagead\/clk(\/dl)?\/?$/i.test(p) && ad && /^[\w-]{4,400}$/.test(ad)) {
    return { platform: "INDEED", id: null, url: `https://${host}/pagead/clk?mo=r&ad=${encodeURIComponent(ad)}`, contentKey: true };
  }
  return null;
}

function glassdoor(u: URL): JobLink | null {
  const host = u.hostname.toLowerCase();
  const id = u.searchParams.get("jobListingId") ?? u.searchParams.get("jl");
  if (!id || !/^\d{6,20}$/.test(id)) return null;
  if (/^\/partner\/joblisting\.htm$/i.test(u.pathname)) {
    return { platform: "GLASSDOOR", id, url: `https://${host}/partner/jobListing.htm?jobListingId=${id}`, contentKey: true };
  }
  if (/^\/job-listing\/[^/]+\.htm$/i.test(u.pathname)) {
    return { platform: "GLASSDOOR", id, url: `https://${host}${u.pathname}?jl=${id}`, contentKey: true };
  }
  return null;
}

function slugPath(u: URL, re: RegExp, platform: JobPlatform, base: string, prefix = ""): JobLink | null {
  const m = re.exec(u.pathname);
  if (!m) return null;
  const path = u.pathname.replace(/\/{2,}/g, "/");
  return { platform, id: `${prefix}${m[1]!}`, url: `${base}${path}`, contentKey: false };
}

/** Parse a link that already points at a job site (no unwrapping). */
function directJobLink(u: URL): JobLink | null {
  if (onHost(u, /(^|\.)linkedin\.com$/)) return linkedIn(u);
  if (onHost(u, /(^|\.)indeed\.(com|co\.in|co\.uk|[a-z]{2}|com\.[a-z]{2}|co\.[a-z]{2})$/)) return indeed(u);
  if (onHost(u, /(^|\.)glassdoor\.(com|co\.in|co\.uk|ca|de|fr|sg|ie|nl|com\.au)$/)) return glassdoor(u);
  if (onHost(u, /(^|\.)naukri\.com$/) && !onHost(u, /^(resume|static|my|recruit)\./)) {
    return slugPath(u, /^\/job-listings-[a-z0-9-]*?-(\d{9,15})\/?$/i, "NAUKRI", "https://www.naukri.com");
  }
  if (onHost(u, /(^|\.)foundit\.in$/)) return slugPath(u, /^\/job\/[a-z0-9-]*?-(\d{6,10})\/?$/i, "FOUNDIT", "https://www.foundit.in");
  if (onHost(u, /(^|\.)monsterindia\.com$/)) {
    return slugPath(u, /^\/job\/[a-z0-9-]*?-(\d{6,10})\/?$/i, "FOUNDIT", "https://www.monsterindia.com");
  }
  if (onHost(u, /(^|\.)instahyre\.com$/)) {
    return slugPath(u, /^\/job-(\d{3,9})-[a-z0-9-]+\/?$/i, "INSTAHYRE", "https://www.instahyre.com");
  }
  if (onHost(u, /(^|\.)cutshort\.io$/)) {
    return slugPath(u, /^\/job\/[A-Za-z0-9-]+-([A-Za-z0-9]{8})\/?$/, "CUTSHORT", "https://cutshort.io");
  }
  if (onHost(u, /^links\.wellfound\.com$/)) {
    // Opaque click-through redirect: kept as the link, never resolved.
    return /^\/s\/c\/[\w-]{6,}/.test(u.pathname)
      ? { platform: "WELLFOUND", id: null, url: `https://links.wellfound.com${u.pathname}`, contentKey: true, opaque: true }
      : null;
  }
  if (onHost(u, /(^|\.)(wellfound\.com|angel\.co)$/)) {
    const m = /^\/(?:company\/[^/]+\/)?jobs\/(\d{3,10})(?:-[a-z0-9-]+)?\/?$/i.exec(u.pathname);
    return m ? { platform: "WELLFOUND", id: m[1]!, url: `https://wellfound.com/jobs/${m[1]!}`, contentKey: false } : null;
  }
  if (onHost(u, /(^|\.)hirist\.(tech|com)$/)) {
    return slugPath(u, /^\/j\/[a-z0-9-]*?-(\d{5,9})(?:\.html)?\/?$/i, "HIRIST", "https://www.hirist.tech");
  }
  if (onHost(u, /(^|\.)iimjobs\.com$/)) {
    return slugPath(u, /^\/j\/[a-z0-9-]*?-(\d{5,9})(?:\.html)?\/?$/i, "HIRIST", "https://www.iimjobs.com", "iimjobs-");
  }
  return null;
}

/**
 * Job link for an href from an alert email, or null for anything else (unsubscribe, settings,
 * search pages, company pages, app stores, help, images). Wrapped links are unwrapped offline.
 */
export function parseJobLink(href: string, depth = 0): JobLink | null {
  const u = toUrl(href);
  if (!u || depth > MAX_UNWRAP_DEPTH) return null;
  if (onHost(u, /^cts\.indeed\.com$/)) {
    const target = decodeIndeedClickToken(u);
    return target ? parseJobLink(target, depth + 1) : null;
  }
  const direct = directJobLink(u);
  if (direct) return direct;
  // Generic redirect wrappers (auto-login, safe-links, click trackers): ?url=<encoded target>.
  for (const [key, value] of u.searchParams) {
    if (!REDIRECT_PARAMS.has(key.toLowerCase())) continue;
    let target = value.trim();
    if (/^https?%3a/i.test(target)) {
      try {
        target = decodeURIComponent(target);
      } catch {
        continue;
      }
    }
    if (!/^https?:\/\//i.test(target)) continue;
    const inner = parseJobLink(target, depth + 1);
    if (inner) return inner;
  }
  return null;
}

/** Dedupe key for a link: the stable id, or the canonical URL for opaque links. */
export function jobLinkKey(link: JobLink): string {
  return link.id ? `${link.platform}:${link.id}` : `${link.platform}~${link.url}`;
}

/** Strong-id job links (by platform) found in plain text; used to guess the site of pasted alerts. */
export function jobLinksInText(text: string): JobLink[] {
  const out: JobLink[] = [];
  for (const m of text.matchAll(/https?:\/\/[^\s<>"'()[\]]+/gi)) {
    const link = parseJobLink(m[0].replace(/[.,;:!?]+$/, ""));
    if (link) out.push(link);
  }
  return out;
}
