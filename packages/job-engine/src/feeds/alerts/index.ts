import { createHash } from "node:crypto";
import { PLATFORM_LABELS, type JobPlatform } from "@applywise/types";
import type { RawImportedJob } from "../../connectors/types";
import type { AlertEmail, AlertParseResult } from "../types";
import { htmlCards, textCards, type AlertCard } from "./cards";
import type { CardFields } from "./fields";
import { decodeHtmlEntities } from "./html";
import { jobLinksInText, parseJobLink } from "./links";
import { matchAlertSender } from "./senders";

/**
 * Job-alert emails the user received (LinkedIn, Indeed, Naukri, Foundit, Instahyre, Cutshort,
 * Wellfound, Glassdoor, Hirist/iimjobs): every job card becomes one RawImportedJob with SNIPPET
 * text. Parsing is offline only - no link in the email is ever requested - and `raw` holds small
 * metadata, never the subject, body or recipient.
 */

export { ALERT_SETUP_GUIDES, type AlertSetupGuide } from "./guides";
export { JOB_ALERT_SENDER_DOMAINS, buildMailFilterQuery, isJobAlertSender } from "./senders";
export { parseJobLink as parseAlertJobLink, type JobLink as AlertJobLink } from "./links";

const MAX_JOBS_PER_MAIL = 50;
const MAX_PART_CHARS = 1_000_000;
/** Shorter text parts are stubs ("Please enable HTML"). */
const MIN_TEXT_CHARS = 60;
const MAX_SNIPPET_CHARS = 5000;

/**
 * Subjects of application-status mail, which can carry a job card but are not alerts. Each prefix has
 * one spelling only ("fwd?", not "fwd?|fw"): overlapping ones backtrack exponentially on "Fw: Fw: ...".
 */
const APPLICATION_UPDATE =
  /^(?:(?:re|fwd?)\s*:\s*)*(?:your application (?:was|has been|to|for|is)\b|application (?:submitted|received|viewed|status|update)\b|indeed application:|you applied\b|thanks for applying|thank you for applying)|\b(?:viewed|shortlisted|rejected) your application\b/i;

/** Parse a job-alert email from a known sender into one job per card. Never throws. */
export function parseJobAlertEmail(mail: AlertEmail): AlertParseResult {
  try {
    const match = matchAlertSender(mail?.from);
    if (!match) return { platform: null, jobs: [], notes: ["not a known job-alert sender"] };
    const platform = match.sender.platform;
    if (!match.jobMail) return { platform, jobs: [], notes: ["notification from the job site, not a job alert"] };
    if (typeof mail.subject === "string" && APPLICATION_UPDATE.test(mail.subject.slice(0, 300))) {
      return { platform, jobs: [], notes: ["application status update, not a job alert"] };
    }
    return readAlert(mail, platform, match.sender.label, match.domain);
  } catch {
    return { platform: null, jobs: [], notes: ["the email could not be read"] };
  }
}

/**
 * Parse an alert whose site is already known, e.g. one the user pasted without its headers.
 * Only for user-provided content: mailbox scans must go through parseJobAlertEmail (sender check).
 */
export function parseJobAlertEmailAs(mail: AlertEmail, platform: JobPlatform): AlertParseResult {
  try {
    return readAlert(mail, platform, PLATFORM_LABELS[platform] ?? platform, null);
  } catch {
    return { platform: null, jobs: [], notes: ["the email could not be read"] };
  }
}

