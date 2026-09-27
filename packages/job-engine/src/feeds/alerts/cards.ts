import type { JobPlatform } from "@applywise/types";
import {
  AGE,
  BADGE,
  CTA_LINE,
  FOOTER,
  HEADER,
  INTRO,
  NON_JOB_TEXT,
  assignField,
  emptyFields,
  finishFields,
  isTitleText,
  nameTest,
  readCard,
  recipientNames,
  type CardFields,
} from "./fields";
import { findElement, findElements, parseHtml, tidyText, visibleLength, visibleLines, type HtmlElement } from "./html";
import { jobLinkKey, parseJobLink, type JobLink } from "./links";

/**
 * Job cards in an alert email. HTML: every anchor whose URL is a job link is a hit; the card is the
 * largest ancestor that holds no other job's link (and not too much text). Text parts: LinkedIn
 * "View job:" blocks, Indeed blocks ending in a URL line, or the lines around job URLs for other sites.
 */

export interface AlertCard {
  link: JobLink;
  key: string;
  fields: CardFields;
}

/** Links to other sites are ignored, except Indeed <-> Glassdoor (same company, shared templates). */
const LINK_FAMILY: Partial<Record<JobPlatform, JobPlatform[]>> = {
  INDEED: ["INDEED", "GLASSDOOR"],
  GLASSDOOR: ["GLASSDOOR", "INDEED"],
};
function linkAllowed(mailPlatform: JobPlatform, link: JobLink): boolean {
  return (LINK_FAMILY[mailPlatform] ?? [mailPlatform]).includes(link.platform);
}

/** Card text budget: digests hold many small cards; a single-job mail can be longer. */
const CARD_TEXT_DIGEST = 1500;
const CARD_TEXT_SINGLE = 30_000;
const DETAIL_CHARS_DIGEST = 600;
const DETAIL_CHARS_SINGLE = 4000;
/** Work bounds for hostile mails; real digests have 3-30 jobs (the caller keeps at most 50). */
const MAX_LINK_HITS = 2000;
const MAX_CARDS = 100;
/** Anchor text beyond this is never a title or a button label; reading stops there. */
const MAX_ANCHOR_CHARS = 2000;
/** Elements searched inside one anchor for a title or logo. */
const MAX_ANCHOR_NODES = 500;
/** Text lines kept around one job (text parts); older lines of a long run are dropped. */
const MAX_TEXT_CARD_LINES = 40;

interface Hit {
  a: HtmlElement;
  link: JobLink;
  key: string;
}

const EMPHASIS_CLASS = /(^|[\s_-])(font-bold|strong-text-link|job-?title|jobtitle|title)([\s_-]|$)/i;
function isEmphasis(el: HtmlElement): boolean {
  if (/^(b|strong|h[1-6])$/.test(el.name)) return true;
  if (EMPHASIS_CLASS.test(el.attrs.class ?? "")) return true;
  return /font-weight:\s*(bold|[6-9]00)/i.test(el.attrs.style ?? "");
}

