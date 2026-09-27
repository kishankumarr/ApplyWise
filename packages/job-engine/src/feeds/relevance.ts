import type { RawImportedJob } from "../connectors/types";
import { REMOTE_GLOBAL, REMOTE_INDIA, isRemoteLocation, locationsMatch, normalizeLocation } from "../locations";
import { extractSkillsFromText, normalizeSkill } from "../taxonomy";
import type { RelevancePrefs, RelevanceResult } from "./types";
import { INDIA_CITIES, isCountryWideIndia, isIndiaLocation, normalizePlace } from "./util";

/**
 * Cheap, deterministic pre-filter that decides whether an automatically fetched job is worth
 * showing to a user at all. Full fit scoring happens later in the matching engine.
 */

// ---------------------------------------------------------------- role titles

/** Multi-word synonyms collapsed before tokenising (input is lowercase, punctuation-free). */
const ROLE_PHRASES: [RegExp, string][] = [
  [/\bsoftware development engineers?\b/g, " swe "],
  [/\bsoftware (?:engineers?|engineering|developers?|development|programmers?)\b/g, " swe "],
  // "Member of Technical Staff" (MTS/SMTS) is the software-engineer title at many Indian product companies.
  [/\bmembers? (?:of )?(?:the )?technical staff\b/g, " swe "],
  [/\bsite reliability(?: engineers?)?\b/g, " devops engineer "],
  [/\bdev ?sec ?ops\b/g, " devsecops "],
  [/\breact native\b/g, " reactnative "],
  [/\b(react|vue|next|node|angular) js\b/g, " $1js "],
  [/\b(?:ui ux|ux ui)\b/g, " uiux "],
  [/\bui (?:engineers?|developers?)\b/g, " frontend engineer "],
  [/\bfront ?end\b/g, " frontend "],
  [/\bback ?end\b/g, " backend "],
  [/\bfull ?stack\b/g, " fullstack "],
  [/\bmern(?: stack)?\b/g, " fullstack mern "],
  [/\b(mean|mevn) stack\b/g, " fullstack $1 "],
  [/\bgen(?:erative)? ai\b/g, " genai ai "],
  [/\bmachine learning\b/g, " ml "],
  [/\bdata scien(?:tists?|ce)\b/g, " datascientist "],
  [/\bproduct managers?\b/g, " productmanager "],
  [/\bquality (?:assurance|engineering)\b/g, " qa "],
  [/\bdev ops\b/g, " devops "],
];

const ROLE_TOKENS: Record<string, string[]> = {
  sde: ["swe"],
  developer: ["swe"],
  developers: ["swe"],
  programmer: ["swe"],
  engineers: ["engineer"],
  sre: ["devops", "engineer"],
  pm: ["productmanager"],
  sdet: ["qa", "engineer"],
  qe: ["qa"],
  test: ["qa"],
  tester: ["qa"],
  testing: ["qa"],
  // Framework names in titles imply the specialisation ("React Developer" is a frontend role).
  react: ["react", "frontend"],
  reactjs: ["react", "frontend"],
  angular: ["angular", "frontend"],
  angularjs: ["angular", "frontend"],
  vue: ["vue", "frontend"],
  vuejs: ["vue", "frontend"],
  nextjs: ["nextjs", "frontend"],
  node: ["node", "backend"],
  nodejs: ["node", "backend"],
  golang: ["golang", "backend"],
  django: ["django", "backend"],
  reactnative: ["reactnative", "mobile"],
  flutter: ["flutter", "mobile"],
  mts: ["swe"],
  smts: ["swe"],
  lmts: ["swe"],
  pmts: ["swe"],
  devsecops: ["devsecops", "devops"],
  genai: ["genai", "ai"],
  llm: ["llm", "ai"],
  // Level nouns used interchangeably in Indian titles ("Sales Executive" = "Sales Officer").
  specialist: ["executive"],
  officer: ["executive"],
  representative: ["executive"],
  rep: ["executive"],
};

/** Framework -> the specialisation it implies; a role naming one also accepts the plain specialisation. */
const FRAMEWORK_FAMILY: Record<string, string> = {
  react: "frontend",
  angular: "frontend",
  vue: "frontend",
  nextjs: "frontend",
  node: "backend",
  golang: "backend",
  django: "backend",
  reactnative: "mobile",
  flutter: "mobile",
};

