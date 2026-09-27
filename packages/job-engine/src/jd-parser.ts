import type {
  ApplyMethod,
  EmploymentType,
  JobImportMethod,
  JobOtherRequirement,
  JobPlatform,
  JobSkill,
  JobWorkMode,
  NormalizedJob,
  SeniorityLevel,
} from "@applywise/types";
import { detectDomains, extractSkillsFromText, normalizeSkill } from "./taxonomy";
import { extractLocationsFromText, isRemoteLocation, normalizeLocation } from "./locations";
import { applicationContactEmail } from "./automation/application-email";
import { countryForLocations } from "./automation/questions";

/**
 * Deterministic job-description parser. It never invents data: every field is
 * either explicitly provided in `hints`, extracted from the text, or null/empty.
 */

export interface JobParseHints {
  title?: string | null;
  company?: string | null;
  companyWebsite?: string | null;
  location?: string[] | string | null;
  workMode?: JobWorkMode | null;
  employmentType?: EmploymentType | null;
  requiredSkills?: string[] | null;
  preferredSkills?: string[] | null;
  experienceMinYears?: number | null;
  experienceMaxYears?: number | null;
  salaryMin?: number | null;
  salaryMax?: number | null;
  currency?: string | null;
  postedAt?: string | null;
  expiresAt?: string | null;
  applyUrl?: string | null;
  hrEmail?: string | null;
  applicationInstructions?: string | null;
  sourceUrl?: string | null;
  sourceExternalId?: string | null;
  platform?: JobPlatform | null;
  importMethod: JobImportMethod;
  isDemo?: boolean;
}

type Section = "intro" | "responsibilities" | "required" | "preferred" | "screening" | "apply" | "other";