/** The job site most job links in the content point to (needs 2+ distinct jobs), or null. */
export function detectAlertPlatformFromLinks(html: string | null, text: string | null): JobPlatform | null {
  const ids = new Map<JobPlatform, Set<string>>();
  const add = (href: string) => {
    const link = parseJobLink(href);
    if (!link?.id) return;
    const set = ids.get(link.platform) ?? new Set<string>();
    set.add(link.id);
    ids.set(link.platform, set);
  };
  if (typeof html === "string" && html.length <= MAX_PART_CHARS) {
    for (const m of html.matchAll(/\bhref\s*=\s*(?:"([^"]{1,4000})"|'([^']{1,4000})')/gi)) add(decodeHtmlEntities(m[1] ?? m[2] ?? ""));
  }
  if (typeof text === "string" && text.length <= MAX_PART_CHARS) for (const link of jobLinksInText(text)) if (link.id) add(link.url);
  const ranked = [...ids.entries()].sort((a, b) => b[1].size - a[1].size);
  const [first, second] = ranked;
  if (!first || first[1].size < 2 || (second && second[1].size * 2 > first[1].size)) return null;
  return first[0];
}

// ---------------------------------------------------------------- internals

function readAlert(mail: AlertEmail, platform: JobPlatform, label: string, senderDomain: string | null): AlertParseResult {
  const notes: string[] = [];
  const html = typeof mail?.html === "string" ? mail.html : "";
  const text = typeof mail?.text === "string" ? mail.text : "";
  const date = mail?.date instanceof Date && !Number.isNaN(mail.date.getTime()) ? mail.date : null;

  let cards: AlertCard[] = [];
  let linkCount = 0;
  if (html.length > MAX_PART_CHARS) notes.push("HTML part over 1 MB was ignored");
  else if (html.trim()) {
    const parsed = htmlCards(html, platform);
    cards = parsed.cards;
    linkCount = parsed.linkCount;
  }
  if (text.length > MAX_PART_CHARS) notes.push("text part over 1 MB was ignored");
  else if (text.trim().length >= MIN_TEXT_CHARS) {
    const fromHtml = cards.length > 0;
    const byKey = new Map(cards.map((c) => [c.key, c]));
    for (const t of textCards(text, platform)) {
      const same = byKey.get(t.key);
      if (same) fillMissing(same.fields, t.fields);
      // Opaque links get a key from the text itself: only trust them when the HTML found nothing.
      else if (!fromHtml || (t.link.id && !t.link.contentKey)) {
        cards.push(t);
        byKey.set(t.key, t);
      }
    }
    linkCount = Math.max(linkCount, byKey.size);
  }

  const jobs: RawImportedJob[] = [];
  const seen = new Set<string>();
  const strongContent = new Set<string>();
  let untitled = 0;
  const built = cards.flatMap((card) => {
    if (!card.fields.title) {
      untitled++;
      return [];
    }
    // Title + company (+ city) identify a posting; a title alone ("Software Engineer") does not.
    const content = card.fields.company ? contentHash(card.fields) : null;
    if (content && card.link.id && !card.link.contentKey) strongContent.add(content);
    return [{ card, content }];
  });
  for (const { card, content } of built) {
    const weak = !card.link.id || card.link.contentKey;
    // Glassdoor reissues ids per digest and opaque links change per mail: dedupe those on content.
    if (weak && content && strongContent.has(content)) continue;
    // Without a company the listing id (or the link itself) is the key: never merge unrelated jobs.
    const id = !weak ? card.link.id : content ? `h-${content}` : (card.link.id ?? `h-${sha1(card.link.url)}`);
    const externalId = `${card.link.platform.toLowerCase()}:${id}`;
    if (seen.has(externalId)) continue;
    seen.add(externalId);
    if (jobs.length >= MAX_JOBS_PER_MAIL) {
      notes.push(`only the first ${MAX_JOBS_PER_MAIL} jobs were kept`);
      break;
    }
    jobs.push(toRawJob(card, externalId, label, senderDomain, date));
  }
  if (untitled > 0) notes.push(`${untitled} job link(s) without a readable title were skipped`);
  if (linkCount > 0 && jobs.length === 0) notes.push("job links were found but no job cards could be read");
  if (linkCount === 0 && (html || text)) notes.push("no job links found");
  return { platform, jobs, notes };
}

function fillMissing(target: CardFields, source: CardFields): void {
  target.company ??= source.company;
  if (!target.locationText && source.locationText) {
    target.locationText = source.locationText;
    target.places = source.places;
  }
  target.workMode ??= source.workMode;
  if (!target.experienceText && source.experienceText) {
    target.experienceText = source.experienceText;
    target.experienceMin = source.experienceMin;
    target.experienceMax = source.experienceMax;
  }
  if (!target.salaryText && source.salaryText) {
    target.salaryText = source.salaryText;
    target.salary = source.salary;
  }
  target.jobType ??= source.jobType;
  target.employmentType ??= source.employmentType;
  target.skills ??= source.skills;
  target.age ??= source.age;
  if (target.details.length === 0) target.details = source.details;
}

const norm = (v: string | null | undefined) =>
  (v ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

const sha1 = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 16);

function contentHash(f: CardFields): string {
  return sha1([norm(f.title), norm(f.company), norm(f.places[0] ?? f.locationText)].join("|"));
}

/** "2 days ago" / "Just posted" / "22h" relative to the email date -> ISO date; "30+ days ago" -> undefined. */
export function postedAtFromAge(age: string | null, date: Date | null): string | undefined {
  if (!age || !date || /\+/.test(age)) return undefined;
  const a = age.toLowerCase();
  const DAY = 86_400_000;
  const hours = /(\d{1,3})\s*(?:hours?|hrs?|h)\b/.exec(a);
  if (hours) return Number(hours[1]) <= 60 * 24 ? new Date(date.getTime() - Number(hours[1]) * 3_600_000).toISOString() : undefined;
  if (/just posted|just now|today|few hours|\b(minutes?|mins?)\b|an? hour/.test(a)) return date.toISOString();
  if (/an? day ago/.test(a)) return new Date(date.getTime() - DAY).toISOString();
  if (/an? week ago/.test(a)) return new Date(date.getTime() - 7 * DAY).toISOString();
  const m = /(\d{1,2})\s*(days?|d|weeks?)\b/.exec(a);
  if (!m) return undefined;
  const days = Number(m[1]) * (/^w/.test(m[2]!) ? 7 : 1);
  return days <= 60 ? new Date(date.getTime() - days * DAY).toISOString() : undefined;
}

/** Card fields as labelled lines, so the job parser picks up skills, experience and salary. */
function snippetText(f: CardFields): string {
  const lines = [f.title ?? ""];
  if (f.company) lines.push(`Company: ${f.company}`);
  if (f.locationText) lines.push(`Location: ${f.locationText}`);
  if (f.experienceText) lines.push(`Experience: ${f.experienceText}`);
  if (f.salaryText) lines.push(`Salary: ${f.salaryText}`);
  if (f.jobType) lines.push(`Job type: ${f.jobType}`);
  if (f.skills) lines.push(`Skills: ${f.skills}`);
  lines.push(...f.details);
  return lines.join("\n").slice(0, MAX_SNIPPET_CHARS);
}

function toRawJob(card: AlertCard, externalId: string, label: string, senderDomain: string | null, date: Date | null): RawImportedJob {
  const { link, fields: f } = card;
  const hints: RawImportedJob["hints"] = {
    title: f.title ?? undefined,
    company: f.company ?? undefined,
    location: f.places.length ? f.places : undefined,
    workMode: f.workMode ?? undefined,
    employmentType: f.employmentType ?? undefined,
    applyUrl: link.url,
    postedAt: postedAtFromAge(f.age, date),
    salaryMin: f.salary?.min,
    salaryMax: f.salary?.max,
    currency: f.salary?.currency,
    experienceMinYears: f.experienceMin ?? undefined,
    experienceMaxYears: f.experienceMax ?? undefined,
  };
  for (const k of Object.keys(hints) as (keyof typeof hints)[]) if (hints[k] === undefined) delete hints[k];
  return {
    provider: link.platform,
    importMethod: "USER_MAILBOX_ALERT",
    externalId,
    sourceUrl: link.url,
    attribution: `${label} job alert (your email)`,
    // Small metadata only: never the subject, body or recipient.
    raw: { kind: "job_alert_email", platform: link.platform, jobId: link.id, senderDomain, receivedAt: date ? date.toISOString() : null },
    text: snippetText(f),
    descriptionLevel: "SNIPPET",
    hints,
  };
}
