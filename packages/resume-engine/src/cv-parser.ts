import { extractSkillsFromText, normalizeSkill } from "@applywise/job-engine";
import type { ParsedCv } from "./types";

/**
 * Deterministic, rule-based CV parser (fallback when Claude is not configured).
 * It only extracts what is present; ambiguous fields stay null. Nothing is invented.
 */

export const RULE_CV_PARSER_VERSION = "cv-rules-v1";

type CvSection = "header" | "summary" | "experience" | "education" | "projects" | "skills" | "certifications" | "achievements" | "other";

const HEADINGS: [CvSection, RegExp][] = [
  ["summary", /^(professional\s+)?(summary|profile|profile summary|about me|about|objective|career objective)$/i],
  ["experience", /^(work\s+|professional\s+)?(experience|employment( history)?|work history|career history)$/i],
  ["education", /^(education|academics|academic background|qualifications)$/i],
  ["projects", /^(projects|personal projects|side projects|key projects|selected projects)$/i],
  ["skills", /^(technical\s+)?(skills|skill set|core skills|tech stack|technologies|core competencies)$/i],
  ["certifications", /^(certifications?|licenses?( & certifications)?|courses)$/i],
  ["achievements", /^(achievements|awards|honors|honours|accomplishments)$/i],
  ["other", /^(interests|hobbies|languages|references|declaration|personal details)$/i],
];

const MONTHS = "jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december";
const DATE = `(?:(?:${MONTHS})\\.?\\s+\\d{4}|\\d{1,2}/\\d{4}|\\d{4})`;
const DATE_RANGE_RE = new RegExp(`(${DATE})\\s*(?:-|–|—|to)\\s*(${DATE}|present|current|now|till date|ongoing)`, "i");
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE_RE = /(?:\+?91[\s-]?)?(?:\(?\d{3,5}\)?[\s-]?)?\d{3,5}[\s-]?\d{4,5}/;
const URL_RE = /(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[^\s|,]*)?/gi;
const BULLET_RE = /^\s*(?:[-*•●▪◦‣]|\d+[.)])\s+/;