/** Buttons ("View job", "This job is a bad match") are never titles, whatever their text. */
const BUTTON_CLASS = /(^|[\s_-])(button|btn|cta)([\s_-]|$)/i;
function isButton(a: HtmlElement): boolean {
  const style = a.attrs.style ?? "";
  return BUTTON_CLASS.test(a.attrs.class ?? "") || /(^|;)\s*background(-color)?\s*:\s*(?!transparent|none|#fff(fff)?\b|white)[#a-z]/i.test(style);
}

const anchorText = (el: HtmlElement) => tidyText(visibleLines(el, MAX_ANCHOR_CHARS).join(" "));

/** Title candidate from an anchor: 3 = in a heading / title class, 2 = bold, 1 = plain, 0 = none. */
function anchorTitle(a: HtmlElement): { text: string; score: number } {
  // A button, or a card-wide wrapper around other links.
  if (isButton(a) || findElement(a, (e) => e.name === "a", MAX_ANCHOR_NODES)) return { text: "", score: 0 };
  const strong = findElement(a, isEmphasis, MAX_ANCHOR_NODES);
  const text = anchorText(strong ?? a);
  if (!isTitleText(text)) return { text: "", score: 0 };
  const inHeading = !!a.parent && /^h[1-6]$/.test(a.parent.name);
  if (inHeading || EMPHASIS_CLASS.test(a.attrs.class ?? "") || EMPHASIS_CLASS.test(strong?.attrs.class ?? "")) return { text, score: 3 };
  return { text, score: strong || isEmphasis(a) ? 2 : 1 };
}

function logoAlt(a: HtmlElement): string | null {
  const img = findElement(a, (e) => e.name === "img" && !!e.attrs.alt?.trim(), MAX_ANCHOR_NODES);
  return img ? tidyText(img.attrs.alt!) : null;
}

export function htmlCards(html: string, platform: JobPlatform): { cards: AlertCard[]; linkCount: number } {
  const root = parseHtml(html);
  const hits: Hit[] = [];
  // Job links to other sites are never imported, but they still end the cards next to them.
  const bounds: Hit[] = [];
  for (const a of findElements(root, (e) => e.name === "a" && !!e.attrs.href)) {
    if (hits.length + bounds.length >= MAX_LINK_HITS) break;
    const link = parseJobLink(a.attrs.href!);
    if (!link) continue;
    const hit = { a, link, key: jobLinkKey(link) };
    if (!linkAllowed(platform, link)) {
      bounds.push(hit);
      continue;
    }
    const text = anchorText(a);
    if (text && (NON_JOB_TEXT.test(text) || (text.length <= 80 && FOOTER.test(text)))) continue;
    hits.push(hit);
  }
  if (hits.length === 0) return { cards: [], linkCount: 0 };

  // Distinct job keys below each ancestor (only "one" vs "more than one" matters).
  const keysAt = new Map<HtmlElement, Set<string>>();
  for (const h of [...hits, ...bounds]) {
    for (let e: HtmlElement | null = h.a; e; e = e.parent) {
      let set = keysAt.get(e);
      if (!set) keysAt.set(e, (set = new Set()));
      if (set.has(h.key) || set.size >= 2) break;
      set.add(h.key);
    }
  }
  const distinct = new Set(hits.map((h) => h.key)).size;
  const textLimit = distinct === 1 ? CARD_TEXT_SINGLE : CARD_TEXT_DIGEST;
  const detailChars = distinct === 1 ? DETAIL_CHARS_SINGLE : DETAIL_CHARS_DIGEST;
  const lengths = new Map<HtmlElement, number>();

  interface Group {
    link: JobLink;
    key: string;
    title: string | null;
    score: number;
    logo: string | null;
    /** Opaque redirects need a job-shaped anchor: a button / "Learn more" or an emphasised title. */
    jobShaped: boolean;
    cards: Set<HtmlElement>;
  }
  const groups = new Map<string, Group>();
  for (const h of hits) {
    let card = h.a;
    // The synthetic root counts too: an HTML fragment without <body> is one card when it holds one job.
    while (card.parent) {
      const keys = keysAt.get(card.parent);
      if (!keys || keys.size > 1 || visibleLength(card.parent, lengths) > textLimit) break;
      card = card.parent;
    }
    let g = groups.get(h.key);
    if (!g) {
      if (groups.size >= MAX_CARDS) continue;
      groups.set(h.key, (g = { link: h.link, key: h.key, title: null, score: 0, logo: null, jobShaped: false, cards: new Set() }));
    }
    g.cards.add(card);
    const t = anchorTitle(h.a);
    if (t.score > g.score) {
      g.title = t.text;
      g.score = t.score;
    }
    g.jobShaped ||= !h.link.opaque || t.score >= 2 || isButton(h.a) || CTA_LINE.test(anchorText(h.a));
    g.logo ??= logoAlt(h.a);
  }

  const mentionsReader = nameTest(recipientNames(visibleLines(root)));
  const cards: AlertCard[] = [];
  for (const g of groups.values()) {
    if (!g.jobShaped) continue;
    // The same job can appear twice (e.g. a repeated "top pick"): read the richest card.
    let best: HtmlElement | null = null;
    for (const el of g.cards) if (!best || visibleLength(el, lengths) > visibleLength(best, lengths)) best = el;
    const lines = best ? visibleLines(best, textLimit * 2) : [];
    const fields = readCard({ lines, title: g.title, platform, logoAlt: g.logo, detailChars, mentionsReader });
    cards.push({ link: g.link, key: g.key, fields });
  }
  return { cards, linkCount: cards.length };
}

// ---------------------------------------------------------------- text parts

const URL_RE = /https?:\/\/[^\s<>"'\])]+/gi;
const cleanUrl = (u: string) => u.replace(/[.,;:!?]+$/, "");
const HAS_URL = /https?:\/\/|\bwww\./i;
/** Separators left at a line end once its URL is cut ("Python Developer: <url>"); a loop, not a regex, so it stays linear. */
function trimSeparators(s: string): string {
  let i = s.length;
  while (i > 0 && /[\s:|–—-]/.test(s[i - 1]!)) i--;
  return s.slice(0, i);
}

function lines(block: string): string[] {
  return block
    .split("\n")
    .map((l) => tidyText(l))
    .filter(Boolean);
}

type LineTest = (line: string) => boolean;

/**
 * LinkedIn text/plain: cards separated by dashed rules, each ending with "View job: <url>"; the
 * lines since the previous card are title, company, location and badges.
 */
function linkedInTextCards(text: string, platform: JobPlatform, aboutReader: LineTest): AlertCard[] {
  const out: AlertCard[] = [];
  for (const block of text.split(/^[ \t]*-{8,}[ \t]*$/m)) {
    let chunk: string[] = [];
    for (const line of lines(block)) {
      if (!/^view job:\s*https?:\/\//i.test(line)) {
        chunk.push(line);
        continue;
      }
      const content = chunk.filter(
        (l) => !HEADER.test(l) && !INTRO.test(l) && !FOOTER.test(l) && !aboutReader(l) && !HAS_URL.test(l) && !(l.length > 80 && /[.!?]$/.test(l)),
      );
      chunk = [];
      const link = parseJobLink(cleanUrl(line.replace(/^view job:\s*/i, "")));
      const [title, company, location, ...more] = content;
      if (!link || !linkAllowed(platform, link) || !title || !isTitleText(title)) continue;
      const f = emptyFields(title);
      if (company && !BADGE.test(company)) assignField(f, "company", company);
      if (location && !BADGE.test(location)) assignField(f, "location", location);
      for (const l of more) if (BADGE.test(l) && f.badges.length < 6) f.badges.push(l);
      out.push({ link, key: jobLinkKey(link), fields: finishFields(f) });
      if (out.length >= MAX_CARDS) return out;
    }
  }
  return out;
}

/**
 * Indeed text/plain: title, "Company - Location", details and age, then the job URL on a line of its
 * own. The URL line ends a card, so cards need no blank line between them.
 */
function indeedTextCards(text: string, platform: JobPlatform, aboutReader: LineTest): AlertCard[] {
  const out: AlertCard[] = [];
  let chunk: string[] = [];
  for (const raw of text.split("\n")) {
    const line = tidyText(raw);
    if (!line) {
      chunk = [];
      continue;
    }
    if (!/^https?:\/\/\S+$/.test(line)) {
      if (!aboutReader(line)) chunk.push(line);
      if (chunk.length > MAX_TEXT_CARD_LINES) chunk.shift();
      continue;
    }
    const ls = chunk;
    chunk = [];
    const link = parseJobLink(cleanUrl(line));
    if (!link || !linkAllowed(platform, link)) continue;
    // Intro lines right above the first card ("3 new jobs: ...") are not its title.
    while (ls.length > 0 && (HEADER.test(ls[0]!) || INTRO.test(ls[0]!) || FOOTER.test(ls[0]!) || HAS_URL.test(ls[0]!))) ls.shift();
    const [title, companyLine] = ls;
    if (!title || !companyLine || !isTitleText(title)) continue;
    const f = emptyFields(title);
    const dash = companyLine.lastIndexOf(" - ");
    assignField(f, "company", dash > 0 ? companyLine.slice(0, dash) : companyLine);
    if (dash > 0) assignField(f, "location", companyLine.slice(dash + 3));
    let chars = 0;
    for (const d of ls.slice(2)) {
      if (BADGE.test(d)) {
        if (f.badges.length < 6) f.badges.push(d);
      } else if (AGE.test(d)) f.age ??= d.replace(/[()]/g, "").trim();
      else if (/₹|\$|a year|a month|an hour|per annum|lpa|lakhs?/i.test(d) && /\d/.test(d) && d.length <= 70) f.salaryText ??= d;
      else if (!CTA_LINE.test(d) && !FOOTER.test(d) && !HAS_URL.test(d) && !/\S@\S/.test(d) && chars < DETAIL_CHARS_DIGEST) {
        f.details.push(d);
        chars += d.length;
      }
    }
    out.push({ link, key: jobLinkKey(link), fields: finishFields(f) });
    if (out.length >= MAX_CARDS) break;
  }
  return out;
}

/** Any other site: the text around each job URL, split into blocks by rules or blank lines. */
function genericTextCards(text: string, platform: JobPlatform, aboutReader: LineTest): AlertCard[] {
  const rules = (text.match(/^[ \t]*[-=_*]{8,}[ \t]*$/gm) ?? []).length;
  const blocks = text.split(rules >= 2 ? /^[ \t]*[-=_*]{8,}[ \t]*$/m : /\n[ \t]*\n/);
  const out: AlertCard[] = [];
  let previous: string[] = [];
  const strip = (l: string) =>
    tidyText(trimSeparators(trimSeparators(l.replace(URL_RE, " ")).replace(/\b(view( job)?|apply( here| now)?|link|url|job link)$/i, "")));
  for (const block of blocks) {
    if (out.length >= MAX_CARDS) break;
    const ls = lines(block);
    // First and last line of each job's URLs, in order of first appearance.
    const keyed = new Map<string, { link: JobLink; first: number; last: number }>();
    ls.forEach((l, i) => {
      for (const m of l.matchAll(URL_RE)) {
        const link = parseJobLink(cleanUrl(m[0]));
        if (!link || !linkAllowed(platform, link)) continue;
        const key = jobLinkKey(link);
        const k = keyed.get(key);
        if (k) k.last = i;
        else keyed.set(key, { link, first: i, last: i });
      }
    });
    if (keyed.size === 0) {
      previous = ls;
      continue;
    }
    const jobs = [...keyed.values()];
    // "Title: <url>" lines, or a block that starts with its URL: each card runs down from its URL.
    // Otherwise the URL closes its card ("View: <url>" or a bare URL after the title and details).
    const urlFirst = jobs[0]!.first === 0 || jobs.every((k) => strip(ls[k.first]!) !== "");
    jobs.forEach((k, n) => {
      const [from, to] =
        jobs.length === 1 ? [0, ls.length] : urlFirst ? [k.first, jobs[n + 1]?.first ?? ls.length] : [n === 0 ? 0 : jobs[n - 1]!.last + 1, k.last + 1];
      let content = ls.slice(from, to).map(strip).filter(Boolean);
      if (content.length === 0 && previous.length > 0 && jobs.length === 1) content = previous;
      const fields = readCard({ lines: content, title: null, platform, detailChars: DETAIL_CHARS_DIGEST, mentionsReader: aboutReader });
      if (fields.title) out.push({ link: k.link, key: jobLinkKey(k.link), fields });
    });
    previous = [];
  }
  return out;
}

export function textCards(text: string, platform: JobPlatform): AlertCard[] {
  const t = text.replace(/\r\n?/g, "\n");
  const aboutReader = nameTest(recipientNames(lines(t)));
  if (platform === "LINKEDIN") {
    const cards = linkedInTextCards(t, platform, aboutReader);
    if (cards.length) return cards;
  }
  if (platform === "INDEED") {
    const cards = indeedTextCards(t, platform, aboutReader);
    if (cards.length) return cards;
  }
  return genericTextCards(t, platform, aboutReader);
}
