import type { EmploymentType } from "@applywise/types";
import { REMOTE_GLOBAL, REMOTE_INDIA, normalizeLocation } from "../locations";
import { FeedProviderError, type FeedContext } from "./types";

/**
 * Shared helpers for feed adapters: HTML -> plain text, JSON over HTTP with a timeout and
 * user-safe error mapping, dates, and India-focused location clean-up.
 */

export const FEED_USER_AGENT = "ApplyWise/0.1 (job-search copilot)";
export const FEED_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------- text

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  bull: "•",
  middot: "·",
  lsquo: "‘",
  rsquo: "’",
  sbquo: "‚",
  ldquo: "“",
  rdquo: "”",
  laquo: "«",
  raquo: "»",
  copy: "©",
  reg: "®",
  trade: "™",
  deg: "°",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
  times: "×",
  plusmn: "±",
  eacute: "é",
  egrave: "è",
  aacute: "á",
  agrave: "à",
  iacute: "í",
  oacute: "ó",
  uacute: "ú",
  auml: "ä",
  ouml: "ö",
  uuml: "ü",
  ccedil: "ç",
  ntilde: "ñ",
  szlig: "ß",
  shy: "",
  zwj: "",
  zwnj: "",
  lrm: "",
  rlm: "",
};

/** Decode HTML entities exactly once ("&amp;lt;" -> "&lt;"). Unknown entities are left as-is. */
export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (match, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "";
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

/** Strip tags and entities from a one-line value such as a title ("<strong>React</strong> Dev"). */
export function stripTags(value: string | null | undefined): string {
  if (!value) return "";
  return decodeEntities(value.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
}

const BLOCK_TAGS = "p|div|section|article|header|footer|h[1-6]|ul|ol|tr|table|blockquote|pre|dd|dt|dl";

/**
 * HTML -> plain text that keeps the structure the JD parser relies on: paragraphs and headings
 * on their own lines, list items as "- " bullets.
 */
export function htmlToText(html: string | null | undefined): string {
  if (!html) return "";
  let s = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|head|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    // Newlines in HTML source are insignificant.
    .replace(/\s*[\r\n]+\s*/g, " ");
  s = s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(new RegExp(`</?(?:${BLOCK_TAGS}|li)\\b[^>]*>`, "gi"), "\n")
    .replace(/<\/t[dh]\s*>/gi, " ")
    .replace(/<[^>]*>/g, "");
  return tidyText(decodeEntities(s));
}

/** Collapse whitespace per line, merge empty bullets with their text, keep single blank lines. */
export function tidyText(text: string): string {
  const out: string[] = [];
  let pendingBullet = false;
  for (const rawLine of text.replace(/[\u00a0\u2007\u202f]/g, " ").replace(/[\u200b-\u200d\u2060\ufeff]/g, "").split(/\r?\n/)) {
    const line = rawLine.replace(/[ \t\f\v]+/g, " ").trim();
    if (line === "-" || line === "•") {
      pendingBullet = true;
      continue;
    }
    if (!line) {
      if (out.length > 0 && out[out.length - 1] !== "") out.push("");
      continue;
    }
    out.push(pendingBullet && !/^[-•*]\s/.test(line) ? `- ${line}` : line);
    pendingBullet = false;
  }
  // A bullet followed by a blank line and its text: "- " then "" then "text" is already merged above;
  // drop blank lines that sit between consecutive bullets so lists stay compact.
  const compact = out.filter((l, i) => !(l === "" && /^- /.test(out[i - 1] ?? "") && /^- /.test(out[i + 1] ?? "")));
  while (compact[compact.length - 1] === "") compact.pop();
  return compact.join("\n").trim();
}

/** Join description parts ("Requirements" + list) with blank lines, skipping empties. */
export function joinSections(...parts: (string | null | undefined)[]): string {
  return parts
    .map((p) => (p ?? "").trim())
    .filter(Boolean)
    .join("\n\n");
}

// ---------------------------------------------------------------- HTTP

export interface HttpJsonOptions {
  /** Provider label used in user-facing error messages. Request URLs are never included. */
  label: string;
  headers?: Record<string, string>;
  /** Resolve to null on HTTP 404 instead of throwing. */
  allowNotFound?: boolean;
  /** The request carries operator API credentials (changes the 401/403 message). */
  keyed?: boolean;
}

function statusError(label: string, status: number, keyed: boolean): FeedProviderError {
  if (status === 401 || status === 403) {
    // Keyless requests have no credential the user could fix: a 403 is a (bot/rate) block, so back off and retry.
    return keyed
      ? new FeedProviderError(`${label} rejected the API key (HTTP ${status}). Check the operator credentials.`, false, status)
      : new FeedProviderError(`${label} refused the request (HTTP ${status}). It will be retried later.`, true, status);
  }
  if (status === 429) return new FeedProviderError(`${label} rate limit reached. Try again later.`, true, status);
  if (status === 408 || status >= 500) {
    return new FeedProviderError(`${label} is temporarily unavailable (HTTP ${status}). Try again later.`, true, status);
  }
  return new FeedProviderError(`${label} rejected the request (HTTP ${status}).`, false, status);
}

const MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** "signode.recruitee.com" -> "recruitee.com": redirects may only stay on the provider's own site. */
function siteOf(hostname: string): string {
  return hostname.toLowerCase().split(".").slice(-2).join(".");
}

/**
 * GET a JSON document with a 15 s timeout (combined with ctx.signal), the ApplyWise User-Agent
 * and error mapping: network/timeout/429/5xx and keyless 401/403 are retryable; a rejected API
 * key and other 4xx are not. Redirects are followed only within the provider's own site (a board
 * tenant can't bounce the server to another host). Errors never contain the URL (some providers
 * put API keys in the query string).
 */
export async function httpJson<T>(url: string, ctx: FeedContext, opts: HttpJsonOptions): Promise<T | null> {
  const doFetch: typeof fetch = ctx.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, FEED_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  if (ctx.signal?.aborted) controller.abort();
  else ctx.signal?.addEventListener("abort", onAbort, { once: true });

  const failure = () =>
    timedOut
      ? new FeedProviderError(`${opts.label} did not respond within ${FEED_TIMEOUT_MS / 1000} seconds. Try again later.`, true)
      : ctx.signal?.aborted
        ? new FeedProviderError(`The ${opts.label} request was cancelled.`, true)
        : new FeedProviderError(`Could not reach ${opts.label}. Try again later.`, true);

  try {
    let res: Response;
    let current = url;
    for (let hop = 0; ; hop++) {
      try {
        res = await doFetch(current, {
          method: "GET",
          headers: { accept: "application/json", "user-agent": FEED_USER_AGENT, ...opts.headers },
          signal: controller.signal,
          redirect: "manual",
        });
      } catch {
        throw failure();
      }
      const location = REDIRECT_STATUSES.has(res.status) ? res.headers.get("location") : null;
      if (!location) break;
      res.body?.cancel().catch(() => undefined);
      let next: URL | null = null;
      try {
        next = new URL(location, current);
      } catch {
        next = null;
      }
      if (!next || next.protocol !== "https:" || siteOf(next.hostname) !== siteOf(new URL(current).hostname) || hop >= MAX_REDIRECTS) {
        throw new FeedProviderError(`${opts.label} redirected the request elsewhere, so it was not followed.`, false, res.status);
      }
      current = next.toString();
    }
    if (!res.ok) {
      // Release the connection; error bodies are never read (they may echo request details).
      res.body?.cancel().catch(() => undefined);
      if (res.status === 404 && opts.allowNotFound) return null;
      throw statusError(opts.label, res.status, opts.keyed === true);
    }
    try {
      return (await res.json()) as T;
    } catch {
      if (timedOut || ctx.signal?.aborted) throw failure();
      throw new FeedProviderError(`${opts.label} returned an unexpected response. Try again later.`, true, res.status);
    }
  } finally {
    clearTimeout(timer);
    ctx.signal?.removeEventListener("abort", onAbort);
  }
}

/** Run `fn` over items with at most `limit` in flight; results keep input order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i] as T, i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

// ---------------------------------------------------------------- values

export function asString(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

/** The value if it is an array, else []: one malformed field must not fail a whole board. */
export function asArray<T>(value: T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

/**
 * An http(s) URL from a provider payload, or undefined. Links end up in `href`s, so anything
 * else (javascript:, data:, relative paths) is dropped. The original string is kept as-is.
 */
export function httpUrl(value: unknown): string | undefined {
  const s = asString(value);
  if (!s) return undefined;
  try {
    const protocol = new URL(s).protocol;
    return protocol === "https:" || protocol === "http:" ? s : undefined;
  } catch {
    return undefined;
  }
}

export function asNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

/**
 * Normalise provider timestamps to ISO: epoch seconds or milliseconds (Himalayas documents ms but
 * sends seconds), ISO strings, "2026-08-27 07:29:25 UTC" (Recruitee) and date-only "2026-08-27".
 */
export function toIsoDate(value: unknown): string | undefined {
  let ms: number | undefined;
  const num = asNumber(value);
  if (num !== undefined && (typeof value === "number" || /^\d+$/.test(String(value).trim()))) {
    ms = num < 1e12 ? num * 1000 : num;
  } else if (typeof value === "string" && value.trim()) {
    let s = value.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s = `${s}T00:00:00Z`;
    else s = s.replace(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)\s*(?:UTC|GMT|Z)$/i, "$1T$2Z");
    ms = Date.parse(s);
  }
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return undefined;
  return new Date(ms).toISOString();
}

/** True when `iso` is within `days` of `now` (unknown dates pass). */
export function isWithinDays(iso: string | null | undefined, days: number, now: Date): boolean {
  if (!iso || !(days > 0)) return true;
  return Date.parse(iso) >= now.getTime() - days * 86_400_000;
}

/** Free-text employment type ("Full-time", "FullTime", "fulltime_permanent", "Contractor") -> enum. */
export function mapEmploymentType(value: unknown): EmploymentType | undefined {
  const s = typeof value === "string" ? value.toLowerCase().replace(/[^a-z]/g, "") : "";
  if (!s) return undefined;
  if (s.includes("intern") || s.includes("trainee")) return "internship";
  if (s.includes("parttime")) return "part_time";
  if (/contract|freelance|temporary|temp$|fixedterm|consult/.test(s)) return "contract";
  if (s.includes("fulltime") || s.includes("permanent")) return "full_time";
  return undefined;
}

/** Annual salary range from a min/max/period triple; only yearly or monthly amounts are converted. */
export function annualSalary(
  min: unknown,
  max: unknown,
  period: unknown,
  currency: unknown,
): { salaryMin?: number; salaryMax?: number; currency?: string } {
  const lo = asNumber(min);
  const hi = asNumber(max);
  const cur = asString(currency)?.toUpperCase();
  const p = typeof period === "string" ? period.toLowerCase() : "";
  const factor = /year|annual|annum/.test(p) ? 1 : /month/.test(p) ? 12 : 0;
  if (!factor || !cur || !/^[A-Z]{3}$/.test(cur)) return {};
  const a = lo !== undefined && lo > 0 ? Math.round(lo * factor) : undefined;
  const b = hi !== undefined && hi > 0 ? Math.round(hi * factor) : undefined;
  if (a === undefined && b === undefined) return {};
  return { salaryMin: a ?? b, salaryMax: b ?? a, currency: cur };
}

/** "pocket-fm" -> "Pocket Fm" (used only when an API gives no company name). */
export function prettifySlug(slug: string): string {
  return slug
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");
}

/** Remove undefined/null/empty-array entries so hints only carry real values. */
export function definedOnly<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0)) continue;
    out[k] = v;
  }
  return out as T;
}

