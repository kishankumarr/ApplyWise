import type { EmploymentType, JobPlatform, JobWorkMode } from "@applywise/types";
import { extractLocationsFromText, normalizeLocation } from "../../locations";
import { extractSkillsFromText } from "../../taxonomy";
import { tidyText } from "./html";

/**
 * Field picking inside one job card (the visible lines around a job link). Provider layouts drift,
 * so this is deliberately heuristic but conservative: a value is only kept when it is explicit in
 * the card (labelled, or in a recognisable position/shape), otherwise it is left empty.
 */

export interface CardFields {
  title: string | null;
  company: string | null;
  /** Location as shown, e.g. "Bengaluru, Karnataka, India (Hybrid)". */
  locationText: string | null;
  /** City-level places for the job parser, e.g. ["Bengaluru"] or ["Remote"]. */
  places: string[];
  workMode: JobWorkMode | null;
  experienceText: string | null;
  experienceMin: number | null;
  experienceMax: number | null;
  salaryText: string | null;
  salary: SalaryRange | null;
  jobType: string | null;
  employmentType: EmploymentType | null;
  skills: string | null;
  age: string | null;
  badges: string[];
  /** Remaining job content (snippet / description lines), greetings and footers removed. */
  details: string[];
}

export interface SalaryRange {
  min: number;
  max: number;
  currency: string;
}

// ---------------------------------------------------------------- line classes

/** Regex alternation from a list, so the vocabularies below stay readable. */
const alt = (parts: string[]) => parts.join("|");

const CTA_WORDS = alt([
  "view job", "view jobs", "view details", "view", "view & apply", "view and apply", "job details", "details",
  "apply", "apply now", "quick apply", "apply on company site", "see job", "see details",
  "learn more", "know more", "read more", "more info", "more details",
  "i am interested", "i'm interested", "interested", "not interested", "this job is a bad match", "bad match",
  "save", "save job", "share", "dismiss", "reply", "reply now", "reply to [a-z]+", "chat now", "message",
  "ver empleo", "se job",
]);
// One separator form per position (spaces, or symbols with optional spaces).
const CTA_SEP = "(?:\\s+|\\s*[|·•>»→:-]+\\s*|$)";
const CTA_LINE_RE = new RegExp(`^(?:(?:${CTA_WORDS})${CTA_SEP})+$`, "i");
/** Button rows are short; the length cap matters: "view details" also parses as "view" + "details", so a
 * long run of them backtracks exponentially against the end anchor. */
const MAX_CTA_LINE = 120;
export const CTA_LINE = { test: (line: string): boolean => line.length <= MAX_CTA_LINE && CTA_LINE_RE.test(line) };
// No end anchor: the greedy loop stops at the first non-button word without backtracking.
const CTA_PREFIX = new RegExp(`^(?:(?:${CTA_WORDS})${CTA_SEP})+`, "i");
/** Button texts glued to the end of a line ("Lumen Ledger Learn more"). */
const CTA_SUFFIX = /(?:\s+(?:learn more|know more|read more|more info|view job|view details|view & apply|apply now|apply))+$/i;
export const BADGE =
  /^(actively recruiting|actively hiring|this company is actively hiring|easy apply|easily apply|be an early applicant|early applicant|fast growing|promoted|sponsored|reposted|new|urgently hiring|hiring multiple candidates|top applicant|responsive employer|featured|hot job|verified|premium|in your network|\d+ (?:connections?|school alumni|alumni)(?: work here)?|\d+\+? applicants?)$/i;
export const AGE =
  /^\(?\s*(?:posted\s*:?\s*)?(just posted|just now|today|few hours ago|an? (?:hour|day|week) ago|\d{1,2}\+?\s*(?:minutes?|mins?|hours?|hrs?|days?|weeks?|months?)\s*ago|\d{1,2}\s*[hd])\s*\)?$/i;
