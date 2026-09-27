import { createHash } from "node:crypto";
import type { AnswerSource, ApplicationQuestion, CanonicalQuestionKey, PendingQuestion, ResolvedAnswer, SourceFact } from "@applywise/types";
import { isIndiaLocation } from "../feeds/util";
import { extractLocationsFromText, REMOTE_GLOBAL, REMOTE_INDIA } from "../locations";
import type { ProviderQuestion } from "../providers/types";
import { extractSkillsFromText, isKnownSkill, normalizeSkill } from "../taxonomy";

/**
 * Application question classification and answer resolution.
 *
 * Classification is a deterministic phrase map (English, including India-market wording such as CTC, notice
 * period and "immediate joiner") from a free-form question to a CanonicalQuestionKey and a stable key.
 *
 * Resolution order: verified profile / preferences -> TruthBank (verified skills & facts) -> the user's reusable
 * answers (CandidateAnswer) -> previous answers the user gave (JobAnswer / screening answers). Nothing is ever
 * invented: an unknown required question makes the application NEEDS_INFORMATION. Sensitive questions (salary,
 * notice period, work authorisation, visa, relocation, start date, diversity) resolve only from values the user
 * entered themselves, and missing evidence never becomes "No".
 *
 * Work authorisation and sponsorship answers are specific to a country: the key carries the country the question
 * names, else the job's country (`jobCountry`, see countryForLocations). When neither is known, only answers the
 * user gave for this very application are used - never an answer given for another job, which may have been in
 * another country. Relocation questions that name a place carry it too ("willing_to_relocate:pune"), and the generic
 * "open to relocation" preference answers only questions that name no place.
 */

export const QUESTION_RESOLVER_VERSION = "answers-v2";

export interface AnswerSources {
  profile: {
    fullName: string | null;
    email: string | null;
    phone: string | null;
    currentTitle: string | null;
    currentCompany: string | null;
    yoe: number | null;
    linkedinUrl: string | null;
    githubUrl: string | null;
    portfolioUrl: string | null;
    /** The candidate's own city if they entered one (first preferred non-remote location otherwise null). */
    location: string | null;
    highestEducation: string | null;
  };
  preference: {
    noticePeriod: string | null;
    expectedSalaryMin: number | null;
    expectedSalaryMax: number | null;
    currency: string;
    openToRelocation: boolean | null;
    workModePreference: "remote" | "hybrid" | "onsite" | "any" | null;
  };
  /** Verified skills only (USER_VERIFIED / USER_EDITED). */
  verifiedSkills: { id: string; name: string; canonicalName: string; yearsUsed: number | null }[];
  /** Verified facts (verifiedSourceFacts in packages/database/src/candidate.ts). */
  verifiedFacts: SourceFact[];
  /** Previous questionnaire answers the user gave (JobAnswer), with the question text. Callers pass newest first. */
  previousAnswers: { id: string; question: string; questionKey: string | null; answer: string }[];
  /**
   * The user's reusable answers (CandidateAnswer), plus the answers they gave for this application only
   * (`applicationScoped: true`, or a questionKey still carrying the "app:<applicationId>:" prefix). Only
   * application-scoped answers are used for a work authorisation / sponsorship question whose country is unknown.
   */
  candidateAnswers: { id: string; questionKey: string; question: string; answer: string; applicationScoped?: boolean }[];
}

// ---------------------------------------------------------------- key metadata

/** Keys whose answers are only ever taken from values the user entered themselves (never inferred). */
export const SENSITIVE_QUESTION_KEYS: ReadonlySet<CanonicalQuestionKey> = new Set<CanonicalQuestionKey>([
  "current_salary",
  "expected_salary",
  "notice_period",
  "work_authorization",
  "visa_sponsorship",
  "willing_to_relocate",
  "earliest_start_date",
  "diversity",
]);

/** Plain-language names for canonical keys (UI labels and resolution reasons). */
export const CANONICAL_QUESTION_LABELS: Record<CanonicalQuestionKey, string> = {
  first_name: "First name",
  last_name: "Last name",
  full_name: "Full name",
  email: "Email",
  phone: "Phone",
  current_location: "Current location",
  linkedin_url: "LinkedIn profile",
  github_url: "GitHub profile",
  portfolio_url: "Portfolio / website",
  current_company: "Current company",
  current_title: "Current job title",
  total_experience_years: "Total years of experience",
  skill_experience_years: "Years of experience with a skill",
  skill_experience: "Experience with a skill",
  notice_period: "Notice period",
  current_salary: "Current salary",
  expected_salary: "Expected salary",
  work_authorization: "Work authorisation",
  visa_sponsorship: "Visa sponsorship",
  willing_to_relocate: "Willingness to relocate",
  work_mode_preference: "Work mode preference",
  earliest_start_date: "Earliest start date",
  highest_education: "Highest qualification",
  cover_letter: "Cover letter",
  resume: "Resume / CV",
  how_did_you_hear: "How you heard about the job",
  diversity: "Diversity information",
  custom: "Custom question",
};

// ---------------------------------------------------------------- text helpers

const REQUIRED_WORD_MARKER = /\(\s*(?:required|mandatory)\s*\)/gi;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** True when a job-description question is marked as required: "(required)" / "(mandatory)" or a trailing "*". */
export function isMarkedRequired(question: string): boolean {
  REQUIRED_WORD_MARKER.lastIndex = 0;
  return REQUIRED_WORD_MARKER.test(question) || /\*\s*$/.test(question);
}

/** Display form of a question: "(required)" / "(mandatory)" / trailing "*" removed, whitespace collapsed. */
export function stripRequiredMarker(question: string): string {
  return collapse(question.replace(REQUIRED_WORD_MARKER, " ").replace(/\s*\*+\s*$/, ""));
}

/** Comparison form of a question (lowercase, punctuation-free); equal texts are the same question. */
export function normalizeQuestionText(question: string): string {
  return stripRequiredMarker(question)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9+#]+/g, " ")
    .trim();
}

/**
 * Predicate: does `text` mention the skill? Taxonomy skills are detected with their aliases (ambiguous short
 * aliases such as "go" are never matched in prose); skills outside the taxonomy need a whole-word mention.
 */
export function skillMentionMatcher(text: string): (skill: string) => boolean {
  const lower = (text ?? "").toLowerCase();
  let extracted: Set<string> | null = null;
  return (skill: string) => {
    if (!lower || !skill.trim()) return false;
    const canonical = normalizeSkill(skill);
    if (isKnownSkill(canonical)) {
      extracted ??= new Set(extractSkillsFromText(text).map((s) => s.toLowerCase()));
      return extracted.has(canonical.toLowerCase());
    }
    const body = escapeRegExp(canonical.toLowerCase()).replace(/\s+/g, "[\\s-]+");
    return new RegExp(`(?<![a-z0-9.#+])${body}(?![a-z0-9#+]|\\.[a-z])`, "i").test(lower);
  };
}

// ---------------------------------------------------------------- classification

interface Classification {
  canonicalKey: CanonicalQuestionKey;
  /** Canonical skill for skill questions. */
  skill: string | null;
  /** Key suffix: the country of a work authorisation / sponsorship question ("india"), a diversity category ("gender"). */
  qualifier: string | null;
}

const RESUME_RE =
  /^(?:please )?(?:upload|attach|submit|share|add|provide|include)\b[^?]*\b(?:resume|résumé|cv|curriculum vitae)\b|^(?:your |updated |latest |current )*(?:resume|résumé|cv|curriculum vitae)(?:\s*(?:\/|or)\s*(?:resume|résumé|cv))?(?: (?:file|upload|attachment|document))?\??$/;
const COVER_LETTER_RE = /\bcover(?:ing)?[\s-]*letter\b|\bmotivation(?:al)? letter\b/;
const DIVERSITY_RE =
  /\b(?:gender|sex|ethnicity|ethnic|race(?! condition)|racial|veteran|disability|disabilities|disabled|pronouns?|sexual orientation|lgbtq?|hispanic|latino|latinx|caste|religion|marital status|pwd)\b/;
const HEAR_RE =
  /\bhow did you (?:hear|find out|learn|come to know|come across|find|get to know)\b|\bwhere did you (?:hear|find|see|learn|come across)\b|\b(?:referral )?source\b[^?]*\b(?:application|hear|job|posting|opening)\b/;
/** "Are you serving your notice?" / "Last working day?" ask about a status, not the notice period: they stay custom. */
const NOTICE_STATUS_RE = /\bserving\b[^?]*\bnotice\b|\bon notice\b|\blast working day\b|\blwd\b/;
const NOTICE_RE =
  /\bnotice period\b|\bnotice\b[^?]*\b(?:days|weeks|months)\b|\bhow (?:soon|quickly|early|fast) (?:can|could|would|will) you (?:join|start|come on ?board)\b|\bimmediate(?:ly)? (?:joiner|joining|join|available|availability|start)\b|\b(?:can|could|will|would) you join (?:immediately|within|in)\b|\bjoin(?:ing)? immediately\b|\bearly joiner\b/;