function headingOf(line: string): CvSection | null {
  const cleaned = line.replace(/[:#*_=\-–|]+$/g, "").replace(/^[#*_=\s]+/, "").trim();
  if (!cleaned || cleaned.length > 40) return null;
  for (const [section, re] of HEADINGS) if (re.test(cleaned)) return section;
  return null;
}

function parseDateToken(token: string): { year: number; month: number } | null {
  const t = token.toLowerCase().trim();
  if (/present|current|now|till date|ongoing/.test(t)) return null;
  const year = Number(t.match(/\d{4}/)?.[0]);
  if (!year) return null;
  const monthIdx = MONTHS.split("|").findIndex((m) => t.startsWith(m));
  const slash = t.match(/^(\d{1,2})\/\d{4}$/);
  const month = slash ? Number(slash[1]) - 1 : monthIdx >= 0 ? monthIdx % 12 : 0;
  return { year, month };
}

/** A role's [start, end) in months since year 0 (open-ended roles end now); null without a readable start. */
function monthRange(start: string | null, end: string | null, now: Date): { from: number; to: number } | null {
  if (!start) return null;
  const s = parseDateToken(start);
  if (!s) return null;
  const e = end ? parseDateToken(end) : null;
  const from = s.year * 12 + s.month;
  const to = e ? e.year * 12 + e.month : now.getFullYear() * 12 + now.getMonth();
  return to > from ? { from, to } : null;
}

/**
 * Months covered by the roles' date ranges, with overlapping or back-to-back roles merged: a full-time job and a
 * concurrent freelance role are the same months of experience, never counted twice.
 */
function mergedMonths(ranges: { from: number; to: number }[]): number {
  const sorted = [...ranges].sort((a, b) => a.from - b.from || a.to - b.to);
  let months = 0;
  let current: { from: number; to: number } | null = null;
  for (const r of sorted) {
    if (current && r.from <= current.to) {
      current.to = Math.max(current.to, r.to);
      continue;
    }
    if (current) months += current.to - current.from;
    current = { ...r };
  }
  if (current) months += current.to - current.from;
  return months;
}

function splitHeader(line: string): string[] {
  return line
    .split(/\s+[|·•]\s+|\s+[-–—]\s+|\t+|\s{3,}/)
    .map((p) => p.trim())
    .filter(Boolean);
}

function stripBullet(line: string): string {
  return line.replace(BULLET_RE, "").trim();
}

const LOCATION_HINT = /\b(bengaluru|bangalore|hyderabad|pune|mumbai|gurgaon|gurugram|chennai|noida|delhi|kolkata|remote|india)\b/i;

export function parseCvText(rawText: string, now: Date = new Date()): ParsedCv {
  const text = rawText.replace(/\r\n?/g, "\n");
  const lines = text.split("\n").map((l) => l.trim());

  const sections: Record<CvSection, string[]> = {
    header: [],
    summary: [],
    experience: [],
    education: [],
    projects: [],
    skills: [],
    certifications: [],
    achievements: [],
    other: [],
  };
  let current: CvSection = "header";
  for (const line of lines) {
    const h = headingOf(line);
    if (h) {
      current = h;
      continue;
    }
    if (line) sections[current].push(line);
  }

  // Contact
  const email = text.match(EMAIL_RE)?.[0]?.toLowerCase() ?? null;
  const headerText = sections.header.join("\n");
  const phoneMatch = headerText.replace(EMAIL_RE, "").match(PHONE_RE)?.[0] ?? null;
  const phone = phoneMatch && phoneMatch.replace(/\D/g, "").length >= 10 ? phoneMatch.trim() : null;
  const urls = [...new Set((headerText.match(URL_RE) ?? []).filter((u) => !EMAIL_RE.test(u) && /[a-z]\.[a-z]/i.test(u)))];
  const withProto = (u: string) => (/^https?:\/\//.test(u) ? u : `https://${u}`);
  const github = urls.find((u) => /github\.com/i.test(u)) ?? null;
  const linkedin = urls.find((u) => /linkedin\.com/i.test(u)) ?? null;
  const others = urls.filter((u) => u !== github && u !== linkedin && !/\.(pdf|docx?)$/i.test(u) && !/^\d/.test(u));

  const nameLine = sections.header.find(
    (l) => !EMAIL_RE.test(l) && !PHONE_RE.test(l) && /^[A-Za-z][A-Za-z .'-]{1,60}$/.test(l) && l.split(/\s+/).length <= 5,
  );
  const headlineLine = sections.header.find(
    (l) => l !== nameLine && !EMAIL_RE.test(l) && /(engineer|developer|designer|architect|lead|manager|analyst|consultant)/i.test(l) && l.length <= 100,
  );
  const locationLine = sections.header
    .flatMap((l) => l.split(/\s*[|•·]\s*/))
    .find((part) => LOCATION_HINT.test(part) && !EMAIL_RE.test(part) && part.length <= 60);

  // Experience entries
  const experience: ParsedCv["experience"] = [];
  let pendingHeader: string[] = [];
  for (const line of sections.experience) {
    if (BULLET_RE.test(line)) {
      if (pendingHeader.length) {
        experience.push(buildExperience(pendingHeader));
        pendingHeader = [];
      }
      const last = experience[experience.length - 1];
      if (last) last.bullets.push(stripBullet(line));
      continue;
    }
    const last = experience[experience.length - 1];
    // Wrapped continuation of the previous bullet (starts lower-case).
    if (!pendingHeader.length && last && last.bullets.length > 0 && /^[a-z(]/.test(line)) {
      last.bullets[last.bullets.length - 1] += ` ${line}`;
      continue;
    }
    // Consecutive header lines merge ("Title" + "Company | Dates") until a date range was seen.
    if (pendingHeader.length && (DATE_RANGE_RE.test(pendingHeader.join(" ")) || pendingHeader.length >= 3)) {
      experience.push(buildExperience(pendingHeader));
      pendingHeader = [];
    }
    pendingHeader.push(line);
  }
  if (pendingHeader.length) experience.push(buildExperience(pendingHeader));

  // Total experience: explicit statement wins, else merged date ranges.
  const explicitYears = text.match(/(\d{1,2}(?:\.\d)?)\+?\s*(?:years|yrs)\s+(?:of\s+)?(?:professional\s+|industry\s+|total\s+)?experience/i);
  let totalYearsExperience: number | null = explicitYears ? Number(explicitYears[1]) : null;
  if (totalYearsExperience == null && experience.some((e) => e.startDate)) {
    const ranges = experience
      .map((e) => monthRange(e.startDate, e.isCurrent ? null : e.endDate, now))
      .filter((r): r is { from: number; to: number } => r !== null);
    const months = mergedMonths(ranges);
    totalYearsExperience = months > 0 ? Math.round((months / 12) * 10) / 10 : null;
  }

  // Education
  const education: ParsedCv["education"] = [];
  for (const line of sections.education) {
    const clean = stripBullet(line);
    const years = clean.match(/(19|20)\d{2}/g)?.map(Number) ?? [];
    const degree = clean.match(/\b(B\.?\s?Tech|B\.?E\.?|B\.?Sc|BCA|MCA|M\.?\s?Tech|M\.?Sc|MBA|Bachelor(?:'s)?(?: of [A-Za-z ]+)?|Master(?:'s)?(?: of [A-Za-z ]+)?|Diploma|Ph\.?D)\b/i)?.[0] ?? null;
    const parts = splitHeader(clean.replace(DATE_RANGE_RE, "").replace(/\(?\b(19|20)\d{2}\b\)?/g, "")).filter(Boolean);
    const institution = parts.find((p) => /(university|institute|college|iit|nit|iiit|school|academy|bits)/i.test(p)) ?? null;
    if (!degree && !institution) {
      const prev = education[education.length - 1];
      if (prev && !prev.field && clean.length < 80) prev.field = clean;
      continue;
    }
    const field = clean.match(/\b(?:in|of)\s+(Computer Science|Information Technology|Electronics[A-Za-z &]*|Mechanical[A-Za-z ]*|Electrical[A-Za-z ]*|[A-Z][a-z]+ Engineering)/)?.[1] ?? null;
    education.push({
      institution: institution ?? parts.find((p) => p !== degree) ?? clean,
      degree,
      field,
      startYear: years.length > 1 ? Math.min(...years) : null,
      endYear: years.length ? Math.max(...years) : null,
    });
  }

  // Projects
  const projects: ParsedCv["projects"] = [];
  for (const line of sections.projects) {
    if (BULLET_RE.test(line) && projects.length) {
      const p = projects[projects.length - 1]!;
      p.description = p.description ? `${p.description} ${stripBullet(line)}` : stripBullet(line);
      continue;
    }
    const clean = stripBullet(line);
    const [namePart, ...rest] = clean.split(/\s+[|–—-]\s+|:\s+/);
    const techLabel = clean.match(/(?:tech(?:nologies|\s*stack)?|built with|stack)\s*:\s*(.+)$/i)?.[1];
    const url = clean.match(/https?:\/\/\S+|github\.com\/\S+/i)?.[0] ?? null;
    projects.push({
      name: (namePart ?? clean).slice(0, 120),
      description: rest.join(" - ").replace(/(?:tech(?:nologies|\s*stack)?|built with|stack)\s*:.+$/i, "").trim(),
      technologies: techLabel ? techLabel.split(/[,;|]/).map((t) => normalizeSkill(t)).filter(Boolean) : [],
      url,
    });
  }
  for (const p of projects) {
    if (p.technologies.length === 0) p.technologies = extractSkillsFromText(`${p.name} ${p.description}`);
  }

  // Skills: "Frontend: React, TypeScript" / comma or pipe separated lists
  const skills: string[] = [];
  for (const line of sections.skills) {
    const content = stripBullet(line).replace(/^[A-Za-z &/]{2,30}:\s*/, "");
    for (const s of content.split(/[,;|•·]| {2,}/)) {
      const v = s.trim().replace(/\.$/, "");
      if (v && v.length <= 40 && !skills.some((x) => x.toLowerCase() === v.toLowerCase())) skills.push(v);
    }
  }

  const summaryText = sections.summary.map(stripBullet).join(" ").trim();

  return {
    fullName: nameLine ?? null,
    email,
    phone,
    location: locationLine?.trim() ?? null,
    headline: headlineLine ?? null,
    summary: summaryText || null,
    links: {
      github: github ? withProto(github) : null,
      linkedin: linkedin ? withProto(linkedin) : null,
      portfolio: others[0] ? withProto(others[0]) : null,
      other: others.slice(1).map(withProto),
    },
    totalYearsExperience,
    experience: experience.filter((e) => e.title || e.company),
    education,
    projects,
    skills,
    certifications: sections.certifications.map(stripBullet).filter(Boolean),
    achievements: sections.achievements.map(stripBullet).filter(Boolean),
  };
}

function buildExperience(headerLines: string[]): ParsedCv["experience"][number] {
  const joined = headerLines.join(" | ");
  const range = joined.match(DATE_RANGE_RE);
  const withoutDates = range ? joined.replace(range[0], "") : joined;
  const parts = splitHeader(withoutDates.replace(/\(\s*\)/g, "")).flatMap((p) => p.split(/\s*,\s*(?=[A-Z])/)).filter((p) => p && p !== "|");
  let title = "";
  let company = "";
  let location: string | null = null;
  const at = withoutDates.match(/^(.+?)\s+(?:at|@)\s+(.+?)(?:\s*[|,]|$)/i);
  if (at) {
    title = at[1]!.trim();
    company = at[2]!.trim();
  }
  for (const p of parts) {
    if (!location && LOCATION_HINT.test(p) && p.length <= 40 && p !== company) {
      location = p;
      continue;
    }
    if (!title && /(engineer|developer|designer|architect|lead|manager|intern|analyst|consultant|sde|programmer)/i.test(p)) title = p;
    else if (!company && p !== title) company = p;
  }
  if (!title && parts[0]) title = parts[0];
  const end = range?.[2] ?? null;
  const isCurrent = !!end && /present|current|now|till date|ongoing/i.test(end);
  return {
    title: title.replace(/[|]+/g, "").trim(),
    company: company.replace(/[|]+/g, "").trim(),
    location,
    startDate: range?.[1] ?? null,
    endDate: isCurrent ? null : end,
    isCurrent,
    bullets: [],
  };
}