const RATING = /^(?:\d(?:\.\d)?\s*(?:★|☆|stars?)?\s*(?:\(?\s*[\d,.]+k?\s*reviews?\s*\)?)?|★|☆|\(?\s*[\d,.]+k?\s*reviews?\s*\)?)$/i;
const GREETING = /^(dear|hi|hello|hey|greetings|namaste|hola)\b/i;
/** Quoted headers of a forwarded email ("From: ...", "To: ...") and forward markers: never job content. */
const MAIL_HEADER = /^(-{2,}\s*(forwarded|original) message\s*-{2,}|begin forwarded message:?|(from|to|cc|bcc|date|sent|subject|reply-to)\s*:)/i;
const EMAIL_ADDRESS = /[^\s@<>()]{1,64}@[^\s@<>()]{1,253}\.[a-z]{2,}/i;
const SIGN_OFF = /^(regards|best regards|warm regards|kind regards|thanks(?: (?:and|&) regards)?|thank you|sincerely|cheers|best wishes|best)[,!.]?$/i;
const FOOTER_RE = new RegExp(
  `^(${alt([
    "see all", "view all", "show all", "see more", "view more", "more jobs", "search (for )?(more )?jobs",
    "pause (these|this|all|job) (e-?mails?|alerts?|notifications)", "stop (these )?(e-?mails|alerts)",
    "this (e-?mail|message) was (intended|sent) (for|to)", "you('re| are) receiving", "you('re| are) getting this", "you received this",
    "you have received", "update (your )?(e-?mail |notification |alert )?preferences", "view (this e-?mail |it )?(in (a |your )?browser|online)",
    "(e-?mail|notification|account) settings$", "contact us$",
    "why am i (getting|receiving)", "learn why we included this", "if you (no longer|don'?t) want",
    "unsubscribe", "manage (your )?(job )?alerts?", "modify this alert", "delete this alert", "create (another|a new) (job )?alert",
    "edit (this )?alert", "change (your )?(e-?mail |communication )?(settings|preferences)", "e-?mail preferences",
    "are these jobs relevant", "was this (e-?mail|mail) (useful|helpful)", "don'?t share this e-?mail", "this e-?mail contains secure links",
    "download (the )?\\S+ app", "get the app", "©", "\\(c\\)\\s*\\d{4}", "copyright", "privacy policy", "terms (of|and)",
    "help cent(er|re)", "follow us", "connect with us",
  ])})|^(indeed|linkedin( corporation)?|naukri(\\.com)?|glassdoor|foundit|wellfound|instahyre|cutshort|hirist|iimjobs)$`,
  "i",
);
/** Footer / navigation lines, also when led by button texts ("Learn more Pause these emails"). */
export const FOOTER = {
  test(line: string): boolean {
    if (FOOTER_RE.test(line) || FOOTER_RE.test(line.replace(CTA_PREFIX, ""))) return true;
    // Navigation rows: "Acme · Get the app · Unsubscribe"
    const parts = line.length <= 200 ? line.split(/\s+[·•|]\s+/) : [];
    return parts.length >= 2 && parts.some((p) => FOOTER_RE.test(p) || NON_JOB_TEXT.test(p));
  },
};
/** Digest intros ("Your job alert for ...", "3 new jobs match ..."): never a job title. */
export const HEADER = new RegExp(
  `^(${alt([
    "your job alert for", "your job alert has been created", "you'll receive notifications", "you will receive",
    "jobs? you may be interested in", "recommended (jobs )?for you", "top job picks", "new jobs? (for you|match)", "a new job matches",
    "\\d+\\+?\\s+new (jobs?|opportunit)", "we found \\d+", "here are (your|\\d+|some)", "job alert\\b", "jobs based on your",
    "based on your (profile|preferences|activity)", "indeed job alert", "jobs \\d+\\s*-\\s*\\d+ of", "see matching results",
    "i('ve| have) found \\d+",
  ])})`,
  "i",
);
/** "Asha, jobs for Data Scientist in Bengaluru": a name, a comma, then words that talk to the reader. */
const VOCATIVE = /^\p{Lu}\p{Ll}+,\s+(?:here|we|you|your|these|this|there|check|see|new|top|recommended|the|an?|jobs?|\d+)\b/u;
const INTRO_RE = new RegExp(
  `\\b(${alt([
    "your (job )?alerts?", "your (saved )?search(es)?", "your (profile|preferences|resume|cv|skills)", "match(es|ing)? your",
    "(jobs?|picked|recommended|curated|selected) for you", "hand-?picked", "we (have )?(found|picked)", "i('ve| have) found",
    "you (may|might) (be interested|like)", "based on your", "new jobs? (for|match|in|near)", "\\d+\\+? (new )?jobs? (for|match|in|near)",
    "jobs? matching",
  ])})\\b`,
  "i",
);
/** Lines addressed to the reader ("Asha, 3 new jobs for python developer", "... match your preferences"): never card fields. */
export const INTRO = { test: (line: string): boolean => INTRO_RE.test(line) || VOCATIVE.test(line) };