const START_DATE_RE =
  /\bearliest\b[^?]*\b(?:start|join|joining|available|availability|begin)\b|\bwhen (?:can|could|would|will) you (?:start|join|begin)\b|\b(?:start|joining|availability) date\b|\bdate of joining\b|\bdoj\b|\bavailab(?:le|ility) to (?:start|join|begin)\b/;
const AUTHORISED_WITHOUT_SPONSORSHIP_RE =
  /\b(?:authori[sz]ed|eligible|legally (?:able|allowed|permitted|entitled)|permitted|entitled|allowed) to work\b[^?]*\bwithout\b[^?]*\b(?:sponsor|visa|requir|need)/;
const SPONSORSHIP_NEED_RE =
  /\b(?:require|requires|requiring|need|needs|needing|seek|seeking)\b[^?]*\b(?:sponsor(?:ship)?|visa|h-?1b|work permit)\b/;
const WORK_AUTH_RE =
  /\b(?:authori[sz]ed|eligible|legally (?:able|allowed|permitted|entitled)|permitted|entitled|allowed) to work\b|\bwork (?:authori[sz]ation|permit|eligibility|rights?)\b|\bright to work\b|\bvalid (?:work )?(?:visa|permit)\b/;
const SPONSORSHIP_RE = /\bsponsor(?:ship|ed|ing)?\b|\bvisa (?:sponsorship|support|assistance)\b/;
const RELOCATION_RE = /\brelocat(?:e|ed|ing|ion)\b/;
const TOTAL_EXPERIENCE_RE =
  /\btotal (?:years? of )?(?:work |professional |it |industry )?(?:experience|exp)\b|\boverall (?:work |professional )?(?:experience|exp)\b|\byears? of (?:total |overall |professional |work |industry |it )?(?:experience|exp)\b|\bhow many years (?:have you (?:been )?work(?:ed|ing)|of experience)\b|\bwork experience\b[^?]*\byears?\b|^(?:work )?experience(?: \(?in years\)?)?\??$/;
const EDUCATION_RE =
  /\bhighest\b[^?]*\b(?:qualification|degree|education|educational)\b|\b(?:educational|academic) (?:qualifications?|background|level|details)\b|\blevel of education\b|^(?:education|qualifications?|degree)\b|\bwhat (?:is|was) your (?:highest )?(?:degree|qualification)\b/;
const LINK_WORDS_RE = /\b(?:url|profile|link|page|handle|id|username|account)\b/;
const CURRENT_COMPANY_RE =
  /\b(?:current|present|latest|most recent) (?:company|employer|organi[sz]ation|firm|workplace)\b|\b(?:company|employer|organi[sz]ation) name\b|^(?:current )?(?:company|employer)\??$|\bwhere (?:do|are) you (?:currently )?(?:work|working|employed)\b|\bwho is your (?:current )?employer\b/;
const CURRENT_TITLE_RE =
  /\b(?:current|present|latest|most recent) (?:job |role |position )?(?:title|designation|role|position)\b|\bjob title\b|\bdesignation\b|\bwhat is your (?:current )?(?:role|title)\b/;