const SECTION_PATTERNS: [Section, RegExp][] = [
  ["preferred", /^(nice[- ]to[- ]have|good[- ]to[- ]have|preferred|bonus|plus|desirable|preferred qualifications|brownie points)/i],
  ["required", /^(requirements?|required|must[- ]haves?|what you('|’)ll need|what we('|’)re looking for|qualifications|skills required|you have|who you are|mandatory)/i],
  ["responsibilities", /^(responsibilities|what you('|’)ll do|role|the role|your role|key responsibilities|job description|about the role)/i],
  ["screening", /^(screening questions?|application questions?|questions)/i],
  ["apply", /^(how to apply|application process|to apply|apply)/i],
  ["other", /^(about us|about the company|benefits|perks|why join|what we offer|compensation)/i],
];

function detectHeading(line: string): Section | null {
  // Bullet points are content, never headings.
  if (/^\s*(?:[-•●▪◦]|\d+[.)])\s+/.test(line)) return null;
  const cleaned = line.replace(/^[#*\s]+/, "").replace(/[*:\s]+$/, "").trim();
  if (cleaned.length === 0 || cleaned.length > 50) return null;
  for (const [section, re] of SECTION_PATTERNS) {
    const m = cleaned.match(re);
    // Allow a few trailing words ("Requirements for this role"), not full sentences.
    if (m && cleaned.slice(m[0].length).trim().split(/\s+/).filter(Boolean).length <= 3) return section;
  }
  return null;
}

function stripBullet(line: string): string {
  return line.replace(/^\s*(?:[-*•●▪◦]|\d+[.)])\s+/, "").trim();
}

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const URL_RE = /https?:\/\/[^\s<>()"']+/gi;

export function extractEmails(text: string): string[] {
  return [...new Set((text.match(EMAIL_RE) ?? []).map((e) => e.toLowerCase().replace(/[.,;]+$/, "")))];
}

export function extractUrls(text: string): string[] {
  return [...new Set((text.match(URL_RE) ?? []).map((u) => u.replace(/[.,;)]+$/, "")))];
}

export function extractExperienceRange(text: string): { min: number | null; max: number | null } {
  const t = text.toLowerCase();
  const range = t.match(/(\d{1,2}(?:\.\d)?)\s*(?:-|–|—|to)\s*(\d{1,2}(?:\.\d)?)\s*\+?\s*(?:years|yrs|year)/);
  if (range) {
    const a = Number(range[1]);
    const b = Number(range[2]);
    return { min: Math.min(a, b), max: Math.max(a, b) };
  }
  const plus = t.match(/(\d{1,2}(?:\.\d)?)\s*\+\s*(?:years|yrs)/) ?? t.match(/(?:minimum|min\.?|at least)\s*(?:of\s*)?(\d{1,2})\s*(?:years|yrs)/);
  if (plus) return { min: Number(plus[1]), max: null };
  const plain = t.match(/(\d{1,2})\s*(?:years|yrs)(?:\s+of)?\s+(?:professional\s+|relevant\s+|hands-on\s+)?experience/);
  if (plain) return { min: Number(plain[1]), max: null };
  return { min: null, max: null };
}

/** Salary is only extracted when explicitly present (LPA / lakhs / ₹ ranges). */
export function extractSalary(text: string): { min: number | null; max: number | null; currency: string | null } {
  const t = text.toLowerCase().replace(/,/g, "");
  const lpa = t.match(/(?:₹|inr|rs\.?)?\s*(\d{1,3}(?:\.\d{1,2})?)\s*(?:-|–|to)\s*(\d{1,3}(?:\.\d{1,2})?)\s*(?:lpa|lakhs?|l\b|lakh per annum)/);
  if (lpa) {
    return { min: Math.round(Number(lpa[1]) * 100000), max: Math.round(Number(lpa[2]) * 100000), currency: "INR" };
  }
  const inr = t.match(/(?:₹|inr|rs\.?)\s*(\d{5,9})\s*(?:-|–|to)\s*(?:₹|inr|rs\.?)?\s*(\d{5,9})/);
  if (inr) return { min: Number(inr[1]), max: Number(inr[2]), currency: "INR" };
  return { min: null, max: null, currency: null };
}

export function detectWorkMode(text: string): JobWorkMode {
  const t = text.toLowerCase();
  if (/\bhybrid\b/.test(t)) return "hybrid";
  if (/\b(fully remote|remote[- ]first|100% remote|remote \(india\)|remote - india|work from home|remote role|remote position|remote-friendly|\bremote\b)/.test(t) && !/not remote|no remote/.test(t)) {
    return "remote";
  }
  if (/\b(on[- ]?site|in[- ]office|work from office|wfo|office-based)\b/.test(t)) return "onsite";
  return "unknown";
}

export function detectEmploymentType(text: string): EmploymentType {
  const t = text.toLowerCase();
  if (/\bintern(ship)?\b/.test(t)) return "internship";
  if (/\b(contract|contractor|freelance|c2h)\b/.test(t)) return "contract";
  if (/\bpart[- ]time\b/.test(t)) return "part_time";
  if (/\bfull[- ]time\b|\bpermanent\b/.test(t)) return "full_time";
  return "unknown";
}

export function detectSeniority(title: string, minYears: number | null): SeniorityLevel {
  const t = title.toLowerCase();
  if (/\bintern\b/.test(t)) return "intern";
  if (/\b(principal|architect|distinguished)\b/.test(t)) return "principal";
  if (/\b(lead|staff|manager|head)\b/.test(t)) return "lead";
  if (/\b(senior|sr\.?|sde[- ]?(iii|3)|l5)\b/.test(t)) return "senior";
  if (/\b(junior|jr\.?|associate|graduate|fresher|sde[- ]?(i|1))\b/.test(t)) return "junior";
  if (/\b(sde[- ]?(ii|2)|mid)\b/.test(t)) return "mid";
  if (minYears == null) return "unknown";
  if (minYears >= 8) return "lead";
  if (minYears >= 5) return "senior";
  if (minYears >= 2) return "mid";
  return "junior";
}

const JOB_BOARD_HOSTS: [RegExp, JobPlatform][] = [
  [/naukri\./i, "NAUKRI"],
  [/indeed\./i, "INDEED"],
  [/instahyre\./i, "INSTAHYRE"],
  [/linkedin\./i, "LINKEDIN"],
  [/greenhouse\.io/i, "GREENHOUSE"],
  [/lever\.co/i, "LEVER"],
  [/myworkdayjobs\.com|workday/i, "WORKDAY"],
  [/ashbyhq\.com/i, "ASHBY"],
];

export function detectPlatformFromUrl(url: string | null | undefined): JobPlatform | null {
  if (!url) return null;
  for (const [re, platform] of JOB_BOARD_HOSTS) if (re.test(url)) return platform;
  return null;
}

const ATS_PLATFORMS: JobPlatform[] = ["GREENHOUSE", "LEVER", "WORKDAY", "ASHBY", "COMPANY_CAREER_PAGE"];
const JOB_BOARDS: JobPlatform[] = ["NAUKRI", "INDEED", "INSTAHYRE", "LINKEDIN"];

export function deriveApplyMethod(platform: JobPlatform, applyUrl: string | null, hrEmail: string | null): ApplyMethod {
  if (!applyUrl && hrEmail) return "EMAIL";
  if (!applyUrl) return "MANUAL";
  if (ATS_PLATFORMS.includes(platform)) return "CAREER_PAGE";
  if (JOB_BOARDS.includes(platform)) return "PLATFORM";
  return "CAREER_PAGE";
}

function guessTitle(lines: string[]): string | null {
  for (const raw of lines.slice(0, 5)) {
    const line = raw.replace(/^[#*\s]+/, "").trim();
    const m = line.match(/^(?:job title|title|position|role)\s*[:-]\s*(.+)$/i);
    if (m?.[1]) return m[1].trim();
  }
  const first = lines.find((l) => l.trim().length > 0)?.replace(/^[#*\s]+/, "").trim();
  if (first && first.length <= 90 && !/[.!?]$/.test(first) && !detectHeading(first)) {
    return first.replace(/\s+(?:at|@)\s+.+$/i, "").trim();
  }
  return null;
}

function guessCompany(text: string, lines: string[]): string | null {
  const labelled = text.match(/^\s*(?:company|organi[sz]ation|employer)\s*[:-]\s*(.+)$/im);
  if (labelled?.[1]) return labelled[1].trim();
  const first = lines.find((l) => l.trim().length > 0) ?? "";
  const at = first.match(/\s(?:at|@)\s+([A-Z][\w&.\- ]{1,60})$/);
  if (at?.[1]) return at[1].trim();
  const about = text.match(/about\s+([A-Z][\w&.-]+(?:\s[A-Z][\w&.-]+){0,3})\s*[:\n]/);
  if (about?.[1] && !/^(the|us|you|this)$/i.test(about[1])) return about[1].trim();
  return null;
}

function toSkills(names: string[], mandatoryNames: Set<string>): JobSkill[] {
  const seen = new Set<string>();
  const skills: JobSkill[] = [];
  for (const name of names) {
    const canonical = normalizeSkill(name);
    if (!canonical || seen.has(canonical.toLowerCase())) continue;
    seen.add(canonical.toLowerCase());
    skills.push({ name: name.trim(), canonicalName: canonical, mandatory: mandatoryNames.has(canonical) });
  }
  return skills;
}

/**
 * A remote location tied to another country ("Remote - US", "Remote (UK)") keeps that country: normalizeLocation
 * would turn it into "Remote - India", and the job's country decides which work-authorisation answers apply.
 */
function normalizeHintLocation(raw: string): string {
  const value = raw.trim().replace(/\s+/g, " ");
  if (isRemoteLocation(value)) {
    const country = countryForLocations([value]);
    if (country && country !== "india") return value;
  }
  return normalizeLocation(value);
}

const MANDATORY_MARKERS = /\b(must|mandatory|required|strong|expert|proficien|deep|solid|essential)\b/i;
const OTHER_REQUIREMENT_MARKERS =
  /\b(degree|b\.?tech|b\.?e\.?|bachelor|master|graduate|immediate joiner|notice period|work authori[sz]ation|visa|relocat|shift|night shift|travel|certification|certified)\b/i;

export function parseJobDescription(rawText: string, hints: JobParseHints): NormalizedJob {
  const text = (rawText || "").replace(/\r\n?/g, "\n").trim();
  const lines = text.split("\n");

  const buckets: Record<Section, string[]> = {
    intro: [],
    responsibilities: [],
    required: [],
    preferred: [],
    screening: [],
    apply: [],
    other: [],
  };
  let current: Section = "intro";
  for (const line of lines) {
    const heading = detectHeading(line);
    if (heading) {
      current = heading;
      continue;
    }
    if (line.trim()) buckets[current].push(line.trim());
  }

  // Skills
  const hasRequirementSections = buckets.required.length > 0 || buckets.preferred.length > 0;
  const requiredText = buckets.required.join("\n");
  const preferredText = buckets.preferred.join("\n");
  const mandatory = new Set<string>();
  for (const line of buckets.required) {
    if (MANDATORY_MARKERS.test(line)) for (const s of extractSkillsFromText(line)) mandatory.add(s);
  }
  let requiredNames: string[];
  let preferredNames: string[];
  if (hints.requiredSkills && hints.requiredSkills.length > 0) {
    requiredNames = hints.requiredSkills;
  } else if (hasRequirementSections) {
    requiredNames = extractSkillsFromText(requiredText);
  } else {
    requiredNames = extractSkillsFromText(text);
  }
  if (hints.preferredSkills && hints.preferredSkills.length > 0) {
    preferredNames = hints.preferredSkills;
  } else {
    preferredNames = extractSkillsFromText(preferredText);
  }
  // Mandatory markers for explicit skill hints: "React (must)".
  const cleanHint = (s: string) => {
    if (/\((must|mandatory|required)\)/i.test(s)) mandatory.add(normalizeSkill(s.replace(/\(.*\)/, "")));
    return s.replace(/\((must|mandatory|required)\)/i, "").trim();
  };
  requiredNames = requiredNames.map(cleanHint);
  const requiredSkills = toSkills(requiredNames, mandatory);
  const requiredSet = new Set(requiredSkills.map((s) => s.canonicalName));
  const preferredSkills = toSkills(preferredNames, new Set()).filter((s) => !requiredSet.has(s.canonicalName));

  // Other (non-skill) requirements
  const otherRequirements: JobOtherRequirement[] = [];
  for (const line of [...buckets.required, ...buckets.preferred, ...buckets.intro]) {
    const clean = stripBullet(line);
    if (OTHER_REQUIREMENT_MARKERS.test(clean) && clean.length <= 300) {
      otherRequirements.push({
        text: clean,
        mandatory: buckets.required.includes(line) && !/\b(preferred|plus|nice)\b/i.test(clean),
      });
    }
  }

  let exp = extractExperienceRange(requiredText || text);
  if (exp.min == null && exp.max == null) exp = extractExperienceRange(text);
  const salary = extractSalary(text);
  const urls = extractUrls(text);

  const title = (hints.title?.trim() || guessTitle(lines) || "Untitled role").slice(0, 200);
  const company = (hints.company?.trim() || guessCompany(text, lines) || "Unknown company").slice(0, 200);

  let locations: string[];
  if (Array.isArray(hints.location) && hints.location.length > 0) {
    locations = hints.location.map(normalizeHintLocation);
  } else if (typeof hints.location === "string" && hints.location.trim()) {
    locations = hints.location.split(/[,/|;]/).map((l) => l.trim()).filter(Boolean).map(normalizeHintLocation);
  } else {
    locations = extractLocationsFromText(text);
  }
  locations = [...new Set(locations)];

  const workMode = hints.workMode && hints.workMode !== "unknown" ? hints.workMode : detectWorkMode(text);

  const applyUrl =
    hints.applyUrl ??
    urls.find((u) => /apply|careers?|jobs|greenhouse|lever\.co|workday|ashbyhq/i.test(u)) ??
    null;
  // Only an address the posting asks applications to be sent to (the "How to apply" section or a "send your CV to
  // ..." sentence) - never the first address in the text, which may be a fraud-report, privacy or support contact.
  const hrEmail = hints.hrEmail ?? applicationContactEmail(text, buckets.apply);

  const platform =
    hints.platform ?? detectPlatformFromUrl(hints.sourceUrl) ?? detectPlatformFromUrl(applyUrl) ?? (hrEmail && !applyUrl ? "OTHER" : "OTHER");

  const screeningQuestions = [
    ...buckets.screening.map(stripBullet),
    ...lines.map((l) => stripBullet(l)).filter((l) => /\?$/.test(l) && l.length > 10 && l.length < 220 && !buckets.screening.includes(l)),
  ];

  const applicationInstructions =
    hints.applicationInstructions ?? (buckets.apply.length > 0 ? buckets.apply.map(stripBullet).join(" ").slice(0, 2000) : null);

  const responsibilities = buckets.responsibilities.map(stripBullet).filter((l) => l.length > 3).slice(0, 40);

  const minYears = hints.experienceMinYears ?? exp.min;
  const maxYears = hints.experienceMaxYears ?? exp.max;

  return {
    platform,
    title,
    company,
    companyWebsite: hints.companyWebsite ?? null,
    location: locations,
    workMode,
    employmentType: hints.employmentType ?? detectEmploymentType(text),
    seniority: detectSeniority(title, minYears),
    description: text,
    responsibilities,
    requiredSkills,
    preferredSkills,
    otherRequirements: otherRequirements.slice(0, 20),
    domains: detectDomains(`${title}\n${buckets.intro.join("\n")}\n${buckets.responsibilities.join("\n")}`),
    experienceMinYears: minYears,
    experienceMaxYears: maxYears,
    salaryMin: hints.salaryMin ?? salary.min,
    salaryMax: hints.salaryMax ?? salary.max,
    currency: hints.currency ?? salary.currency,
    postedAt: hints.postedAt ?? null,
    expiresAt: hints.expiresAt ?? null,
    applyUrl,
    hrEmail,
    applicationInstructions,
    screeningQuestions: [...new Set(screeningQuestions)].slice(0, 10),
    applyMethod: deriveApplyMethod(platform, applyUrl, hrEmail),
    importMethod: hints.importMethod,
    sourceUrl: hints.sourceUrl ?? null,
    sourceExternalId: hints.sourceExternalId ?? null,
    isDemo: hints.isDemo ?? false,
  };
}