/** Seniority words and fillers never affect matching. */
const IGNORED_TOKENS = new Set([
  "senior",
  "sr",
  "lead",
  "staff",
  "principal",
  "junior",
  "jr",
  "associate",
  "i",
  "ii",
  "iii",
  "iv",
  "1",
  "2",
  "3",
  "4",
  "mid",
  "level",
  "the",
  "a",
  "an",
  "and",
  "of",
  "for",
  "to",
  "in",
  "at",
  "with",
  // Work mode and experience words belong to other filters, not the role.
  "remote",
  "hybrid",
  "wfh",
  "onsite",
  "fresher",
  "freshers",
]);

/** Title qualifiers that make a bare "Engineer" a software-engineering role. */
const SOFTWARE_QUALIFIERS = new Set([
  "frontend",
  "backend",
  "fullstack",
  "mobile",
  "android",
  "ios",
  "ml",
  "ai",
  "devops",
  "qa",
  "web",
  "platform",
  "cloud",
  "java",
  "python",
  "golang",
  "node",
  "react",
  "javascript",
  "typescript",
  "embedded",
  "application",
  "applications",
  "software",
  "c++",
  "c#",
  "net",
  "dotnet",
  "php",
  "ruby",
  "rust",
  "scala",
  "kotlin",
  "swift",
]);

/** Specialisations that are engineering roles by themselves ("DevOps Lead", "Frontend Architect"). */
const ENGINEERING_SPECIALISMS = ["frontend", "backend", "fullstack", "mobile", "android", "ios", "devops", "qa", "ml"];

/** A title with one of these is a different job unless the target role names it too. */
const OTHER_ROLE_NOUNS = ["manager", "director", "head", "vp", "recruiter", "designer"];

/** Canonical role tokens: lowercase, punctuation stripped, synonyms merged, seniority removed. */
export function roleTokens(value: string): string[] {
  let s = ` ${value.toLowerCase().replace(/[^a-z0-9+#]+/g, " ")} `;
  for (const [re, replacement] of ROLE_PHRASES) s = s.replace(re, replacement);
  const out: string[] = [];
  for (const token of s.split(/\s+/)) {
    if (!token || IGNORED_TOKENS.has(token)) continue;
    for (const t of ROLE_TOKENS[token] ?? [token]) if (!out.includes(t)) out.push(t);
  }
  return out;
}

function covers(title: Set<string>, token: string, wanted: string[]): boolean {
  if (title.has(token)) return true;
  switch (token) {
    // "Frontend Developer" / "DevOps Lead" satisfy "... Engineer".
    case "engineer":
      return title.has("swe") || ENGINEERING_SPECIALISMS.some((t) => title.has(t));
    // "Backend Engineer" (or just "Engineer") satisfies "Software Engineer"; so does "Salesforce
    // Engineer" for "Salesforce Developer" (the title shares the role's own specialisation).
    case "swe":
      return (
        title.has("engineer") &&
        (title.size === 1 || [...title].some((t) => SOFTWARE_QUALIFIERS.has(t)) || wanted.some((t) => t !== "swe" && title.has(t)))
      );
    // "Manager, Software Engineering" is an "Engineering Manager".
    case "engineering":
      return title.has("swe");
    // "Software Tester" accepts "Manual Tester"; "Software Architect" accepts "Java Architect".
    case "software":
      return title.has("swe") || [...title].some((t) => SOFTWARE_QUALIFIERS.has(t) || ENGINEERING_SPECIALISMS.includes(t));
    // AI and ML engineering titles are used interchangeably.
    case "ml":
      return title.has("ai");
    case "ai":
      return title.has("ml");
    // "UI/UX Designer" accepts "UX Designer" and "UI Designer", and vice versa.
    case "uiux":
      return title.has("ui") || title.has("ux");
    case "ui":
    case "ux":
      return title.has("uiux");
    // "Customer Support Executive" accepts "Customer Support Associate" (the title minus the level noun).
    case "executive":
      return [...title].every((t) => wanted.includes(t));
    // Mobile covers both platforms; one platform accepts a generic mobile title, not the other platform.
    case "mobile":
      return title.has("android") || title.has("ios");
    case "android":
      return title.has("mobile") && !title.has("ios");
    case "ios":
      return title.has("mobile") && !title.has("android");
  }
  // "React Developer" accepts "Frontend Engineer", but not "Angular Developer".
  const family = FRAMEWORK_FAMILY[token];
  if (family && title.has(family)) return ![...title].some((t) => t !== token && FRAMEWORK_FAMILY[t] === family);
  return false;
}