/** Questions about someone else's details (a referee, a manager, an emergency contact) are never profile fields. */
const THIRD_PARTY_RE =
  /\b(?:emergency|references?|referee|referrer|referred|manager'?s?|supervisor'?s?|hr|recruiter'?s?|guardian|parent'?s?|father'?s?|mother'?s?|spouse'?s?)\b/;
/** "Do you ...?" / "Are you ...?" questions expect a yes/no answer. */
const YES_NO_PHRASING = /^(?:do|does|did|are|is|am|have|has|had|can|could|will|would|were|was)\b/i;
const DESCRIPTIVE_RE = /\b(?:describe|explain|tell us|responsibilit|walk us|summari[sz]e)/;
const CURRENT_LOCATION_RE =
  /\b(?:current|present) (?:location|city|place of residence|residence|address|base)\b|\bwhere (?:are|do) you (?:currently )?(?:based|located|live|living|reside|residing)\b|\b(?:city|location) (?:of residence|you (?:currently )?(?:live|reside|are based))\b|^(?:your )?(?:location|city)\??$|\bwhich city\b[^?]*\b(?:live|based|located|reside)\b/;
const EMAIL_RE = /^(?:your |primary |personal |contact )*e-?mail(?: address| id)?\??$|\b(?:what is|enter|provide) your e-?mail\b|\be-?mail (?:address|id)\b/;
const PHONE_RE =
  /\b(?:phone|mobile|cell|telephone|whatsapp|contact)(?: phone)? (?:number|no\.?|#)(?![a-z])|^(?:your )?(?:phone|mobile|cell ?phone|telephone|mobile phone)\??$|\b(?:what is|enter|provide) your (?:phone|mobile)\b/;
const FIRST_NAME_RE = /\bfirst[\s-]?name\b|\bgiven name\b|\bforename\b/;
const LAST_NAME_RE = /\blast[\s-]?name\b|\bsurname\b|\bfamily name\b/;
const FULL_NAME_RE =
  /^(?:your |full |legal |complete |candidate'?s? |applicant'?s? )*name(?: \(.*\))?\??$|\b(?:full|legal|complete) name\b|\bwhat is your (?:full )?name\b/;

/** Years-of-experience-with-a-skill phrasings; group 1 is the skill phrase. */
const SKILL_YEARS_PATTERNS: RegExp[] = [
  // "How many years of (professional) experience do you have with React?"
  /\byears?\s+of\s+(?:[a-z-]+\s+){0,2}?(?:experience|exp)\s+(?:do\s+you\s+have\s+|have\s+you\s+got\s+|you\s+have\s+)?(?:with|in|using|on|of|working\s+(?:with|in|on))\s+(.+)$/i,
  // "How many years have you worked with Python?"
  /\bhow\s+many\s+years\s+(?:have|did)\s+you\s+(?:been\s+)?(?:worked|working|work|used|using|use|coded|programmed|developed|built)\s+(?:with\s+|in\s+|on\s+|using\s+)?(.+)$/i,
  // "How many years of React experience do you have?"
  /\byears?\s+of\s+(.+?)\s+(?:experience|exp)\b/i,
  // "React experience (in years)" / "Experience with React (years)"
  /^(?:experience\s+(?:with|in|using)\s+)?(.+?)\s+(?:experience\s+)?\((?:in\s+)?(?:years|yrs)\)\s*\??$/i,
];

/** "Do you have experience with X?" phrasings; group 1 is the skill phrase. */
const SKILL_EXPERIENCE_PATTERNS: RegExp[] = [
  /\b(?:do|did)\s+you\s+have\s+(?:any\s+)?(?:[a-z-]+\s+){0,3}?(?:experience|exposure|knowledge|expertise|familiarity|proficiency|background)\s+(?:with|in|using|of|on|working\s+(?:with|in|on))\s+(.+)$/i,
  /\bhave\s+you\s+(?:ever\s+|previously\s+|already\s+)?(?:worked|used|built|developed|programmed|coded|deployed|shipped|implemented|written)\s+(?:with\s+|in\s+|on\s+|using\s+|code\s+in\s+|(?:applications?|apps|services|software)\s+(?:with|in|using)\s+)?(.+)$/i,
  /\bare\s+you\s+(?:familiar|experienced|proficient|comfortable|skilled|well[- ]versed)\s+(?:with|in|using|working\s+(?:with|in|on))\s+(.+)$/i,
  /^(?:(?:hands[- ]on\s+|prior\s+|professional\s+)?experience|exposure|proficiency|knowledge)\s+(?:with|in|of|using)\s+(.+)$/i,
  /\bdo\s+you\s+know\s+(.+)$/i,
];

/** A skill phrase that means "all of your experience" (-> total_experience_years). */
const GENERIC_TOTAL_PHRASE =
  /^(?:(?:in\s+)?total|overall|all|professional|work|working|industry|the industry|it|the it industry|it industry|your career|career|total work|total professional|full[- ]time|paid)$/i;
const TRAILING_QUALIFIER =
  /\s+(?:professionally|commercially|in production|in a production (?:environment|setting)|in (?:a )?professional (?:setting|environment|capacity|role)|in total|so far|till date|to date|in your career|at work|previously|before|in the past|at scale|do you have|have you got|did you have|you have|in your (?:current|previous|last) (?:roles?|jobs?|company|companies)|yet)$/i;
const NON_SKILL_LEAD =
  /^(?:a|an|the|any|some|this|that|these|those|our|your|my|such|similar|other|multiple|large|small|remote|cross|different|various|high|low|fast|working|being|leading|managing|relevant|related|previous|prior|practical|technical|domain)\b/i;
const NON_SKILL_WORD =
  /\b(?:years?|months?|yrs?|clients?|customers?|teams?|companies|company|startups?|stakeholders?|products?|projects?|industry|domain|environment|market|sales|role|roles|people|shifts?|travel|here|us)\b/i;

function cleanSkillPhrase(raw: string): string {
  let phrase = (raw.split(/[?;:()[\]]|\s[-–—]\s|,\s/)[0] ?? "").trim();
  phrase = phrase.replace(/[.!\s]+$/, "");
  let previous = "";
  while (previous !== phrase) {
    previous = phrase;
    phrase = phrase.replace(TRAILING_QUALIFIER, "").replace(/[.!\s]+$/, "");
  }
  return phrase.trim();
}

/**
 * Canonical skill named by a phrase, or null when the phrase is not (exactly one) skill. `sentenceStart`: the phrase
 * opens the question, so its first capital letter says nothing about it being a technology name.
 */
function skillFromPhrase(phrase: string, sentenceStart = false): string | null {
  if (!phrase || phrase.length > 60) return null;
  const words = phrase.split(/\s+/);
  if (words.length > 5) return null;
  if (/\b(?:years?|months?|yrs?)\b/i.test(phrase)) return null;
  if (isKnownSkill(phrase)) return normalizeSkill(phrase);
  const found = extractSkillsFromText(phrase);
  if (found.length === 1) return found[0]!;
  if (found.length > 1) return null;
  // Outside the taxonomy: accept only short, technology-looking names ("Terraform", "PyTorch", "SAP").
  if (words.length > 3 || NON_SKILL_LEAD.test(phrase) || NON_SKILL_WORD.test(phrase)) return null;
  if (!/[A-Z0-9#+.]/.test(sentenceStart ? phrase.slice(1) : phrase)) return null;
  return normalizeSkill(phrase);
}

function opensQuestion(display: string, phrase: string): boolean {
  return display.trimStart().toLowerCase().startsWith(phrase.toLowerCase());
}

function classifySkillQuestion(display: string): Classification | null {
  for (const pattern of SKILL_YEARS_PATTERNS) {
    const m = pattern.exec(display);
    if (!m) continue;
    const phrase = cleanSkillPhrase(m[1] ?? "");
    if (!phrase) continue;
    if (GENERIC_TOTAL_PHRASE.test(phrase)) return { canonicalKey: "total_experience_years", skill: null, qualifier: null };
    const skill = skillFromPhrase(phrase, opensQuestion(display, phrase));
    // Years in a domain that is not a skill ("in sales") must never be answered with total experience.
    return skill ? { canonicalKey: "skill_experience_years", skill, qualifier: null } : { canonicalKey: "custom", skill: null, qualifier: null };
  }
  for (const pattern of SKILL_EXPERIENCE_PATTERNS) {
    const m = pattern.exec(display);
    if (!m) continue;
    const phrase = cleanSkillPhrase(m[1] ?? "");
    const skill = skillFromPhrase(phrase, opensQuestion(display, phrase));
    if (skill) return { canonicalKey: "skill_experience", skill, qualifier: null };
  }
  return null;
}

function classifySalary(t: string): CanonicalQuestionKey | null {
  if (!/\b(?:ctc|salary|salaries|compensation|pay|package|remuneration|lpa|earnings|income|take[- ]home|wages?|cctc|ectc)\b/.test(t)) return null;
  const current = /\b(?:current|currently|present|existing|last[- ]drawn|previous|latest|cctc)\b/.test(t);
  const expected = /\b(?:expected|expecting|expectations?|desired|target|looking for|asking|ectc|anticipated|preferred)\b/.test(t);
  // "Current and expected CTC" needs two values: only a user-written answer fits.
  if (current && expected) return "custom";
  if (expected) return "expected_salary";
  if (current) return "current_salary";
  if (/\bctc\b/.test(t)) return "current_salary";
  return null;
}

function isWorkModePreference(t: string): boolean {
  // "Are you comfortable working from the office?" is a yes/no requirement, not a preference.
  if (/^(?:are|is|do|does|can|could|will|would|have|has|did)\b/.test(t) && !/\bprefer/.test(t)) return false;
  return /\bprefer(?:red|ence|s)?\b[^?]*\b(?:remote|hybrid|on-?site|in[- ]office|office|work(?:ing)? (?:mode|model|arrangement|setup|style))\b|\bwork(?:ing)? (?:mode|model|arrangement|setup|style)\b|\b(?:remote|hybrid|on-?site)\s*(?:\/|,|or)\s*(?:remote|hybrid|on-?site)\b/.test(
    t,
  );
}

const COUNTRY_PATTERNS: [RegExp, string][] = [
  [/\bU\.?S\.?(?:A\.?)?(?![a-zA-Z])/, "us"],
  [/\b(?:united states|america)\b/i, "us"],
  [/\bU\.?K\.?(?![a-zA-Z])/, "uk"],
  [/\b(?:united kingdom|great britain|britain|england|scotland|wales)\b/i, "uk"],
  [/\bE\.?U\.?(?![a-zA-Z])/, "eu"],
  [/\b(?:european union|europe|eea|schengen)\b/i, "eu"],
  [/\bindian?\b/i, "india"],
  [/\bcanad(?:a|ian)\b/i, "canada"],
  [/\b(?:uae|united arab emirates|dubai|abu dhabi)\b/i, "uae"],
  [/\bsingapore\b/i, "singapore"],
  [/\baustralia\b/i, "australia"],
  [/\bnew zealand\b/i, "new zealand"],
  [/\bgermany\b/i, "germany"],
  [/\b(?:netherlands|holland)\b/i, "netherlands"],
  [/\bireland\b/i, "ireland"],
];

/** Well-known cities outside India, with the country qualifier they belong to (COUNTRY_PATTERNS format). */
const CITY_COUNTRIES: [RegExp, string][] = [
  [
    /\b(?:new york|nyc|brooklyn|manhattan|san francisco|bay area|seattle|austin|boston|chicago|los angeles|denver|atlanta|miami|dallas|houston|san jose|san diego|palo alto|mountain view|sunnyvale|menlo park|redmond|cupertino|santa clara|oakland|philadelphia|pittsburgh|washington|raleigh|salt lake city|phoenix|minneapolis|nashville|charlotte)\b/i,
    "us",
  ],
  [/\b(?:london|manchester|edinburgh|glasgow|bristol|leeds|belfast)\b/i, "uk"],
  [/\b(?:berlin|munich|munchen|muenchen|hamburg|frankfurt|cologne|koln|stuttgart|dusseldorf|deutschland)\b/i, "germany"],
  [/\b(?:toronto|vancouver|montreal|ottawa|calgary|edmonton)\b/i, "canada"],
  [/\b(?:sydney|melbourne|brisbane|perth|adelaide|canberra)\b/i, "australia"],
  [/\bsharjah\b/i, "uae"],
  [/\b(?:amsterdam|rotterdam)\b/i, "netherlands"],
  [/\bdublin\b/i, "ireland"],
];
/** "San Francisco, CA" / "Austin, TX" (US state codes) and "London, ON" / "Vancouver, BC" (Canadian provinces). */
const US_STATE_RE = /,\s*(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)\b/;
const CANADA_PROVINCE_RE = /,\s*(?:ON|BC|QC|AB|MB|SK|NS|NB|NL|PE)\b/;
/** Regions spanning several countries: a job there has no single country. */
const MULTI_COUNTRY_RE = /\b(?:latin america|south america|central america|north america|americas|latam|apac|asia[- ]pacific|emea|mena|worldwide|global|anywhere|international)\b/i;

function plain(text: string): string {
  return text.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();
}

/**
 * The one country of a place ("Bengaluru, Karnataka" -> "india", "New York, NY" -> "us", "Remote - India" -> "india"),
 * or null when it names none, several, or a multi-country region. Precedence: a named country, an Indian place, a US
 * state / Canadian province code, a well-known city.
 */
function countryOfPlace(raw: string): string | null {
  const place = plain(raw);
  if (!place || place === REMOTE_GLOBAL || MULTI_COUNTRY_RE.test(place)) return null;
  const single = (found: Set<string>): string | null | undefined => (found.size === 1 ? [...found][0]! : found.size > 1 ? null : undefined);
  const named = new Set<string>();
  for (const [re, country] of COUNTRY_PATTERNS) if (re.test(place)) named.add(country);
  const byName = single(named);
  if (byName !== undefined) return byName;
  if (place === REMOTE_INDIA || isIndiaLocation(place)) return "india";
  if (CANADA_PROVINCE_RE.test(place)) return "canada";
  if (US_STATE_RE.test(place)) return "us";
  const cities = new Set<string>();
  for (const [re, country] of CITY_COUNTRIES) if (re.test(place)) cities.add(country);
  return single(cities) ?? null;
}

/**
 * The job's country as a work-authorisation qualifier ("india", "us", "uk", "singapore", "germany", "canada",
 * "australia", "uae", ...), from its location strings. Null unless every location is in the same, recognised country:
 * a job in several countries, a global / multi-country remote role or an unrecognised place has no single country.
 */
export function countryForLocations(locations: string[]): string | null {
  let country: string | null = null;
  let any = false;
  for (const raw of locations ?? []) {
    if (typeof raw !== "string" || !raw.trim()) continue;
    const c = countryOfPlace(raw);
    if (!c || (country && c !== country)) return null;
    country = c;
    any = true;
  }
  return any ? country : null;
}

/**
 * Country (or other place) named by a work-authorisation / sponsorship question. Authorisation for one country says
 * nothing about another, so it becomes part of the key ("work_authorization:india").
 */
function countryQualifier(display: string): string | null {
  const found = new Set<string>();
  for (const [re, country] of COUNTRY_PATTERNS) if (re.test(display)) found.add(country);
  if (found.size === 0) {
    const m = /\bto work (?:in|within|for) (?:the )?([A-Z][\w.-]*(?: [A-Z][\w.-]*){0,2})/.exec(display);
    // A named city counts as its country: authorisation to work in Pune is authorisation to work in India. Anything
    // not recognised as a place ("the Country where this role is based") names no country: the job's country applies.
    const place = m?.[1] ? countryOfPlace(m[1]) : null;
    if (place) found.add(place);
  }
  return found.size ? [...found].sort().join("+") : null;
}

/** Work authorisation / sponsorship: the answer depends on the country. */
const COUNTRY_BOUND_KEYS: ReadonlySet<CanonicalQuestionKey> = new Set<CanonicalQuestionKey>(["work_authorization", "visa_sponsorship"]);

/**
 * True for a work authorisation / sponsorship key without a country ("work_authorization"): an answer to it holds for
 * one application only, so it must be stored scoped to that application even when the user asks to remember it.
 */
export function requiresApplicationScopedAnswer(key: string): boolean {
  return COUNTRY_BOUND_KEYS.has(key as CanonicalQuestionKey);
}

function normalizeJobCountry(value: string | null | undefined): string | null {
  const v = (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  return /^[a-z][a-z .+-]{0,40}$/.test(v) ? v : null;
}

/** A work authorisation / sponsorship question that names no country is about the job's country. */
function withJobCountry(c: Classification, jobCountry: string | null | undefined): Classification {
  if (c.qualifier || !COUNTRY_BOUND_KEYS.has(c.canonicalKey)) return c;
  const country = normalizeJobCountry(jobCountry);
  return country ? { ...c, qualifier: country } : c;
}

/**
 * The place(s) a relocation question names ("relocate to Pune?" -> "pune", "relocate to the UK?" -> "uk"), or null
 * for a general question ("Are you open to relocation?"). A general "open to relocation" says nothing about one place.
 */
function relocationDestination(display: string): string | null {
  const text = plain(display);
  const found = new Set<string>();
  for (const [re, country] of COUNTRY_PATTERNS) if (re.test(text)) found.add(country);
  for (const city of extractLocationsFromText(text)) if (city !== REMOTE_INDIA && city !== REMOTE_GLOBAL) found.add(city.toLowerCase());
  if (found.size === 0 && isIndiaLocation(text)) found.add("india");
  for (const [re] of CITY_COUNTRIES) {
    const m = re.exec(text);
    if (m) found.add(m[0].toLowerCase());
  }
  if (found.size === 0) {
    const m = /\brelocat\w*\b[^?]*?\b(?:to|in|into|near|within)\s+(?:the\s+)?([A-Z][\w.-]*(?: [A-Z][\w.-]*){0,2})/.exec(text);
    if (m?.[1]) found.add(m[1].toLowerCase());
  }
  return found.size ? [...found].sort().join("+") : null;
}

const DIVERSITY_CATEGORIES: [RegExp, string][] = [
  [/\b(?:gender|sex)\b/, "gender"],
  [/\bpronouns?\b/, "pronouns"],
  [/\b(?:ethnicity|ethnic|race(?! condition)|racial|hispanic|latino|latinx)\b/, "ethnicity"],
  [/\bveteran\b/, "veteran"],
  [/\b(?:disability|disabilities|disabled|pwd)\b/, "disability"],
  [/\b(?:sexual orientation|lgbtq?)\b/, "sexual_orientation"],
  [/\bcaste\b/, "caste"],
  [/\breligion\b/, "religion"],
  [/\bmarital status\b/, "marital_status"],
];

/** Which self-identification question this is: a gender answer must never be reused for a veteran question. */
function diversityQualifier(t: string): string | null {
  const found = DIVERSITY_CATEGORIES.filter(([re]) => re.test(t)).map(([, category]) => category);
  return found.length ? [...new Set(found)].sort().join("+") : null;
}

function classify(display: string): Classification {
  const t = collapse(display.toLowerCase().replace(/[’`]/g, "'"));
  const is = (canonicalKey: CanonicalQuestionKey, skill: string | null = null, qualifier: string | null = null): Classification => ({ canonicalKey, skill, qualifier });
  if (!t) return is("custom");

  if (COVER_LETTER_RE.test(t)) return is("cover_letter");
  if (RESUME_RE.test(t)) return is("resume");
  if (DIVERSITY_RE.test(t)) return is("diversity", null, diversityQualifier(t));
  if (HEAR_RE.test(t)) return is("how_did_you_hear");
  const salary = classifySalary(t);
  if (salary) return is(salary);
  if (NOTICE_STATUS_RE.test(t)) return is("custom");
  if (NOTICE_RE.test(t)) return is("notice_period");
  if (START_DATE_RE.test(t)) return is("earliest_start_date");
  // Polarity matters: "authorised to work without sponsorship?" (yes = fine) vs "require sponsorship?" (yes = needs it).
  if (AUTHORISED_WITHOUT_SPONSORSHIP_RE.test(t)) return is("work_authorization", null, countryQualifier(display));
  if (SPONSORSHIP_NEED_RE.test(t)) return is("visa_sponsorship", null, countryQualifier(display));
  if (WORK_AUTH_RE.test(t)) return is("work_authorization", null, countryQualifier(display));
  if (SPONSORSHIP_RE.test(t)) return is("visa_sponsorship", null, countryQualifier(display));
  // "Relocate to Pune?" and "relocate to London?" are different questions; a general one has no qualifier.
  if (RELOCATION_RE.test(t)) return is("willing_to_relocate", null, relocationDestination(display));
  if (isWorkModePreference(t)) return is("work_mode_preference");

  const skill = classifySkillQuestion(display);
  if (skill) return skill;
  if (TOTAL_EXPERIENCE_RE.test(t)) return is("total_experience_years");
  if (EDUCATION_RE.test(t)) return is("highest_education");

  if (THIRD_PARTY_RE.test(t)) return is("custom");
  const shortField = t.split(" ").length <= 3;
  if (/\blinked\s?in\b/.test(t) && (LINK_WORDS_RE.test(t) || shortField)) return is("linkedin_url");
  if (/\bgit\s?hub\b/.test(t) && (LINK_WORDS_RE.test(t) || shortField)) return is("github_url");
  if (
    (/\bportfolio\b/.test(t) && (LINK_WORDS_RE.test(t) || /\b(?:website|site|behance|dribbble)\b/.test(t) || shortField)) ||
    /\bpersonal (?:web ?)?site\b|\b(?:your|personal|other) (?:website|blog)\b|^(?:website|web site|blog|personal url)\b|\bwebsite url\b/.test(t)
  ) {
    return is("portfolio_url");
  }
  if (CURRENT_COMPANY_RE.test(t)) return is("current_company");
  if (CURRENT_TITLE_RE.test(t) && !DESCRIPTIVE_RE.test(t)) return is("current_title");
  if (CURRENT_LOCATION_RE.test(t)) return is("current_location");
  if (EMAIL_RE.test(t)) return is("email");
  if (PHONE_RE.test(t)) return is("phone");
  if (FIRST_NAME_RE.test(t)) return is("first_name");
  if (LAST_NAME_RE.test(t)) return is("last_name");
  if (FULL_NAME_RE.test(t)) return is("full_name");
  return is("custom");
}

function keyFor(c: Classification, question: string): string {
  if (c.canonicalKey === "custom") {
    return `custom:${createHash("sha256").update(normalizeQuestionText(question)).digest("hex").slice(0, 12)}`;
  }
  if (c.skill) return `${c.canonicalKey}:${c.skill.toLowerCase()}`;
  if (c.qualifier) return `${c.canonicalKey}:${c.qualifier}`;
  return c.canonicalKey;
}

function defaultInputType(canonicalKey: CanonicalQuestionKey, hasOptions: boolean, question: string): ApplicationQuestion["inputType"] {
  if (hasOptions) return "select";
  switch (canonicalKey) {
    case "email":
      return "email";
    case "linkedin_url":
    case "github_url":
    case "portfolio_url":
      return "url";
    case "total_experience_years":
    case "skill_experience_years":
      // "Do you have 5+ years of experience?" is a yes/no question.
      return YES_NO_PHRASING.test(question) ? "text" : "number";
    case "resume":
      return "file";
    case "cover_letter":
      return "textarea";
    default:
      return "text";
  }
}

/** Where a question is asked: the job's country qualifies work authorisation / sponsorship questions naming none. */
export interface QuestionJobContext {
  /** The job's country qualifier (countryForLocations(job.locations)); null/undefined when unknown. */
  jobCountry?: string | null;
}

/**
 * Stable key for a free-form question: the canonical key when recognised (skill questions add the canonical skill,
 * "skill_experience_years:react"; work authorisation / sponsorship questions add the country they name - or the
 * job's country when they name none and `jobCountry` is given - "work_authorization:india"; relocation questions
 * naming a place add it, "willing_to_relocate:pune"; diversity questions add their category, "diversity:gender"),
 * else "custom:<first 12 hex of sha256(normalised text)>".
 */
export function questionKeyFor(question: string, opts?: QuestionJobContext): string {
  return keyFor(withJobCountry(classify(stripRequiredMarker(question)), opts?.jobCountry), question);
}

export function classifyQuestion(
  question: string,
  opts?: { required?: boolean; options?: string[] | null; inputType?: ApplicationQuestion["inputType"]; origin?: ApplicationQuestion["origin"] } & QuestionJobContext,
): ApplicationQuestion {
  const text = collapse(question);
  const c = withJobCountry(classify(stripRequiredMarker(text)), opts?.jobCountry);
  const options = opts?.options?.filter((o) => typeof o === "string" && o.trim() !== "") ?? [];
  return {
    key: keyFor(c, text),
    canonicalKey: c.canonicalKey,
    question: text,
    required: opts?.required ?? false,
    inputType: opts?.inputType ?? defaultInputType(c.canonicalKey, options.length > 0, text),
    options: options.length > 0 ? options : null,
    skill: c.skill,
    sensitive: SENSITIVE_QUESTION_KEYS.has(c.canonicalKey),
    origin: opts?.origin ?? "job_description",
  };
}

function standardQuestion(
  canonicalKey: CanonicalQuestionKey,
  question: string,
  required: boolean,
  inputType: ApplicationQuestion["inputType"],
): ApplicationQuestion {
  return { key: canonicalKey, canonicalKey, question, required, inputType, options: null, skill: null, sensitive: SENSITIVE_QUESTION_KEYS.has(canonicalKey), origin: "standard" };
}

/** Standard application form fields every provider asks for (name, email, phone, resume, ...). */
export function standardApplicationQuestions(): ApplicationQuestion[] {
  return [
    standardQuestion("first_name", "First name", true, "text"),
    standardQuestion("last_name", "Last name", true, "text"),
    standardQuestion("email", "Email", true, "email"),
    standardQuestion("phone", "Phone", false, "text"),
    standardQuestion("resume", "Resume/CV", true, "file"),
    standardQuestion("cover_letter", "Cover letter", false, "textarea"),
    standardQuestion("linkedin_url", "LinkedIn profile", false, "url"),
  ];
}

const ORIGIN_PRIORITY: Record<ApplicationQuestion["origin"], number> = { standard: 0, job_description: 1, provider: 2 };

/**
 * All questions for an application: standard fields + the job description's screening questions + the provider's
 * own form questions, de-duplicated by key (provider wins over the job description, which wins over standard
 * fields; the first question keeps its position). `jobCountry` qualifies work authorisation / sponsorship questions
 * that name no country ("Are you authorised to work in this country?" on a Bengaluru job -> "work_authorization:india").
 */
export function collectApplicationQuestions(
  input: { screeningQuestions: string[]; providerQuestions: ProviderQuestion[]; includeStandard?: boolean } & QuestionJobContext,
): ApplicationQuestion[] {
  const jobCountry = input.jobCountry ?? null;
  const byKey = new Map<string, ApplicationQuestion>();
  const add = (q: ApplicationQuestion) => {
    const existing = byKey.get(q.key);
    if (!existing || ORIGIN_PRIORITY[q.origin] > ORIGIN_PRIORITY[existing.origin]) byKey.set(q.key, q);
    else if (ORIGIN_PRIORITY[q.origin] === ORIGIN_PRIORITY[existing.origin] && q.required && !existing.required) byKey.set(q.key, { ...existing, required: true });
  };
  if (input.includeStandard !== false) for (const q of standardApplicationQuestions()) add(q);
  for (const raw of input.screeningQuestions) {
    const display = stripRequiredMarker(raw ?? "");
    if (!display) continue;
    add(classifyQuestion(display, { required: isMarkedRequired(raw), origin: "job_description", jobCountry }));
  }
  for (const pq of input.providerQuestions) {
    if (!pq.question?.trim()) continue;
    add(classifyQuestion(pq.question, { required: pq.required, inputType: pq.inputType, options: pq.options, origin: "provider", jobCountry }));
  }
  return [...byKey.values()];
}

// ---------------------------------------------------------------- numeric ranges (years, notice days, salary)

type NumericMode = "years" | "days" | "amount";

interface NumRange {
  lo: number;
  hi: number;
  loOpen: boolean;
  hiOpen: boolean;
}

const UNIT_SCALES: Record<NumericMode, [RegExp, number][]> = {
  days: [
    [/^(?:days?|d)$/, 1],
    [/^(?:weeks?|wks?|w)$/, 7],
    [/^(?:months?|mths?|mos?|m)$/, 30],
    [/^(?:years?|yrs?|y)$/, 365],
  ],
  years: [
    [/^(?:years?|yrs?|y)$/, 1],
    [/^(?:months?|mths?|mos?|m)$/, 1 / 12],
    [/^(?:weeks?|wks?|w)$/, 7 / 365],
    [/^(?:days?|d)$/, 1 / 365],
  ],
  amount: [
    [/^(?:lpa|lakhs?|lacs?|l)$/, 1e5],
    [/^k$/, 1e3],
    [/^(?:crores?|cr)$/, 1e7],
    [/^(?:million|mn|m)$/, 1e6],
  ],
};

function unitScale(unit: string | undefined, mode: NumericMode): number | null {
  if (!unit) return null;
  for (const [re, scale] of UNIT_SCALES[mode]) if (re.test(unit)) return scale;
  return null;
}

/**
 * Parses "3-5 years", "5+ years", "Within 30 days", "1 month", "Immediate", "More than 60 days", "20-30 LPA" into a
 * numeric range in the mode's base unit (years, days or currency units). Null when the text is not a range.
 */
function parseRange(text: string, mode: NumericMode, defaultAmountScale = 1): NumRange | null {
  const t = text.toLowerCase().replace(/(\d),(?=\d)/g, "$1");
  const re = /(?<![\d.])(\d+(?:\.\d+)?)(?![\d.])\s*(\+)?\s*(days?|weeks?|wks?|months?|mths?|mos?|years?|yrs?|lpa|lakhs?|lacs?|crores?|cr|million|mn|[dwmylk])?(?![a-z])/g;
  const nums: { value: number; plus: boolean; unit: string | undefined; start: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(t)) !== null) nums.push({ value: Number(m[1]), plus: Boolean(m[2]), unit: m[3], start: m.index, end: m.index + m[0].length });

  if (nums.length === 0) {
    if (mode === "days" && /\b(?:immediate(?:ly)?|no notice|nil|zero|available now)\b/.test(t)) return { lo: 0, hi: 0, loOpen: false, hiOpen: false };
    if (mode === "years" && /\b(?:fresher|no experience|nil|zero)\b/.test(t)) return { lo: 0, hi: 0, loOpen: false, hiOpen: false };
    return null;
  }
  if (nums.length > 2) return null;
  if (nums.length === 2 && !/^\s*(?:-|–|—|to|and|or|\/)\s*$/.test(t.slice(nums[0]!.end, nums[1]!.start))) return null;

  const scaled = nums.map((n, i) => {
    // "3-5 years": a number without a unit takes the unit of the next number.
    const unit = n.unit ?? nums.slice(i + 1).find((x) => x.unit)?.unit;
    const scale = unitScale(unit, mode) ?? (mode === "amount" ? (n.value >= 1e4 ? 1 : defaultAmountScale) : 1);
    return n.value * scale;
  });

  if (scaled.length === 2) {
    const [a, b] = scaled as [number, number];
    return { lo: Math.min(a, b), hi: Math.max(a, b), loOpen: false, hiOpen: false };
  }
  const n = scaled[0]!;
  if (/\b(?:no|not) more than\b/.test(t)) return { lo: 0, hi: n, loOpen: false, hiOpen: false };
  if (/\bnot less than\b/.test(t)) return { lo: n, hi: Infinity, loOpen: false, hiOpen: true };
  if (/\b(?:more than|over|above|greater than|exceeding|beyond)\b/.test(t)) return { lo: n, hi: Infinity, loOpen: true, hiOpen: true };
  if (nums[0]!.plus || /\b(?:or more|and above|or above|and more|plus|at ?least|minimum|min)\b/.test(t)) return { lo: n, hi: Infinity, loOpen: false, hiOpen: true };
  if (/\b(?:less than|under|below|fewer than)\b/.test(t)) return { lo: 0, hi: n, loOpen: false, hiOpen: true };
  if (/\b(?:up ?to|within|at most|maximum|max|or less|or fewer|and below|or below)\b/.test(t)) return { lo: 0, hi: n, loOpen: false, hiOpen: false };
  return { lo: n, hi: n, loOpen: false, hiOpen: false };
}

function rangeContains(outer: NumRange, inner: NumRange): boolean {
  const loOk = outer.loOpen ? inner.lo > outer.lo : inner.lo >= outer.lo;
  const hiOk = outer.hiOpen ? inner.hi < outer.hi : inner.hi <= outer.hi;
  return loOk && hiOk;
}

function rangesDisjoint(a: NumRange, b: NumRange): boolean {
  return b.lo > a.hi || (a.hiOpen && b.lo >= a.hi) || b.hi < a.lo || (a.loOpen && b.hi <= a.lo);
}

function numericModeFor(canonicalKey: CanonicalQuestionKey): NumericMode | null {
  if (canonicalKey === "total_experience_years" || canonicalKey === "skill_experience_years") return "years";
  if (canonicalKey === "notice_period") return "days";
  if (canonicalKey === "expected_salary" || canonicalKey === "current_salary") return "amount";
  return null;
}

function amountScaleFor(question: string): number {
  return /\b(?:lpa|lakhs?|lacs?)\b/i.test(question) ? 1e5 : 1;
}

/** Picks the option whose range holds the value: narrowest first, then [lo, hi) semantics, then option order. */
function pickRangeOption(question: ApplicationQuestion, value: string, options: string[], mode: NumericMode): string | null {
  const scale = amountScaleFor(question.question);
  const v = parseRange(value, mode, scale);
  if (!v) return null;
  const parsed = options.map((option, index) => ({ option, index, range: parseRange(option, mode, scale) }));
  let hits = parsed.filter((p) => p.range && rangeContains(p.range, v));
  if (hits.length === 0 && mode === "years") {
    // Integer buckets ("0-2", "3-5", "6+"): 2.5 years belongs to "0-2".
    hits = parsed.filter((p) => {
      const r = p.range;
      return r && !r.hiOpen && Number.isFinite(r.hi) && Number.isInteger(r.hi) && (r.loOpen ? v.lo > r.lo : v.lo >= r.lo) && v.hi < r.hi + 1;
    });
  }
  if (hits.length === 0) return null;
  const width = (r: NumRange) => r.hi - r.lo;
  const strictlyInside = (r: NumRange) => v.lo > r.lo && v.hi < r.hi;
  const halfOpen = (r: NumRange) => v.lo >= r.lo && v.hi < r.hi;
  hits.sort(
    (a, b) =>
      width(a.range!) - width(b.range!) ||
      Number(strictlyInside(b.range!)) - Number(strictlyInside(a.range!)) ||
      Number(halfOpen(b.range!)) - Number(halfOpen(a.range!)) ||
      a.index - b.index,
  );
  return hits[0]!.option;
}

// ---------------------------------------------------------------- option mapping

type YesNo = "yes" | "no";

function yesNoOf(text: string): YesNo | null {
  const t = text.trim().toLowerCase();
  if (/^(?:yes|y|true)\b/.test(t)) return "yes";
  if (/^(?:no|n|false)\b/.test(t)) return "no";
  return null;
}

/** Yes/No derived from a numeric answer and a threshold in the question ("5+ years of ...?", "join within 30 days?"). */
function thresholdYesNo(question: ApplicationQuestion, value: string): YesNo | null {
  const mode = numericModeFor(question.canonicalKey);
  if (!mode) return null;
  const scale = amountScaleFor(question.question);
  const threshold = parseRange(question.question, mode, scale);
  const v = parseRange(value, mode, scale);
  if (!threshold || !v) return null;
  if (rangeContains(threshold, v)) return "yes";
  if (rangesDisjoint(threshold, v)) return "no";
  return null;
}

const WORK_MODE_PATTERNS: [string, RegExp][] = [
  ["remote", /\b(?:remote|remotely|work from home|wfh|fully remote|anywhere)\b/i],
  ["hybrid", /\bhybrid\b/i],
  ["onsite", /\b(?:on-?site|on site|in[- ]office|office|work from office|wfo|in[- ]person)\b/i],
];

function workModeOf(text: string): string | null {
  const modes = WORK_MODE_PATTERNS.filter(([, re]) => re.test(text)).map(([mode]) => mode);
  return modes.length === 1 ? modes[0]! : null;
}

function degreePattern(alternatives: string[]): RegExp {
  return new RegExp(`(?<![a-z])(?:${alternatives.join("|")})(?![a-z])`);
}

/** 5 doctorate, 4 master's, 3 bachelor's, 2 diploma, 1 school; 0 when no level is named. */
const DEGREE_LEVELS: [number, RegExp][] = [
  [5, degreePattern(["ph\\.?\\s?d\\.?", "doctorate", "doctoral", "d\\.?\\s?phil"])],
  [
    4,
    degreePattern([
      "master'?s?",
      "m\\.?\\s?tech",
      "m\\.\\s?e\\.?",
      "me(?= in )",
      "m\\.?\\s?sc",
      "m\\.\\s?s\\.?",
      "ms(?= in | degree)",
      "mba",
      "pgdm",
      "mca",
      "m\\.\\s?a\\.?",
      "m\\.?\\s?com",
      "post[- ]?graduat(?:e|ion)",
      "pg diploma",
    ]),
  ],
  [
    3,
    degreePattern([
      "bachelor'?s?",
      "b\\.?\\s?tech",
      "b\\.\\s?e\\.?",
      "be(?= in | degree)",
      "b\\.?\\s?sc",
      "b\\.\\s?s\\.?",
      "bs(?= in | degree)",
      "bca",
      "bba",
      "b\\.\\s?a\\.?",
      "ba(?= in | degree)",
      "b\\.?\\s?com",
      "under[- ]?graduat(?:e|ion)",
      "graduat(?:e|ion)",
    ]),
  ],
  [2, degreePattern(["diploma", "associate'?s? degree"])],
  [1, degreePattern(["12th", "xii", "hsc", "higher secondary", "high school", "10\\+2"])],
];

function degreeLevel(text: string): number {
  const t = text.toLowerCase();
  for (const [level, re] of DEGREE_LEVELS) if (re.test(t)) return level;
  return 0;
}

function alnum(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9+#]/g, "");
}

interface AnswerCandidate {
  answer: string;
  source: AnswerSource;
  sourceRef: string | null;
  /** Where the value came from, in plain language ("your profile (email)"). */
  from: string;
  /** Which "Yes" a questionnaire answer meant (to pick between "Yes, professionally" / "Yes, in projects"). */
  variant?: "professional" | "project";
}

function pickYesOption(yesOptions: string[], variant: AnswerCandidate["variant"]): string | null {
  if (yesOptions.length === 1) return yesOptions[0]!;
  if (yesOptions.length > 1 && variant) {
    const re = variant === "professional" ? /\b(?:profession\w*|work|job|employ\w*|commercial\w*)\b/i : /\b(?:projects?|personal|side|academic|hobby)\b/i;
    const narrowed = yesOptions.filter((o) => re.test(o));
    if (narrowed.length === 1) return narrowed[0]!;
  }
  return null;
}

/** Maps a value onto one of the question's options, or null when it does not fit exactly one option. */
function mapToOption(question: ApplicationQuestion, candidate: AnswerCandidate, options: string[]): string | null {
  const value = candidate.answer.trim();
  const lower = value.toLowerCase();
  const exact = options.find((o) => o.trim().toLowerCase() === lower) ?? options.find((o) => alnum(o) !== "" && alnum(o) === alnum(value));
  if (exact) return exact;

  const yesOptions = options.filter((o) => yesNoOf(o) === "yes");
  const noOptions = options.filter((o) => yesNoOf(o) === "no");
  if (yesOptions.length > 0 || noOptions.length > 0) {
    const yn = yesNoOf(value) ?? thresholdYesNo(question, value);
    if (yn === "yes") return pickYesOption(yesOptions, candidate.variant);
    if (yn === "no") return noOptions.length === 1 ? noOptions[0]! : null;
  }

  const mode = numericModeFor(question.canonicalKey);
  if (mode) {
    const hit = pickRangeOption(question, value, options, mode);
    if (hit) return hit;
  }
  if (question.canonicalKey === "work_mode_preference") {
    const wanted = workModeOf(value);
    const hits = wanted ? options.filter((o) => workModeOf(o) === wanted) : [];
    if (hits.length === 1) return hits[0]!;
  }
  if (question.canonicalKey === "highest_education") {
    const level = degreeLevel(value);
    const hits = level > 0 ? options.filter((o) => degreeLevel(o) === level) : [];
    if (hits.length === 1) return hits[0]!;
  }
  return null;
}

function formatNumber(value: number): string {
  // Floor to one decimal: experience is never rounded up.
  const v = Math.floor(value * 10 + 1e-9) / 10;
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

/** Fits a candidate value to the question's input (options, yes/no, number); null when it does not fit. */
function fitAnswer(question: ApplicationQuestion, candidate: AnswerCandidate): string | null {
  const value = candidate.answer.trim();
  if (!value) return null;
  const options = (question.options ?? []).filter((o) => o.trim() !== "");
  if (options.length > 0) return mapToOption(question, candidate, options);
  if (question.inputType === "boolean" || YES_NO_PHRASING.test(question.question)) {
    // "Can you join within 30 days?" + notice "15 days" -> "Yes"; "Are you an immediate joiner?" + "30 days" -> "No".
    const yn = yesNoOf(value) ?? thresholdYesNo(question, value);
    if (yn) return yn === "yes" ? "Yes" : "No";
    if (question.inputType === "boolean") return null;
  }
  if (question.inputType === "number") {
    if (/^\d+(?:\.\d+)?$/.test(value)) return value;
    const mode = numericModeFor(question.canonicalKey);
    const r = mode ? parseRange(value, mode, amountScaleFor(question.question)) : null;
    return r && r.lo === r.hi ? formatNumber(r.lo) : null;
  }
  return value;
}

// ---------------------------------------------------------------- answer sources

function truncate(text: string, max = 80): string {
  const t = collapse(text);
  return t.length > max ? `${t.slice(0, max - 3)}...` : t;
}

function skillOf(question: ApplicationQuestion): string | null {
  if (question.skill) return question.skill;
  const i = question.key.indexOf(":");
  return i > 0 ? question.key.slice(i + 1) : null;
}

function sameSkill(a: string, b: string): boolean {
  return normalizeSkill(a).toLowerCase() === normalizeSkill(b).toLowerCase();
}

function verifiedSkillsFor(sources: AnswerSources, skill: string): AnswerSources["verifiedSkills"] {
  return sources.verifiedSkills.filter((s) => sameSkill(s.canonicalName, skill) || sameSkill(s.name, skill));
}

function nameParts(fullName: string | null): { first: string; last: string | null } | null {
  const tokens = (fullName ?? "").trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  return { first: tokens[0]!, last: tokens.length > 1 ? tokens.slice(1).join(" ") : null };
}

function latestYear(text: string): number {
  const years = [...text.matchAll(/\b(19[5-9]\d|20\d\d)\b/g)].map((m) => Number(m[1]));
  return years.length ? Math.max(...years) : -1;
}

/** The verified EDUCATION fact naming the highest degree; ties -> the most recent year, then input order. */
function educationFact(facts: SourceFact[]): SourceFact | null {
  const ranked = facts
    .map((fact, index) => ({ fact, index }))
    .filter(({ fact }) => fact.kind === "EDUCATION" && fact.text.trim() !== "")
    .map((x) => ({ ...x, level: degreeLevel(x.fact.text), year: latestYear(x.fact.text) }))
    .sort((a, b) => b.level - a.level || b.year - a.year || a.index - b.index);
  return ranked[0]?.fact ?? null;
}

function groupThousands(value: number): string {
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** "INR 2,800,000 - 3,800,000 per year" (or "28 - 38 LPA" when an INR question asks in LPA); null when not set. */
function formatExpectedSalary(preference: AnswerSources["preference"], question: string): string | null {
  const values = [preference.expectedSalaryMin, preference.expectedSalaryMax]
    .filter((n): n is number => typeof n === "number" && Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
  if (values.length === 0) return null;
  const lo = values[0]!;
  const hi = values[values.length - 1]!;
  const currency = (preference.currency ?? "").trim().toUpperCase() || "INR";
  if (currency === "INR" && amountScaleFor(question) === 1e5) {
    return lo === hi ? `${formatNumber(lo / 1e5)} LPA` : `${formatNumber(lo / 1e5)} - ${formatNumber(hi / 1e5)} LPA`;
  }
  return lo === hi ? `${currency} ${groupThousands(lo)} per year` : `${currency} ${groupThousands(lo)} - ${groupThousands(hi)} per year`;
}

function profileCandidate(value: string | null | undefined, field: keyof AnswerSources["profile"], label: string): AnswerCandidate[] {
  const v = value?.trim();
  return v ? [{ answer: v, source: "PROFILE", sourceRef: field, from: `your profile (${label})` }] : [];
}

function preferenceCandidate(value: string | null | undefined, field: string, label: string): AnswerCandidate[] {
  const v = value?.trim();
  return v ? [{ answer: v, source: "PREFERENCE", sourceRef: field, from: `your preferences (${label})` }] : [];
}

/** Verified profile / preference / TruthBank values for the question (never guessed). */
function primaryCandidates(question: ApplicationQuestion, sources: AnswerSources): AnswerCandidate[] {
  const { profile, preference } = sources;
  switch (question.canonicalKey) {
    case "first_name": {
      const parts = nameParts(profile.fullName);
      return parts ? profileCandidate(parts.first, "fullName", "first name") : [];
    }
    case "last_name": {
      const parts = nameParts(profile.fullName);
      return parts?.last ? profileCandidate(parts.last, "fullName", "last name") : [];
    }
    case "full_name":
      return profileCandidate(profile.fullName ? collapse(profile.fullName) : null, "fullName", "name");
    case "email":
      return profileCandidate(profile.email, "email", "email");
    case "phone":
      return profileCandidate(profile.phone, "phone", "phone");
    case "current_location":
      return profileCandidate(profile.location, "location", "location");
    case "linkedin_url":
      return profileCandidate(profile.linkedinUrl, "linkedinUrl", "LinkedIn URL");
    case "github_url":
      return profileCandidate(profile.githubUrl, "githubUrl", "GitHub URL");
    case "portfolio_url":
      return profileCandidate(profile.portfolioUrl, "portfolioUrl", "portfolio URL");
    case "current_company":
      return profileCandidate(profile.currentCompany, "currentCompany", "current company");
    case "current_title":
      return profileCandidate(profile.currentTitle, "currentTitle", "current title");
    case "total_experience_years":
      return typeof profile.yoe === "number" && Number.isFinite(profile.yoe) && profile.yoe >= 0
        ? profileCandidate(formatNumber(profile.yoe), "yoe", "years of experience")
        : [];
    case "skill_experience_years": {
      const skill = skillOf(question);
      if (!skill) return [];
      const withYears = verifiedSkillsFor(sources, skill).find((s) => typeof s.yearsUsed === "number" && Number.isFinite(s.yearsUsed) && s.yearsUsed >= 0);
      return withYears
        ? [{ answer: formatNumber(withYears.yearsUsed!), source: "TRUTH_BANK", sourceRef: withYears.id, from: `your verified skill "${withYears.name}" (years recorded)` }]
        : [];
    }
    case "skill_experience": {
      const skill = skillOf(question);
      if (!skill) return [];
      const verified = verifiedSkillsFor(sources, skill)[0];
      if (verified) return [{ answer: "Yes", source: "TRUTH_BANK", sourceRef: verified.id, from: `your verified skill "${verified.name}"` }];
      const fact = sources.verifiedFacts.find((f) => skillMentionMatcher(f.text)(skill));
      return fact ? [{ answer: "Yes", source: "TRUTH_BANK", sourceRef: fact.id, from: `a verified ${fact.kind.toLowerCase().replace(/_/g, " ")} fact that mentions ${normalizeSkill(skill)}` }] : [];
    }
    case "notice_period":
      return preferenceCandidate(preference.noticePeriod, "noticePeriod", "notice period");
    case "expected_salary":
      return preferenceCandidate(formatExpectedSalary(preference, question.question), "expectedSalary", "expected salary");
    case "willing_to_relocate":
      // Only an explicit "open to relocation" (false may just be the default), and only for a question that names no
      // place: being open to relocation in general is not a "Yes" to moving to one particular city or country.
      if (relocationDestination(stripRequiredMarker(question.question))) return [];
      return preference.openToRelocation === true ? preferenceCandidate("Yes", "openToRelocation", "open to relocation") : [];
    case "work_mode_preference": {
      const mode = preference.workModePreference;
      if (mode !== "remote" && mode !== "hybrid" && mode !== "onsite") return [];
      return preferenceCandidate(mode === "onsite" ? "Onsite" : mode === "remote" ? "Remote" : "Hybrid", "workModePreference", "work mode");
    }
    case "highest_education": {
      const fact = educationFact(sources.verifiedFacts);
      return [
        ...(fact ? [{ answer: fact.text.trim(), source: "TRUTH_BANK" as const, sourceRef: fact.id, from: "your verified education" }] : []),
        ...profileCandidate(profile.highestEducation, "highestEducation", "highest education"),
      ];
    }
    default:
      return [];
  }
}

/** Questionnaire answer codes -> answers ("yes_professional" -> "Yes"); null for "not sure" / empty. */
function userValue(raw: string, question: ApplicationQuestion): Pick<AnswerCandidate, "answer" | "variant"> | null {
  const value = raw.trim();
  if (!value) return null;
  const code = value.toLowerCase();
  if (code === "not_sure" || code === "unsure") return null;
  if (code === "yes_professional") return { answer: "Yes", variant: "professional" };
  if (code === "yes_project") return { answer: "Yes", variant: "project" };
  if (code === "yes" || code === "yes_relocate") return { answer: "Yes" };
  if (code === "no") return { answer: "No" };
  if (question.canonicalKey === "notice_period") {
    if (code === "immediate") return { answer: "Immediate" };
    if (/^\d+$/.test(code)) return { answer: `${code} days` };
  }
  return { answer: value };
}

/** The key a CandidateAnswer was saved under (without an "app:<applicationId>:" prefix) and whether it is scoped. */
function storedAnswerKey(a: AnswerSources["candidateAnswers"][number]): { key: string; scoped: boolean } {
  const m = /^app:[^:]+:(.+)$/.exec(a.questionKey);
  return m ? { key: m[1]!, scoped: true } : { key: a.questionKey, scoped: a.applicationScoped === true };
}

/** The user's own answers: reusable CandidateAnswers first, then previous answers (by key or identical question). */
function userAnswerCandidates(question: ApplicationQuestion, sources: AnswerSources): AnswerCandidate[] {
  const out: AnswerCandidate[] = [];
  const normalized = normalizeQuestionText(question.question);
  const countryBound = COUNTRY_BOUND_KEYS.has(question.canonicalKey);
  // Work authorisation / sponsorship with no known country: an answer given for another job may be for another
  // country, so only this application's own answers count (the question otherwise stays unknown).
  const thisApplicationOnly = countryBound && requiresApplicationScopedAnswer(question.key);
  // Facts about the user's skills are job-independent, so an earlier answer to a differently worded skill question
  // counts; a work-authorisation question matches another one only when both name (or are keyed to) the same country.
  const matchByClassification = question.canonicalKey === "skill_experience" || question.canonicalKey === "skill_experience_years" || countryBound;
  for (const a of sources.candidateAnswers) {
    const { key, scoped } = storedAnswerKey(a);
    if (thisApplicationOnly && !scoped) continue;
    // When the saved question itself names a place / country / skill / category for this kind of question ("relocate
    // to Pune?"), that decides what it answers - even if it was saved under the bare key before keys were qualified.
    const textKey = questionKeyFor(a.question);
    const textIsSpecific = textKey !== key && !textKey.startsWith("custom:") && textKey.includes(":") && textKey.split(":")[0] === key.split(":")[0];
    // This application's own answer to the very same question is about this job's country, however it was keyed.
    const sameApplicationQuestion = scoped && countryBound && key.split(":")[0] === question.canonicalKey && normalized !== "" && normalizeQuestionText(a.question) === normalized;
    if (!sameApplicationQuestion && (textIsSpecific ? textKey !== question.key : key !== question.key && textKey !== question.key)) continue;
    const v = userValue(a.answer, question);
    if (v) out.push({ ...v, source: "CANDIDATE_ANSWER", sourceRef: a.id, from: `your saved answer to "${truncate(a.question)}"` });
  }
  for (const a of sources.previousAnswers) {
    // Previous answers belong to other jobs.
    if (thisApplicationOnly) break;
    const byKey = a.questionKey === question.key;
    // The same wording ("... in this country?") asked for another job may be about another country.
    const byText = !countryBound && normalized !== "" && normalizeQuestionText(a.question) === normalized;
    const byClass = matchByClassification && questionKeyFor(a.question) === question.key;
    if (!byKey && !byText && !byClass) continue;
    const v = userValue(a.answer, question);
    if (v) out.push({ ...v, source: "PREVIOUS_ANSWER", sourceRef: a.id, from: `your earlier answer to "${truncate(a.question)}"` });
  }
  return out;
}

function unknownReason(question: ApplicationQuestion, sources: AnswerSources): string {
  const label = CANONICAL_QUESTION_LABELS[question.canonicalKey];
  const skill = skillOf(question);
  const skillName = skill ? normalizeSkill(skill) : "this skill";
  switch (question.canonicalKey) {
    case "first_name":
    case "full_name":
      return "Your profile has no name and there is no saved answer.";
    case "last_name":
      return sources.profile.fullName?.trim()
        ? "Your profile name has no separate last name and there is no saved answer."
        : "Your profile has no name and there is no saved answer.";
    case "email":
    case "phone":
    case "current_location":
    case "linkedin_url":
    case "github_url":
    case "portfolio_url":
    case "current_company":
    case "current_title":
    case "total_experience_years":
      return `Your profile has no ${label.toLowerCase()} and there is no saved answer.`;
    case "skill_experience_years":
      return verifiedSkillsFor(sources, skillName).length > 0
        ? `${skillName} is verified but no years of experience are recorded; years are never estimated.`
        : `No verified years of experience with ${skillName}; years are never estimated.`;
    case "skill_experience":
      return `No verified skill or fact shows experience with ${skillName}. "No" is never assumed from missing evidence - answer it once and it is reused.`;
    case "notice_period":
      return "No notice period in your preferences and no saved answer.";
    case "expected_salary":
      return "No expected salary in your preferences and no saved answer.";
    case "current_salary":
      return "Current salary is only taken from an answer you gave yourself (never from your expected salary); none found.";
    case "willing_to_relocate":
      return relocationDestination(stripRequiredMarker(question.question))
        ? "This question names a specific place: your general relocation preference is not used for it, and there is no saved answer for that place."
        : "Your preferences do not say you are open to relocation (an unset or default value is not used) and there is no saved answer.";
    case "work_mode_preference":
      return 'Your work mode preference is "any" or not set and there is no saved answer.';
    case "highest_education":
      return "No verified education fact and no saved answer.";
    case "work_authorization":
    case "visa_sponsorship":
      return requiresApplicationScopedAnswer(question.key)
        ? `${label} depends on the job's country, which is not known here, so answers you gave for other jobs are not reused; answer it for this application.`
        : `${label} is only taken from an answer you gave yourself for this country; none found.`;
    case "earliest_start_date":
    case "diversity":
      return `${label} is only taken from an answer you gave yourself; none found.`;
    default:
      return "No saved answer to this question.";
  }
}

export function resolveAnswer(question: ApplicationQuestion, sources: AnswerSources): ResolvedAnswer {
  const base = { key: question.key, question: question.question, required: question.required };
  if (question.canonicalKey === "resume" || question.canonicalKey === "cover_letter") {
    return {
      ...base,
      status: "NOT_APPLICABLE",
      answer: null,
      source: "UNKNOWN",
      sourceRef: null,
      reason: question.canonicalKey === "resume" ? "The selected resume is attached as a document." : "The cover letter is prepared and attached separately.",
    };
  }
  const hasOptions = (question.options ?? []).some((o) => o.trim() !== "");
  let unmatched: AnswerCandidate | null = null;
  for (const candidate of [...primaryCandidates(question, sources), ...userAnswerCandidates(question, sources)]) {
    const answer = fitAnswer(question, candidate);
    if (answer === null) {
      unmatched ??= candidate;
      continue;
    }
    const mapped = answer === candidate.answer.trim() ? "" : hasOptions ? ` Mapped to the option "${answer}".` : ` Answered "${answer}" from that value.`;
    return { ...base, status: "RESOLVED", answer, source: candidate.source, sourceRef: candidate.sourceRef, reason: `Taken from ${candidate.from}.${mapped}` };
  }
  const reason = unmatched
    ? `Found ${unmatched.from}, but the answer ${hasOptions ? "does not match the available options" : "does not fit this question's answer format"}.`
    : unknownReason(question, sources);
  return { ...base, status: "UNKNOWN", answer: null, source: "UNKNOWN", sourceRef: null, reason };
}

export function resolveApplicationAnswers(questions: ApplicationQuestion[], sources: AnswerSources): { answers: ResolvedAnswer[]; pending: PendingQuestion[] } {
  const answers = questions.map((q) => resolveAnswer(q, sources));
  const pending: PendingQuestion[] = [];
  questions.forEach((q, i) => {
    if (q.required && answers[i]!.status === "UNKNOWN") {
      pending.push({ key: q.key, canonicalKey: q.canonicalKey, question: q.question, required: q.required, options: q.options, sensitive: q.sensitive });
    }
  });
  return { answers, pending };
}