const NOT_A_NAME = /^(there|all|team|everyone|folks|friends?|candidates?|jobseekers?|job|user|member|sir|madam|ma'?am|hr|recruiter|applicant|again|and|from|dear)$/i;
/** "Hello Data Scientist,": a greeting by role or skill is not a name (dropping those lines would drop the jobs). */
const ROLE_WORD =
  /^(senior|junior|lead|principal|staff|chief|head|data|software|backend|frontend|full|web|mobile|cloud|product|project|program|sales|marketing|business|finance|hr|qa|test|devops|machine|engineers?|developers?|designers?|managers?|analysts?|scientists?|architects?|consultants?|professionals?|freshers?|graduates?|interns?)$/i;
/** First names the mail greets the reader with ("Hi Asha,", "Dear Asha Example", "intended for Asha Example"). */
export function recipientNames(lines: readonly string[]): string[] {
  const names = new Set<string>();
  for (const line of lines) {
    if (line.length > 300) continue;
    // Case-sensitive on purpose (with /i, \p{Lu} would match any letter): the name is capitalised.
    const m = /^(?:[Dd]ear|[Hh]i|[Hh]ello|[Hh]ey|[Nn]amaste|[Hh]ola)[\s,]+(\p{Lu}[\p{L}'’-]{1,30})/u.exec(line) ?? /\bintended for\s+(\p{Lu}[\p{L}'’-]{1,30})/u.exec(line);
    const name = m?.[1];
    if (name && !NOT_A_NAME.test(name) && !ROLE_WORD.test(name) && extractSkillsFromText(name).length === 0) names.add(name);
    if (names.size >= 3) break;
  }
  return [...names];
}

/** Test for lines that mention the reader by name; such lines are never kept (they are about the reader, not the job). */
export function nameTest(names: readonly string[]): (line: string) => boolean {
  if (names.length === 0) return () => false;
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![\\p{L}\\p{N}])`, "u");
  return (line) => re.test(line);
}

/** Anchor texts that mark a link as navigation even when its URL looks like a job. */
export const NON_JOB_TEXT =
  /^((see|view|show|browse|explore)\s+(all|more|similar)\b.*|(more|similar)\s+jobs\b.*|unsubscribe|settings|preferences|help|privacy( policy)?|terms( of (use|service))?|feedback|report( this job)?|manage (your )?(job )?alerts?)$/i;
/** Short section headings that introduce a value on the next line (Indeed match mails, Wellfound). */
const HEADINGS: [RegExp, Field][] = [
  [/^(pay|salary|ctc|compensation)$/i, "salary"],
  [/^(job type|employment type)$/i, "jobType"],
  [/^(location|job location|locations)$/i, "location"],
  [/^(key ?skills|skills|skills required|required skills|tech stack)$/i, "skills"],
  [/^(experience|work experience)$/i, "experience"],
  [/^(job description( preview)?|description|about the (job|role)|our take|responsibilities|job summary|role overview)$/i, "description"],
  [/^(benefits|perks)$/i, "description"],
];

type Field = "title" | "company" | "location" | "experience" | "salary" | "skills" | "mode" | "jobType" | "posted" | "description" | "detail";

const LABELS: [string, Field][] = [
  ["job title|designation|position|job role", "title"],
  ["company name|company|employer|organi[sz]ation|hiring company", "company"],
  ["job location|work location|locations?|city", "location"],
  ["work experience|experience required|experience|exp", "experience"],
  ["ctc|salary|package|compensation|pay|stipend", "salary"],
  ["key ?skills|skills required|required skills|skills|tech stack", "skills"],
  ["work mode|workplace type|workplace", "mode"],
  ["job type|employment type", "jobType"],
  ["posted on|date posted|posted", "posted"],
  ["job description|about the job|about the role|description|responsibilities", "description"],
  ["notice period|openings|education|qualification|industry|department|role category|functional area", "detail"],
];
const LABEL_FIELD = new Map<string, Field>();
const LABEL_ALT = LABELS.map(([alt]) => alt).join("|");
const LABEL_RE = new RegExp(`(?<![\\p{L}\\p{N}])(${LABEL_ALT})\\s*[:：]\\s*`, "giu");
const LABEL_AT_START = new RegExp(`^(?:[-•*]\\s*)?(${LABEL_ALT})\\s*[:：]`, "iu");
function labelField(label: string): Field {
  const key = label.toLowerCase();
  const cached = LABEL_FIELD.get(key);
  if (cached) return cached;
  const field = LABELS.find(([alt]) => new RegExp(`^(${alt})$`, "i").test(key))?.[1] ?? "detail";
  LABEL_FIELD.set(key, field);
  return field;
}

// ---------------------------------------------------------------- values

const EXP_RANGE = /(\d{1,2}(?:\.\d)?)\s*(?:-|–|—|to)\s*(\d{1,2}(?:\.\d)?)\s*\+?\s*(?:yrs?|years?)\b/i;
const EXP_MIN = /(\d{1,2})\s*\+\s*(?:yrs?|years?)\b/i;

/** "3-6 Yrs" -> {3, 6}; "5+ years" -> {5, null}. */
function parseExperience(text: string): { min: number | null; max: number | null } {
  const r = EXP_RANGE.exec(text);
  if (r) {
    const a = Number(r[1]);
    const b = Number(r[2]);
    if (a <= 40 && b <= 50) return { min: Math.min(a, b), max: Math.max(a, b) };
  }
  const m = EXP_MIN.exec(text);
  return m ? { min: Number(m[1]), max: null } : { min: null, max: null };
}

const SALARY_RE =
  /(₹|rs\.?|inr|\$|usd|€|eur|£|gbp)?\s?(\d[\d,]*(?:\.\d+)?)\s?(k|lpa|lacs?|lakhs?|lac|l|cr|crores?|m)?(?![a-z])(?:\s?\/\s?(?:yr|year|mo|month))?\s?(?:-|to)\s?(₹|rs\.?|inr|\$|usd|€|eur|£|gbp)?\s?(\d[\d,]*(?:\.\d+)?)\s?(k|lpa|lacs?|lakhs?|lac|l|cr|crores?|m)?(?![a-z])/g;
const CURRENCIES: Record<string, string> = { "₹": "INR", rs: "INR", "rs.": "INR", inr: "INR", $: "USD", usd: "USD", "€": "EUR", eur: "EUR", "£": "GBP", gbp: "GBP" };
const UNIT_FACTOR: Record<string, number> = { k: 1e3, l: 1e5, lpa: 1e5, lac: 1e5, lacs: 1e5, lakh: 1e5, lakhs: 1e5, cr: 1e7, crore: 1e7, crores: 1e7, m: 1e6 };

/**
 * An explicit, unambiguous pay range as an annual amount: "12-18 Lacs PA", "₹6,00,000 - ₹9,00,000 a year",
 * "₹18L/yr - ₹28L/yr", "₹35,000 - ₹50,000 a month" (x12). Hourly pay, estimates and bare numbers -> null.
 */
function parseSalary(text: string): SalaryRange | null {
  const s = text.toLowerCase().replace(/[–—]/g, "-").replace(/\s+/g, " ");
  if (/\best(\.|imate)|glassdoor est/.test(s)) return null;
  for (const m of s.matchAll(SALARY_RE)) {
    const [whole, cur1, n1, u1, cur2, n2, u2] = m;
    const unitA = u1 ?? u2;
    const unitB = u2 ?? u1;
    const currency = CURRENCIES[cur1 ?? cur2 ?? ""] ?? (unitB && /^(l|lpa|lacs?|lakhs?|lac|cr|crores?)$/.test(unitB) ? "INR" : undefined);
    if (!currency || !n1 || !n2) continue;
    const a = Number(n1.replace(/,/g, "")) * (unitA ? (UNIT_FACTOR[unitA] ?? 1) : 1);
    const b = Number(n2.replace(/,/g, "")) * (unitB ? (UNIT_FACTOR[unitB] ?? 1) : 1);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) continue;
    const after = s.slice((m.index ?? 0) + whole.length, (m.index ?? 0) + whole.length + 20);
    const inner = whole;
    let factor: number | null = null;
    if (/^\s*(?:\/|a|an|per|p\.?)?\s*(?:hour|hr|week|day)\b/.test(after)) continue;
    if (/^\s*(?:\/|a|per)?\s*(?:month|mo)\b/.test(after) || /\/\s?(?:mo|month)/.test(inner)) factor = 12;
    else if (/^\s*(?:\/|a|an|per)?\s*(?:year|yr|annum|p\.?\s?a\b)/.test(after) || /\/\s?(?:yr|year)/.test(inner) || unitB === "lpa") factor = 1;
    else if (unitB && /^(l|lacs?|lakhs?|lac|cr|crores?)$/.test(unitB)) factor = 1; // "12-18 Lacs" is annual CTC by convention
    else if ((currency === "INR" && a >= 100_000) || (currency !== "INR" && a >= 10_000)) factor = 1;
    if (!factor) continue;
    const min = Math.round(Math.min(a, b) * factor);
    const max = Math.round(Math.max(a, b) * factor);
    if (max > 1e9) continue;
    return { min, max, currency };
  }
  return null;
}

const SALARY_HINT = /₹|\brs\.?\s?\d|\binr\b|\$\s?\d|€\s?\d|£\s?\d|\blpa\b|\blacs?\b|\blakhs?\b|\bctc\b|\bper (annum|month)\b|\ba (year|month)\b/i;
function isSalaryOnly(line: string): boolean {
  if (/^not disclosed$/i.test(line)) return true;
  return line.length <= 70 && /\d/.test(line) && SALARY_HINT.test(line) && !EXP_RANGE.test(line) && line.split(/\s+/).length <= 10;
}
function isSalaryText(text: string): boolean {
  return /^not disclosed$/i.test(text.trim()) || parseSalary(text) !== null || (SALARY_HINT.test(text) && /\d/.test(text));
}

function employmentTypeOf(value: string): EmploymentType | null {
  const v = value.toLowerCase();
  if (/\bintern(ship)?\b/.test(v)) return "internship";
  if (/\bpart[- ]?time\b/.test(v)) return "part_time";
  if (/\b(contract|contractor|freelance|temporary|c2h)\b/.test(v)) return "contract";
  if (/\bfull[- ]?time\b|\bpermanent\b/.test(v)) return "full_time";
  return null;
}
const JOB_TYPE_ONLY = /^(full[- ]?time|part[- ]?time|permanent|contract(ual)?|contract to hire|internship|freelance|temporary)(\s*[,/&+]\s*(full[- ]?time|part[- ]?time|permanent|contract(ual)?|internship|freelance|temporary))*$/i;

function workModeOf(value: string): JobWorkMode | null {
  if (/hybrid/i.test(value)) return "hybrid";
  if (/remot|work from home|\bwfh\b/i.test(value)) return "remote";
  if (/on-?site|in[- ]office|work from office|\bwfo\b|presencial/i.test(value)) return "onsite";
  return null;
}

// ---------------------------------------------------------------- places

const STATES = new Set([
  "andhra pradesh", "arunachal pradesh", "assam", "bihar", "chhattisgarh", "goa", "gujarat", "haryana", "himachal pradesh",
  "jharkhand", "karnataka", "kerala", "madhya pradesh", "maharashtra", "manipur", "meghalaya", "mizoram", "nagaland", "odisha",
  "orissa", "punjab", "rajasthan", "sikkim", "tamil nadu", "telangana", "tripura", "uttar pradesh", "uttarakhand", "west bengal",
  "jammu and kashmir", "jammu & kashmir", "ladakh", "puducherry", "pondicherry", "andaman and nicobar islands", "lakshadweep",
]);
const COUNTRIES = new Set([
  "india", "united states", "usa", "us", "united kingdom", "uk", "singapore", "united arab emirates", "uae", "germany", "canada",
  "australia", "netherlands", "ireland", "france", "japan", "switzerland", "sweden", "spain", "argentina", "brazil", "mexico",
  "denmark", "norway", "finland", "poland", "portugal", "italy", "israel", "saudi arabia", "qatar", "new zealand", "philippines",
  "indonesia", "malaysia", "vietnam", "sri lanka", "bangladesh", "nepal",
]);
/** Indian cities beyond the alias table in ../../locations (only used to recognise a line as a place). */
const MORE_CITIES = new Set([
  "nagpur", "lucknow", "vadodara", "baroda", "surat", "bhubaneswar", "visakhapatnam", "vizag", "mysuru", "mysore", "mangaluru",
  "mangalore", "nashik", "bhopal", "patna", "ranchi", "guwahati", "dehradun", "ludhiana", "kanpur", "madurai", "tiruchirappalli",
  "trichy", "vijayawada", "raipur", "amritsar", "jodhpur", "udaipur", "gandhinagar", "ghaziabad", "faridabad", "kozhikode",
  "calicut", "thrissur", "hubli", "hubballi", "belgaum", "belagavi", "jamshedpur", "varanasi", "agra", "meerut", "prayagraj",
  "allahabad", "aurangabad", "rajkot", "jalandhar", "siliguri", "durgapur", "vellore", "salem", "tirupati", "warangal", "guntur",
  "pan india", "anywhere in india",
]);
const MODE_WORDS = /^(remote( ok| friendly| first)?|remote-(friendly|first)|hybrid|on-?site|in-?office|work from home|wfh|work from office|anywhere|multiple locations?|pan india)$/i;
const MODE_PART = /^(remote( ok| friendly| first)?|remote-(friendly|first)|hybrid|on-?site|in-?office|work from home|wfh|work from office)$/i;

function isStateOrCountry(part: string): boolean {
  const p = part.toLowerCase().trim();
  return STATES.has(p) || COUNTRIES.has(p);
}

function isPlacePart(part: string): boolean {
  const p = part.replace(/\([^()]*\)/g, "").trim();
  if (!p || p.length > 40) return false;
  const lower = p.toLowerCase();
  if (isStateOrCountry(lower) || MORE_CITIES.has(lower) || MODE_WORDS.test(lower)) return true;
  return extractLocationsFromText(p).includes(normalizeLocation(p));
}

function splitPlaces(value: string): string[] {
  return value
    .split(/\s*(?:[,/|;]|\s&\s|\sor\s)\s*/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/** A line that is clearly a place: "Bengaluru, Karnataka", "Hybrid work in Pune", "India (Remote)". */
function isPlaceLine(line: string): boolean {
  if (line.length > 100 || /\d{3,}/.test(line)) return false;
  const loc = parseLocation(line);
  if (loc.prefixedMode) return true;
  const parts = splitPlaces(line.replace(/\s*\([^()]*\)\s*$/, ""));
  return parts.length > 0 && parts.every(isPlacePart);
}
const CITY_REGION = /^[A-Z][\p{L}.' -]{1,40}(?:,\s*[A-Z][\p{L}.' -]{1,40}){1,3}$/u;

interface ParsedLocation {
  places: string[];
  mode: JobWorkMode | null;
  /** True when the text itself says how the job is worked ("Hybrid work in X", "(Remote)", "Remote"). */
  prefixedMode: boolean;
}

/** "Bengaluru, Karnataka, India (Hybrid)" -> ["Bengaluru"], hybrid; "India (Remote)" -> ["Remote"], remote. */
function parseLocation(raw: string): ParsedLocation {
  let s = tidyText(raw);
  let mode: JobWorkMode | null = null;
  let prefixedMode = false;
  const paren = /\s*\(([^()]{2,40})\)\s*$/.exec(s);
  const parenMode = paren ? workModeOf(paren[1]!) : null;
  if (paren && parenMode) {
    mode = parenMode;
    prefixedMode = true;
    s = s.slice(0, paren.index).trim();
  } else if (paren && MODE_WORDS.test(s.slice(0, paren.index).trim())) {
    // "Remote (India)", "Hybrid (Pune)"
    mode = workModeOf(s.slice(0, paren.index));
    prefixedMode = true;
    s = paren[1]!.trim();
  }
  const pre = /^(hybrid(?: work| remote)?|remote|fully remote|on-?site|in-?office|work from home|wfh)\s+(?:in|at|from|-|–)\s+(.+)$/i.exec(s);
  if (pre) {
    mode ??= workModeOf(pre[1]!);
    prefixedMode = true;
    s = pre[2]!.trim();
  }
  if (MODE_WORDS.test(s)) {
    mode ??= workModeOf(s);
    prefixedMode = true;
    s = /^(remote|work from home|wfh)$/i.test(s) ? "" : /^(hybrid|on-?site|in-?office|work from office)$/i.test(s) ? "" : s;
  }
  // "Bengaluru, Remote OK": the mode part is not a place.
  const all = splitPlaces(s).filter((p) => p.length <= 60);
  const modePart = all.find((p) => MODE_PART.test(p));
  if (modePart) {
    mode ??= workModeOf(modePart);
    prefixedMode = true;
  }
  const parts = all.filter((p) => !MODE_PART.test(p));
  const cities = parts.filter((p) => !isStateOrCountry(p));
  let places = cities.length ? cities : parts;
  if (mode === "remote" && places.every((p) => /^india$/i.test(p))) places = ["Remote"];
  const seen = new Set<string>();
  places = places.filter((p) => {
    const k = p.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { places: places.slice(0, 8), mode, prefixedMode };
}

// ---------------------------------------------------------------- card reading

function isSentence(line: string): boolean {
  const words = line.split(/\s+/).length;
  return line.length > 100 || (/[.!?…]$/.test(line) && words > 6) || words > 16;
}

/** Plausible job title text (anchor text or a card line). */
export function isTitleText(text: string): boolean {
  const t = text.trim();
  if (t.length < 2 || t.length > 150) return false;
  if (CTA_LINE.test(t) || NON_JOB_TEXT.test(t) || BADGE.test(t) || AGE.test(t) || RATING.test(t)) return false;
  if (GREETING.test(t) || FOOTER.test(t) || HEADER.test(t) || INTRO.test(t) || SIGN_OFF.test(t) || MAIL_HEADER.test(t)) return false;
  if (/^https?:\/\/|^www\.|@/.test(t) || !/\p{L}{2}/u.test(t)) return false;
  if (isSalaryOnly(t) && !/[a-z]{4,}.*[a-z]{4,}/i.test(t.replace(/lacs?|lakhs?|year|month|annum/gi, ""))) return false;
  return !(/[.!?]$/.test(t) && t.split(/\s+/).length > 8);
}

function cleanTitle(value: string): string {
  return tidyText(value.replace(/^(?:job title|designation|position|job role)\s*[:：]\s*/i, "")).slice(0, 200);
}
function cleanCompany(value: string): string | null {
  const c = tidyText(value.replace(/\s+\d(?:\.\d)?\s*★.*$/, "").replace(/\s*[|·]\s*$/, ""));
  return c && c.length <= 100 && !isSentence(c) && !/^https?:\/\//.test(c) ? c : null;
}
const GENERIC_ALT = /^(logo|company logo|image|linkedin|indeed|naukri|glassdoor|wellfound|foundit|icon|photo|profile)$/i;

const MAX_LINE = 1000;

interface CardInput {
  lines: string[];
  /** Title from the job link's anchor text, when it had one. */
  title: string | null;
  platform: JobPlatform;
  /** Company logo alt text (LinkedIn cards), used only when no company line is found. */
  logoAlt?: string | null;
  /** Max characters of description lines to keep. */
  detailChars: number;
  /** Lines naming the reader (from recipientNames) are dropped. */
  mentionsReader?: (line: string) => boolean;
}

/** Visible URLs can carry member tokens ("copy this link: ...?otpToken="): never kept in job text. */
const VISIBLE_URL = /\b(?:https?:\/\/|www\.)\S+/gi;

export function emptyFields(title: string | null = null): CardFields {
  return {
    title,
    company: null,
    locationText: null,
    places: [],
    workMode: null,
    experienceText: null,
    experienceMin: null,
    experienceMax: null,
    salaryText: null,
    salary: null,
    jobType: null,
    employmentType: null,
    skills: null,
    age: null,
    badges: [],
    details: [],
  };
}

/** Set a field from an explicit value; returns false when the value does not fit the field. */
export function assignField(f: CardFields, field: Field, raw: string): boolean {
  const value = tidyText(raw).replace(/[|·,;]\s*$/, "").trim();
  if (!value || EMAIL_ADDRESS.test(value)) return false;
  switch (field) {
    case "title":
      if (!f.title && isTitleText(value)) f.title = cleanTitle(value);
      return true;
    case "company": {
      const c = cleanCompany(value);
      if (!c) return false;
      f.company ??= c;
      return true;
    }
    case "location":
      if (value.length > 120) return false;
      if (!f.locationText) {
        f.locationText = value;
        const loc = parseLocation(value);
        f.places = loc.places;
        f.workMode ??= loc.mode;
      }
      return true;
    case "experience":
      if (!/\d|fresher/i.test(value) || value.length > 40) return false;
      f.experienceText ??= value;
      return true;
    case "salary":
      if (value.length > 80 || !isSalaryText(value)) return false;
      f.salaryText ??= value;
      return true;
    case "skills":
      if (value.length > 400) return false;
      f.skills ??= value;
      return true;
    case "mode":
      f.workMode ??= workModeOf(value);
      return f.workMode !== null;
    case "jobType":
      if (value.length > 60) return false;
      f.jobType ??= value;
      f.employmentType ??= employmentTypeOf(value);
      return true;
    case "posted":
      if (!AGE.test(value)) return false;
      f.age ??= value.replace(/[()]/g, "").trim();
      return true;
    case "description":
    case "detail":
      return false;
  }
}

/** "Label: value Label: value" segments when the line starts with a known label. */
function labelledSegments(line: string): { field: Field; value: string; label: string }[] | null {
  if (line.length > 300 || !LABEL_AT_START.test(line)) return null;
  const marks = [...line.matchAll(LABEL_RE)];
  if (marks.length === 0) return null;
  return marks.map((m, i) => {
    const start = (m.index ?? 0) + m[0].length;
    const end = i + 1 < marks.length ? (marks[i + 1]!.index ?? line.length) : line.length;
    return { field: labelField(m[1]!), value: line.slice(start, end).trim(), label: m[1]! };
  });
}

function isSkillList(line: string): boolean {
  if (line.length > 300 || isSentence(line)) return false;
  const parts = line.split(/\s*[,|•·]\s*/).filter(Boolean);
  if (parts.length < 3 || parts.some((p) => p.length > 40) || parts.some(isPlacePart)) return false;
  return extractSkillsFromText(line).length > 0;
}

const SEGMENT_SEP = /\s+[·•|]\s+|\s*\|\s*/;

type Segment = "experience" | "salary" | "posted" | "jobType" | "place" | "other";
function segmentKind(s: string): Segment {
  if (EXP_RANGE.test(s) && s.length <= 30) return "experience";
  if (s.length <= 60 && isSalaryText(s)) return "salary";
  if (AGE.test(s)) return "posted";
  if (JOB_TYPE_ONLY.test(s)) return "jobType";
  if (isPlaceLine(s)) return "place";
  return "other";
}

/**
 * Meta lines split by " · ", " • " or " | ": "Company · Location (Hybrid)" (LinkedIn),
 * "Company · 3-6 yrs · Bengaluru" (Hirist), "3-6 Yrs | 12-18 Lacs PA | Pune, Mumbai" (Naukri).
 * Returns false when the line does not look like one.
 */
function readSegmentLine(f: CardFields, line: string): boolean {
  if (line.length > 160 || isSentence(line)) return false;
  const segs = line.split(SEGMENT_SEP).map((s) => s.trim()).filter(Boolean);
  if (segs.length < 2) return false;
  const kinds = segs.map(segmentKind);
  const known = kinds.filter((k) => k !== "other").length;
  // "Company · Location": the first part is the company when nothing else names it.
  const companyFirst = !f.company && kinds[0] === "other" && segs[0]!.length <= 80;
  // Two unknown parts: only "Company · Somewhere", never "React · TypeScript".
  const twoPart = companyFirst && segs.length === 2 && /^\p{Lu}/u.test(segs[1]!) && extractSkillsFromText(line).length === 0;
  if (known === 0 && !twoPart) return false;
  const places: string[] = [];
  segs.forEach((s, i) => {
    const kind = kinds[i]!;
    if (i === 0 && companyFirst) assignField(f, "company", s);
    else if (kind === "place") places.push(s);
    else if (kind === "experience") assignField(f, "experience", s);
    else if (kind === "salary") assignField(f, "salary", s);
    else if (kind === "posted") assignField(f, "posted", s);
    else if (kind === "jobType") assignField(f, "jobType", s);
    // An unrecognised last part next to experience/salary is usually a city we do not know.
    else if (i === segs.length - 1 && !places.length && s.length <= 40 && !/\d/.test(s)) places.push(s);
  });
  if (places.length) assignField(f, "location", places.join(", "));
  return true;
}

/** Read one card's visible lines into fields. Lines before the title (greetings, intros) are ignored. */
export function readCard(input: CardInput): CardFields {
  const aboutReader = input.mentionsReader ?? (() => false);
  // Very long lines are never card fields; cutting them keeps every check below cheap.
  const lines = input.lines.map((l) => tidyText(l).slice(0, MAX_LINE)).filter((l) => l && !MAIL_HEADER.test(l) && !aboutReader(l));
  let title = input.title && !aboutReader(input.title) ? cleanTitle(input.title) : null;
  let titleIdx = -1;
  if (title) {
    const t = title;
    titleIdx = lines.findIndex((l) => cleanTitle(l) === t);
    if (titleIdx < 0) titleIdx = lines.findIndex((l) => l.includes(t));
    // A title broken over several lines (<br> inside the link): index of its last line.
    for (let i = 0; titleIdx < 0 && i < lines.length; i++) {
      let acc = lines[i]!;
      let j = i;
      while (t.startsWith(acc) && acc.length < t.length && j + 1 < lines.length) acc = `${acc} ${lines[++j]!}`;
      if (acc === t) titleIdx = j;
    }
  } else {
    titleIdx = lines.findIndex((l) => isTitleText(l) && !isSentence(l));
    if (titleIdx >= 0) title = cleanTitle(lines[titleIdx]!);
  }
  const f = emptyFields(title);
  const pre = titleIdx >= 0 ? lines.slice(0, titleIdx) : [];
  const post = titleIdx >= 0 ? lines.slice(titleIdx + 1) : lines;
  if (titleIdx >= 0 && title) {
    // "Job Title: X   Company: Y" on one line: keep what follows the title.
    const line = lines[titleIdx]!;
    const after = line.slice(line.indexOf(title) + title.length).trim();
    if (after.length > 2 && LABEL_AT_START.test(after)) post.unshift(after);
  }
  const companyFirst = input.platform === "GLASSDOOR";
  if (companyFirst) {
    // Glassdoor cards: company, rating, title, location, salary, age.
    const c = [...pre].reverse().find((l) => !RATING.test(l) && !BADGE.test(l) && !HEADER.test(l) && !INTRO.test(l) && !GREETING.test(l) && !isSentence(l));
    if (c) assignField(f, "company", c);
  }

  let pending: Field | null = null;
  let inDescription = false;
  let detailChars = 0;
  const addDetail = (raw: string) => {
    // Lines with an email address are dropped: it may be the recipient's own.
    if (detailChars >= input.detailChars || EMAIL_ADDRESS.test(raw)) return;
    const line = tidyText(raw.replace(VISIBLE_URL, " "));
    if (!line) return;
    f.details.push(line);
    detailChars += line.length;
  };
  for (const rawLine of post) {
    if (FOOTER.test(rawLine) || SIGN_OFF.test(rawLine)) break;
    if (CTA_LINE.test(rawLine)) continue;
    // Badges can end in a button word ("Easy Apply"): only other lines lose a glued-on button text.
    const line = BADGE.test(rawLine) ? rawLine : rawLine.replace(CTA_SUFFIX, "") || rawLine;
    if (FOOTER.test(line)) break;
    if (pending) {
      const field: Field = pending;
      pending = null;
      if (assignField(f, field, line)) continue;
    }
    if (CTA_LINE.test(line) || NON_JOB_TEXT.test(line) || GREETING.test(line) || HEADER.test(line) || INTRO.test(line)) continue;
    if (BADGE.test(line)) {
      if (f.badges.length < 6 && !f.badges.includes(line)) f.badges.push(line);
      continue;
    }
    if (AGE.test(line)) {
      f.age ??= line.replace(/[()]/g, "").trim();
      continue;
    }
    if (RATING.test(line)) continue;
    const heading = HEADINGS.find(([re]) => re.test(line.replace(/[:：]\s*$/, "")));
    if (heading) {
      if (heading[1] === "description") inDescription = true;
      else pending = heading[1];
      continue;
    }
    const segments = labelledSegments(line);
    if (segments) {
      for (const seg of segments) {
        if (seg.field === "description") {
          inDescription = true;
          if (seg.value) addDetail(seg.value);
        } else if (seg.field === "detail") {
          if (seg.value) addDetail(`${seg.label}: ${seg.value}`);
        } else if (!seg.value && segments.length === 1) {
          pending = seg.field;
        } else if (seg.value && !assignField(f, seg.field, seg.value)) {
          addDetail(`${seg.label}: ${seg.value}`);
        }
      }
      continue;
    }
    if (!inDescription) {
      if (/\s[·•]\s|\|/.test(line) && readSegmentLine(f, line)) continue;
      if (isSalaryOnly(line) && assignField(f, "salary", line)) continue;
      if (EXP_RANGE.test(line) && line.length <= 30 && assignField(f, "experience", line)) continue;
      if (JOB_TYPE_ONLY.test(line) && assignField(f, "jobType", line)) continue;
      if (!f.skills && isSkillList(line)) {
        f.skills = line;
        continue;
      }
      if (line.length <= 80 && !isSentence(line)) {
        if (companyFirst && !f.locationText && assignField(f, "location", line)) continue;
        if (!f.company && !isPlaceLine(line) && assignField(f, "company", line)) continue;
        if (!f.locationText && (isPlaceLine(line) || CITY_REGION.test(line)) && assignField(f, "location", line)) continue;
      }
    }
    addDetail(line);
  }
  if (!f.company && input.logoAlt && !GENERIC_ALT.test(input.logoAlt.trim())) assignField(f, "company", input.logoAlt);
  return finishFields(f);
}

/** Derive numbers (experience, salary) and employment type from the text fields. */
export function finishFields(f: CardFields): CardFields {
  if (f.experienceText) {
    const e = parseExperience(f.experienceText);
    f.experienceMin = e.min;
    f.experienceMax = e.max;
  }
  if (f.salaryText) f.salary = parseSalary(f.salaryText);
  if (!f.employmentType && f.jobType) f.employmentType = employmentTypeOf(f.jobType);
  return f;
}