// ---------------------------------------------------------------- locations

export function stripDiacritics(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/** Canonical city names produced by normalizeLocation for Indian cities. */
export const INDIA_CITIES = new Set([
  "Bengaluru",
  "Hyderabad",
  "Pune",
  "Mumbai",
  "Gurgaon",
  "Chennai",
  "Noida",
  "Delhi",
  "Kolkata",
  "Ahmedabad",
  "Jaipur",
  "Kochi",
  "Coimbatore",
  "Indore",
  "Chandigarh",
  "Thiruvananthapuram",
]);

const INDIA_PLACE_RE =
  /\b(india|bengaluru|bangalore|mumbai|bombay|navi mumbai|thane|pune|hyderabad|secunderabad|gachibowli|gurugram|gurgaon|new delhi|delhi|ncr|noida|chennai|kolkata|ahmedabad|gandhinagar|gift city|jaipur|kochi|cochin|trivandrum|thiruvananthapuram|coimbatore|indore|chandigarh|mohali|mysuru|mysore|mangaluru|mangalore|hubli|belagavi|nagpur|nashik|aurangabad|kolhapur|lucknow|bhubaneswar|vadodara|surat|rajkot|visakhapatnam|vizag|vijayawada|warangal|madurai|tiruchirappalli|trichy|kozhikode|thrissur|goa|bhopal|jabalpur|gwalior|kanpur|varanasi|patna|ranchi|raipur|guwahati|dehradun|ludhiana|amritsar|jodhpur|udaipur|faridabad|ghaziabad|manesar|karnataka|maharashtra|telangana|tamil nadu|kerala|gujarat|haryana|punjab|uttar pradesh|west bengal|rajasthan|andhra pradesh|madhya pradesh|odisha)\b/i;

let regionNames: Intl.DisplayNames | null = null;

/** ISO 3166 alpha-2 ("US", "eg") -> "United States"; other values are returned trimmed. */
export function countryName(value: string): string {
  const code = value.trim();
  if (!/^[a-z]{2}$/i.test(code)) return code;
  try {
    regionNames ??= new Intl.DisplayNames(["en"], { type: "region" });
    return regionNames.of(code.toUpperCase()) ?? code.toUpperCase();
  } catch {
    return code.toUpperCase();
  }
}

/** "IN", "in", "IND", "India" -> true. */
export function isIndiaCountry(value: string | null | undefined): boolean {
  return /^(in|ind|india)$/i.test((value ?? "").trim());
}

/** "India", "Pan India", "Anywhere in India", "All over India": any city in India, no particular one. */
export function isCountryWideIndia(value: string | null | undefined): boolean {
  const s = (value ?? "").toLowerCase().replace(/[^a-z]+/g, " ").trim();
  return /^(?:(?:pan|all|all over|across|anywhere in|any ?where in|any location in|any city in|multiple cities in) )?india$/.test(s);
}

/** Is this (normalised or raw) location in India? "Remote - India" counts. */
export function isIndiaLocation(location: string): boolean {
  if (location === REMOTE_INDIA) return true;
  if (location === REMOTE_GLOBAL) return false;
  return INDIA_CITIES.has(normalizeLocation(location)) || INDIA_PLACE_RE.test(stripDiacritics(location));
}

export interface PlaceInfo {
  /**
   * Canonical city, "Remote - India"/"Remote - Global", another cleaned place, or null (nothing
   * but work-mode words, e.g. a bare "Remote" whose country is unknown).
   */
  location: string | null;
  remote: boolean;
  hybrid: boolean;
  /** The text itself places this in India. */
  india: boolean;
}

const MODE_WORDS_RE = /\b(?:fully\s+)?remote\b|work from home|work from office|\bwfh\b|\bwfo\b|\bhybrid\b|\bon[- ]?site\b|\bin[- ]office\b/gi;

function titleCaseIfLower(value: string): string {
  return value === value.toLowerCase() ? value.replace(/\b[a-z]/g, (c) => c.toUpperCase()) : value;
}

function findIndianCity(value: string): string | null {
  const whole = normalizeLocation(value);
  if (INDIA_CITIES.has(whole)) return whole;
  for (const part of value.split(/[,/|()–]|\s-\s|-/)) {
    const city = normalizeLocation(part.trim());
    if (INDIA_CITIES.has(city)) return city;
  }
  return null;
}

/**
 * Clean one provider location string: strip diacritics ("Karnātaka") and empty segments
 * ("New Delhi, , India"), drop work-mode words ("Hybrid in Bangalore, India" -> Bengaluru) and map
 * remote markers: "Remote - India" -> REMOTE_INDIA, "Remote - Bengaluru" -> Bengaluru (remote),
 * "Remote (Worldwide)" -> REMOTE_GLOBAL. Remote jobs tied to another country keep that country
 * (never "Remote - India", which normalizeLocation would otherwise assume).
 */
export function normalizePlace(raw: string): PlaceInfo {
  const text = stripDiacritics(raw).replace(/\s+/g, " ").trim();
  const global = /\b(global|worldwide|anywhere|international)\b/i.test(text);
  const hybrid = /\bhybrid\b/i.test(text);
  const rest = text
    .replace(MODE_WORDS_RE, " ")
    .replace(/[()[\]]/g, " ")
    .split(",")
    .map((p) =>
      p
        .replace(/^[\s\-–|/:]+|[\s\-–|/:]+$/g, "")
        .replace(/^(?:based in|in|from|at)\s+/i, "")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter((p) => p && !/^(global|worldwide|anywhere|international)$/i.test(p))
    .join(", ");
  // "Worldwide" / "Anywhere" on its own is a remote listing too.
  const remote = /\bremote\b|work from home|\bwfh\b/i.test(text) || (global && !rest);
  const city = rest ? findIndianCity(rest) : null;
  // "Remote - IN" names the country by its ISO code.
  const india = city !== null || INDIA_PLACE_RE.test(rest) || isIndiaCountry(rest);

  if (remote) {
    if (global && !india) return { location: REMOTE_GLOBAL, remote, hybrid, india: false };
    if (city) return { location: city, remote, hybrid, india: true };
    if (india) return { location: REMOTE_INDIA, remote, hybrid, india: true };
    return { location: rest ? titleCaseIfLower(rest) : null, remote, hybrid, india: false };
  }
  if (city) return { location: city, remote, hybrid, india: true };
  if (!rest) return { location: null, remote, hybrid, india };
  if (india) {
    const first = rest.split(",")[0]!.trim();
    // "Pan India" / "Anywhere in India" / "IN" = the whole country, like a country-only listing.
    return { location: isCountryWideIndia(first) || isIndiaCountry(first) ? "India" : titleCaseIfLower(first), remote, hybrid, india };
  }
  return { location: titleCaseIfLower(rest), remote, hybrid, india };
}

/** Split multi-location strings: "Bengaluru, India; Mumbai, India", "Mumbai / Bangalore". */
export function splitPlaces(value: string): string[] {
  return value
    .split(/\s*(?:;|\||\/|\s&\s|\bor\b)\s*/i)
    .map((p) => p.trim())
    .filter(Boolean);
}

export interface PlaceSummary {
  locations: string[];
  workMode?: "remote" | "hybrid" | "onsite";
  india: boolean;
}

export interface PlaceFlags {
  /** A structured field (country code, etc.) says at least one location is in India. */
  india?: boolean;
  /** Structured country of the primary location (ISO2 or name), used when the text has none. */
  country?: string | null;
  remote?: boolean;
  hybrid?: boolean;
  onsite?: boolean;
  /** Split multi-location strings ("Mumbai / Bangalore"); default true. */
  split?: boolean;
}

/**
 * Build location + work-mode hints from provider strings and structured flags. A remote job in
 * India becomes "Remote - India" (plus any Indian cities it names); a remote job tied to another
 * country keeps that country ("Egypt", "California") so it is not mistaken for an India-remote
 * role. A bare "Remote" with no country information stays "Remote - India", the app-wide default.
 */
export function summarizePlaces(raws: (string | null | undefined)[], flags: PlaceFlags = {}): PlaceSummary {
  const parts = raws.flatMap((r) => (r && r.trim() ? (flags.split === false ? [r] : splitPlaces(r)) : []));
  const places = parts.map((p) => normalizePlace(p));
  const country = flags.country?.trim() || null;
  const india = flags.india === true || isIndiaCountry(country) || places.some((p) => p.india);
  const remote = flags.remote === true || places.some((p) => p.remote);
  const hybrid = !remote && (flags.hybrid === true || places.some((p) => p.hybrid));
  const labels = places.map((p) => p.location).filter((l): l is string => !!l);
  let locations: string[];
  if (remote) {
    const global = labels.includes(REMOTE_GLOBAL);
    const cities = labels.filter((l) => l !== REMOTE_INDIA && l !== REMOTE_GLOBAL);
    const indianCities = cities.filter((c) => isIndiaLocation(c) && !/^india$/i.test(c));
    if (india) locations = [REMOTE_INDIA, ...(global ? [REMOTE_GLOBAL] : []), ...indianCities];
    else if (global) locations = [REMOTE_GLOBAL];
    else if (cities.length > 0) locations = cities;
    else if (country) locations = [countryName(country)];
    else locations = [REMOTE_INDIA];
  } else {
    locations = labels;
  }
  const workMode = remote ? "remote" : hybrid ? "hybrid" : flags.onsite ? "onsite" : undefined;
  return { locations: [...new Set(locations)], workMode, india };
}