/** The title before its first qualifier: "Software Engineer - Hiring Manager Tools" -> "Software Engineer". */
function titleHead(title: string): string {
  return title
    .split(/\s[-–—|:]\s|[,(]/)
    .map((s) => s.trim())
    .find(Boolean) ?? title;
}

/** Does the job title match the target role? Every role token must be covered by the title. */
export function titleMatchesRole(title: string, role: string): boolean {
  const wanted = roleTokens(role);
  if (wanted.length === 0) return false;
  const have = new Set(roleTokens(title));
  // Only the head noun makes it another job ("Engineering Manager - Backend"), not a qualifier.
  const head = new Set(roleTokens(titleHead(title)));
  if (OTHER_ROLE_NOUNS.some((n) => head.has(n) && !wanted.includes(n))) return false;
  return wanted.every((t) => covers(have, t, wanted));
}

const GENERIC_KEYWORDS = new Set([
  "swe",
  "engineer",
  "engineering",
  "software",
  "manager",
  "specialist",
  "consultant",
  "executive",
  "remote",
  "job",
  "jobs",
  "role",
  "roles",
  "work",
  "india",
  "tech",
  "technical",
]);

/**
 * Loose keyword filter for providers without server-side keyword search (The Muse, Jobicy):
 * the title matches the keywords as a role, or contains any distinctive keyword ("react").
 */
export function titleMatchesKeywords(title: string, keywords: string): boolean {
  const wanted = roleTokens(keywords);
  if (wanted.length === 0) return true;
  if (titleMatchesRole(title, keywords)) return true;
  const have = new Set(roleTokens(title));
  return wanted.some((t) => !GENERIC_KEYWORDS.has(t) && have.has(t));
}

// ---------------------------------------------------------------- locations

/**
 * Normalised job locations. Multi-city strings ("Bengaluru, Mumbai, Pune", Naukri's
 * "Bangalore/Bengaluru, Hyderabad/Secunderabad") yield every city they name, while "City, State,
 * Country" stays one place ("Pune, Maharashtra, India" -> Pune, not also a country-wide "India").
 */
function jobLocations(raw: RawImportedJob): string[] {
  const loc = raw.hints.location;
  const list = Array.isArray(loc) ? loc : typeof loc === "string" ? [loc] : [];
  const out: string[] = [];
  for (const segment of list.flatMap((l) => (typeof l === "string" ? l.split(/[;/|]/) : []))) {
    const value = segment.trim();
    if (!value) continue;
    if (isRemoteLocation(value)) {
      out.push(normalizeLocation(value));
      continue;
    }
    const cities = value.split(",").map((p) => normalizeLocation(p)).filter((c) => INDIA_CITIES.has(c));
    if (cities.length > 0) {
      out.push(...cities);
      continue;
    }
    // normalizePlace drops work-mode words ("Hybrid in Bangalore"; a bare "On-site" names no place)
    // and maps "Pan India" to "India".
    const place = normalizePlace(value).location;
    if (place) out.push(place);
  }
  return [...new Set(out)];
}

interface LocationFit {
  fits: boolean;
  reason: string;
}

function assessLocation(raw: RawImportedJob, prefs: RelevancePrefs): LocationFit {
  const locations = jobLocations(raw);
  const explicitRemote = raw.hints.workMode === "remote";
  const remoteLabels = locations.filter(isRemoteLocation);
  const places = locations.filter((l) => !isRemoteLocation(l));
  const onsiteOnly = prefs.workModePreference === "onsite";

  if (locations.length === 0 && !explicitRemote) return { fits: true, reason: "Location not specified" };

  // Remote option: "Remote - India"/"Remote - Global", or a remote flag without a foreign restriction.
  if (explicitRemote || remoteLabels.length > 0) {
    const foreignOnly = remoteLabels.length === 0 && places.length > 0 && !places.some(isIndiaLocation);
    if (!onsiteOnly && !foreignOnly) {
      const label = remoteLabels.includes(REMOTE_INDIA)
        ? REMOTE_INDIA
        : remoteLabels.includes(REMOTE_GLOBAL)
          ? REMOTE_GLOBAL
          : places.length > 0
            ? `Remote (${places[0]})`
            : "Remote";
      return { fits: true, reason: label };
    }
    if (explicitRemote || places.length === 0) {
      return foreignOnly
        ? { fits: false, reason: `Remote role limited to ${places.join(", ")}` }
        : { fits: false, reason: "Remote role, but you prefer on-site work" };
    }
  }

  // On-site / hybrid / unspecified: a preferred city, a country-only India listing, or relocation.
  const preferred = prefs.preferredLocations.map((p) => p.trim()).filter(Boolean);
  const preferredCities = preferred.filter((p) => !isRemoteLocation(p));
  // No location preferences at all, or "India" / "Pan India" = anywhere in India (unless the candidate only wants remote work).
  const anywhereInIndia =
    (preferred.length === 0 && prefs.workModePreference !== "remote") || preferredCities.some(isCountryWideIndia);
  // A country-only "India" listing could be anywhere in India; it suits anyone not remote-only.
  const anyIndianCity = prefs.workModePreference !== "remote" || preferredCities.length > 0 || prefs.openToRelocation;
  for (const place of places) {
    if (isCountryWideIndia(place) && anyIndianCity) return { fits: true, reason: "India (city not specified)" };
    if (preferredCities.some((p) => locationsMatch(place, p))) return { fits: true, reason: place };
    if (anywhereInIndia && isIndiaLocation(place)) return { fits: true, reason: place };
  }
  if (prefs.openToRelocation) {
    const indian = places.find(isIndiaLocation);
    if (indian) return { fits: true, reason: `${indian} (open to relocation)` };
  }
  const where = places.slice(0, 2).join(", ");
  if (!places.some(isIndiaLocation)) return { fits: false, reason: `Located in ${where} (outside India)` };
  return { fits: false, reason: `${where} is not one of your preferred locations` };
}

// ---------------------------------------------------------------- role / skills

function jobTitle(raw: RawImportedJob): string {
  return (raw.hints.title ?? raw.text.split("\n").find((l) => l.trim()) ?? "").trim();
}

const MIN_SKILL_MATCHES = 3;

/**
 * "Software Engineer / Team Lead", "SDE, Backend Developer" (typed roles, or the current-title
 * fallback) are several roles; unspaced slashes stay ("UI/UX Designer").
 */
function splitRoles(role: string): string[] {
  return role
    .split(/\s+\/\s+|[,;|]|\s+or\s+/i)
    .map((r) => r.trim())
    .filter(Boolean);
}

function assessRole(raw: RawImportedJob, prefs: RelevancePrefs): { fits: boolean; reason: string } {
  const title = jobTitle(raw);
  const roles = [...new Set(prefs.targetRoles.flatMap(splitRoles))];
  if (roles.length > 0) {
    const role = roles.find((r) => titleMatchesRole(title, r));
    return role
      ? { fits: true, reason: `Title matches '${role}'` }
      : { fits: false, reason: "Title doesn't match your target roles" };
  }
  // No target roles: fall back to verified skills mentioned anywhere in the job.
  const wanted = new Map(prefs.skills.map((s) => [normalizeSkill(s).toLowerCase(), normalizeSkill(s)]));
  if (wanted.size === 0) return { fits: false, reason: "Add target roles or skills to get matching jobs" };
  const need = MIN_SKILL_MATCHES;
  const found = extractSkillsFromText(`${title}\n${raw.text}`)
    .map((s) => wanted.get(s.toLowerCase()))
    .filter((s): s is string => !!s);
  const unique = [...new Set(found)];
  if (unique.length >= need) {
    return { fits: true, reason: `Mentions ${unique.length} of your skills (${unique.slice(0, 3).join(", ")})` };
  }
  return { fits: false, reason: `Mentions ${unique.length} of your skills (needs ${need})` };
}

/**
 * Relevant = the title matches a target role (or, without target roles, the job mentions at least
 * three of the candidate's skills) AND the location fits: remote is fine unless the candidate wants
 * on-site work, on-site jobs need a preferred location (or relocation within India), and jobs with
 * no location are allowed.
 */
export function assessRelevance(raw: RawImportedJob, prefs: RelevancePrefs): RelevanceResult {
  const role = assessRole(raw, prefs);
  if (!role.fits) return { relevant: false, reason: role.reason };
  const location = assessLocation(raw, prefs);
  if (!location.fits) return { relevant: false, reason: location.reason };
  return { relevant: true, reason: `${role.reason}; ${location.reason}` };
}
