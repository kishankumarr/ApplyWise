/**
 * Form model for the Automation control centre: converts the server view into editable strings, validates them
 * (mirroring packages/validation/src/automation.ts so errors show inline before the request), and computes the
 * partial PUT body with only the fields the user changed. The server re-validates everything.
 */
import type { ApplicationMode, ApplyMethod, AutomationSettingsView, JobWorkMode } from "@applywise/types";
import type { AutomationRulesUpdateInput, AutomationSettingsUpdateInput } from "@applywise/validation";

export interface RulesForm {
  targetTitles: string[];
  excludedTitles: string[];
  preferredCompanies: string[];
  excludedCompanies: string[];
  requiredSkills: string[];
  requiredSkillsMode: "any" | "all";
  allowMissingMandatorySkills: boolean;
  maxExperienceGapYears: string;
  locationMode: "preferences" | "any";
  allowedWorkModes: JobWorkMode[];
  /** "" = no minimum. */
  minSalary: string;
  salaryCurrency: string;
  allowedApplyMethods: ApplyMethod[];
}

export interface SettingsForm {
  mode: ApplicationMode;
  autoApplyConsent: boolean;
  recommendScore: string;
  minMatchScore: string;
  autoApplyScore: string;
  maxApplicationsPerDay: string;
  maxJobAgeDays: string;
  searchFrequencyMinutes: string;
  /** "all" = empty enabledProviders on the server (every source, including ones added later). */
  providerScope: "all" | "selected";
  enabledProviders: string[];
  quietHoursOn: boolean;
  /** "HH:MM" */
  quietHoursStart: string;
  quietHoursEnd: string;
  timezone: string;
  tailorResume: boolean;
  generateCoverLetter: boolean;
  allowEmailApplications: boolean;
  notifyStrongMatches: boolean;
  /** "" = off, otherwise "0".."23". */
  dailySummaryHour: string;
  rules: RulesForm;
}

export type TopKey = Exclude<keyof SettingsForm, "rules">;

/** Fully typed settings as the PUT body would carry them (every field present). */
export type SettingsValues = Omit<Required<AutomationSettingsUpdateInput>, "enabled" | "rules"> & { rules: Required<AutomationRulesUpdateInput> };

/** Field error map keyed like the UI fields: "recommendScore", "quietHours", "rules.minSalary", ... */
export type FieldErrors = Record<string, string>;

export interface FormApi {
  form: SettingsForm;
  set: <K extends TopKey>(key: K, value: SettingsForm[K]) => void;
  setRule: <K extends keyof RulesForm>(key: K, value: RulesForm[K]) => void;
  error: (key: string) => string | undefined;
  disabled: boolean;
}

// ---------------------------------------------------------------- limits (mirror the Zod schema)

export const LIST_LIMITS: Record<"targetTitles" | "excludedTitles" | "preferredCompanies" | "excludedCompanies" | "requiredSkills", { items: number; length: number }> = {
  targetTitles: { items: 30, length: 120 },
  excludedTitles: { items: 30, length: 120 },
  preferredCompanies: { items: 50, length: 120 },
  excludedCompanies: { items: 100, length: 120 },
  requiredSkills: { items: 30, length: 80 },
};

export const DEFAULT_QUIET_START = 22 * 60;
export const DEFAULT_QUIET_END = 7 * 60;

// ---------------------------------------------------------------- time helpers

const pad = (n: number) => String(n).padStart(2, "0");

export function minutesToTime(minutes: number): string {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

/** "HH:MM" (or "HH:MM:SS" from some browsers) -> minutes after midnight; null when invalid. */
export function timeToMinutes(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

export const hourLabel = (hour: number) => `${pad(hour)}:00`;

export function isValidTimeZone(tz: string): boolean {
  if (!tz.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz.trim() });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- view <-> form

export function fromView(view: AutomationSettingsView): SettingsForm {
  const r = view.rules;
  const quietOn = view.quietHoursStart != null && view.quietHoursEnd != null && view.quietHoursStart !== view.quietHoursEnd;
  return {
    mode: view.mode,
    autoApplyConsent: view.autoApplyConsent,
    recommendScore: String(view.recommendScore),
    minMatchScore: String(view.minMatchScore),
    autoApplyScore: String(view.autoApplyScore),
    maxApplicationsPerDay: String(view.maxApplicationsPerDay),
    maxJobAgeDays: String(view.maxJobAgeDays),
    searchFrequencyMinutes: String(view.searchFrequencyMinutes),
    providerScope: view.enabledProviders.length ? "selected" : "all",
    enabledProviders: [...view.enabledProviders],
    quietHoursOn: quietOn,
    quietHoursStart: minutesToTime(quietOn ? view.quietHoursStart! : DEFAULT_QUIET_START),
    quietHoursEnd: minutesToTime(quietOn ? view.quietHoursEnd! : DEFAULT_QUIET_END),
    timezone: view.timezone,
    tailorResume: view.tailorResume,
    generateCoverLetter: view.generateCoverLetter,
    allowEmailApplications: view.allowEmailApplications,
    notifyStrongMatches: view.notifyStrongMatches,
    dailySummaryHour: view.dailySummaryHour == null ? "" : String(view.dailySummaryHour),
    rules: {
      targetTitles: [...r.targetTitles],
      excludedTitles: [...r.excludedTitles],
      preferredCompanies: [...r.preferredCompanies],
      excludedCompanies: [...r.excludedCompanies],
      requiredSkills: [...r.requiredSkills],
      requiredSkillsMode: r.requiredSkillsMode,
      allowMissingMandatorySkills: r.allowMissingMandatorySkills,
      maxExperienceGapYears: String(r.maxExperienceGapYears),
      locationMode: r.locationMode,
      allowedWorkModes: [...r.allowedWorkModes],
      minSalary: r.minSalary == null ? "" : String(r.minSalary),
      salaryCurrency: r.salaryCurrency,
      allowedApplyMethods: [...r.allowedApplyMethods],
    },
  };
}

const wholeNumber = (s: string): number => (/^\s*\d+\s*$/.test(s) ? Number(s) : Number.NaN);
const decimal = (s: string): number => (/^\s*\d+(\.\d+)?\s*$/.test(s) ? Number(s) : Number.NaN);
const inRange = (n: number, min: number, max: number) => Number.isFinite(n) && n >= min && n <= max;

/**
 * Parse and validate the form. `values` is always returned (best effort); only use it for a request when
 * `errors` is empty. `baseline` enables checks that only apply to edited fields (the operator's daily cap).
 */
export function parseForm(form: SettingsForm, opts: { maxDailyLimit: number; baseline?: SettingsForm }): { values: SettingsValues; errors: FieldErrors } {
  const errors: FieldErrors = {};
  const r = form.rules;

  const score = (key: "recommendScore" | "minMatchScore" | "autoApplyScore"): number => {
    const n = wholeNumber(form[key]);
    if (!inRange(n, 0, 100)) errors[key] = "Enter a whole number from 0 to 100.";
    return n;
  };
  const recommendScore = score("recommendScore");
  const minMatchScore = score("minMatchScore");
  const autoApplyScore = score("autoApplyScore");
  // Invariant: recommend <= minimum <= auto-apply (the server checks it against the merged values).
  if (!errors.recommendScore && !errors.minMatchScore && recommendScore > minMatchScore) {
    errors.recommendScore = `Must not be higher than the minimum match score (${minMatchScore}).`;
    errors.minMatchScore = `Must be at least "Show as recommended from" (${recommendScore}).`;
  }
  if (!errors.minMatchScore && !errors.autoApplyScore && minMatchScore > autoApplyScore) {
    errors.autoApplyScore = `Must be at least the minimum match score (${minMatchScore}).`;
    errors.minMatchScore ??= `Must not be higher than the auto-apply score (${autoApplyScore}).`;
  }

  const maxApplicationsPerDay = wholeNumber(form.maxApplicationsPerDay);
  const dailyEdited = !opts.baseline || opts.baseline.maxApplicationsPerDay.trim() !== form.maxApplicationsPerDay.trim();
  if (!inRange(maxApplicationsPerDay, 0, 500)) errors.maxApplicationsPerDay = "Enter a whole number from 0 to 500.";
  else if (dailyEdited && maxApplicationsPerDay > opts.maxDailyLimit) errors.maxApplicationsPerDay = `This server allows at most ${opts.maxDailyLimit} applications per day.`;

  const maxJobAgeDays = wholeNumber(form.maxJobAgeDays);
  if (!inRange(maxJobAgeDays, 1, 365)) errors.maxJobAgeDays = "Enter a whole number of days from 1 to 365.";

  const searchFrequencyMinutes = wholeNumber(form.searchFrequencyMinutes);
  if (!inRange(searchFrequencyMinutes, 15, 7 * 24 * 60)) errors.searchFrequencyMinutes = "Choose how often to search.";

  let quietHoursStart: number | null = null;
  let quietHoursEnd: number | null = null;
  if (form.quietHoursOn) {
    quietHoursStart = timeToMinutes(form.quietHoursStart);
    quietHoursEnd = timeToMinutes(form.quietHoursEnd);
    if (quietHoursStart == null || quietHoursEnd == null) errors.quietHours = "Enter both a start and an end time (HH:MM).";
    else if (quietHoursStart === quietHoursEnd) errors.quietHours = "The start and end times must be different.";
  }

  const timezone = form.timezone.trim();
  if (!isValidTimeZone(timezone)) errors.timezone = "Use an IANA timezone such as Asia/Kolkata.";

  const enabledProviders = form.providerScope === "all" ? [] : [...new Set(form.enabledProviders)];
  if (form.providerScope === "selected" && enabledProviders.length === 0) errors.enabledProviders = "Select at least one job source, or choose all job sources.";
  else if (enabledProviders.length > 40) errors.enabledProviders = "Select at most 40 job sources.";

  const dailySummaryHour = form.dailySummaryHour === "" ? null : wholeNumber(form.dailySummaryHour);
  if (dailySummaryHour != null && !inRange(dailySummaryHour, 0, 23)) errors.dailySummaryHour = "Choose an hour, or turn the daily summary off.";

  const maxExperienceGapYears = decimal(r.maxExperienceGapYears);
  if (!inRange(maxExperienceGapYears, 0, 20)) errors["rules.maxExperienceGapYears"] = "Enter a number of years from 0 to 20.";

  const minSalary = r.minSalary.trim() === "" ? null : wholeNumber(r.minSalary.replace(/[,_\s]/g, ""));
  if (minSalary != null && !inRange(minSalary, 0, 1_000_000_000)) errors["rules.minSalary"] = "Enter a whole yearly amount, or leave it empty for no minimum.";

  const salaryCurrency = r.salaryCurrency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(salaryCurrency)) errors["rules.salaryCurrency"] = "Use a 3-letter currency code such as INR.";

  for (const key of Object.keys(LIST_LIMITS) as (keyof typeof LIST_LIMITS)[]) {
    const lim = LIST_LIMITS[key];
    if (r[key].length > lim.items) errors[`rules.${key}`] = `Add at most ${lim.items}.`;
    else if (r[key].some((v) => !v.trim() || v.length > lim.length)) errors[`rules.${key}`] = `Each entry must be 1 to ${lim.length} characters.`;
  }

  return {
    values: {
      mode: form.mode,
      autoApplyConsent: form.autoApplyConsent,
      recommendScore,
      minMatchScore,
      autoApplyScore,
      maxApplicationsPerDay,
      maxJobAgeDays,
      searchFrequencyMinutes,
      enabledProviders,
      quietHoursStart,
      quietHoursEnd,
      timezone,
      tailorResume: form.tailorResume,
      generateCoverLetter: form.generateCoverLetter,
      allowEmailApplications: form.allowEmailApplications,
      notifyStrongMatches: form.notifyStrongMatches,
      dailySummaryHour,
      rules: {
        targetTitles: r.targetTitles.map((v) => v.trim()),
        excludedTitles: r.excludedTitles.map((v) => v.trim()),
        preferredCompanies: r.preferredCompanies.map((v) => v.trim()),
        excludedCompanies: r.excludedCompanies.map((v) => v.trim()),
        requiredSkills: r.requiredSkills.map((v) => v.trim()),
        requiredSkillsMode: r.requiredSkillsMode,
        allowMissingMandatorySkills: r.allowMissingMandatorySkills,
        maxExperienceGapYears,
        locationMode: r.locationMode,
        allowedWorkModes: [...new Set(r.allowedWorkModes)],
        minSalary,
        salaryCurrency,
        allowedApplyMethods: [...new Set(r.allowedApplyMethods)],
      },
    },
    errors,
  };
}

// ---------------------------------------------------------------- comparison, diff, rebase

/** Order-insensitive for string lists (sets of titles, providers, work modes). */
function normalize(v: unknown): unknown {
  return Array.isArray(v) ? [...v].map(String).sort() : v;
}
export function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}

function topKeys<T extends object>(o: T): (keyof T)[] {
  return Object.keys(o) as (keyof T)[];
}

export function formsEqual(a: SettingsForm, b: SettingsForm): boolean {
  return topKeys(a).every((k) => (k === "rules" ? topKeys(a.rules).every((rk) => same(a.rules[rk], b.rules[rk])) : same(a[k], b[k])));
}

/** Only the fields that differ from the saved settings. */
export function diffValues(next: SettingsValues, base: SettingsValues): AutomationSettingsUpdateInput {
  const body: Record<string, unknown> = {};
  for (const k of topKeys(next)) {
    if (k === "rules") continue;
    if (!same(next[k], base[k])) body[k] = next[k];
  }
  const rules: Record<string, unknown> = {};
  for (const k of topKeys(next.rules)) if (!same(next.rules[k], base.rules[k])) rules[k] = next.rules[k];
  if (Object.keys(rules).length) body.rules = rules;
  return body as AutomationSettingsUpdateInput;
}

/**
 * Three-way merge: keep the user's edits (fields where `current` differs from `reference`), take everything else
 * from `next`. Used when fresh server data arrives (polling, the ON/OFF switch) and after a save.
 */
export function rebase(current: SettingsForm, reference: SettingsForm, next: SettingsForm): SettingsForm {
  const out = { ...next, rules: { ...next.rules } } as SettingsForm;
  const o = out as unknown as Record<string, unknown>;
  const or = out.rules as unknown as Record<string, unknown>;
  for (const k of topKeys(current)) {
    if (k === "rules") continue;
    if (!same(current[k], reference[k])) o[k] = current[k];
  }
  for (const k of topKeys(current.rules)) if (!same(current.rules[k], reference.rules[k])) or[k] = current.rules[k];
  return out;
}

// ---------------------------------------------------------------- errors

/** UI error key for a form field (several form fields share one message slot). */
export function errorKeyFor(field: TopKey | `rules.${keyof RulesForm}`): string {
  if (field === "quietHoursOn" || field === "quietHoursStart" || field === "quietHoursEnd") return "quietHours";
  if (field === "providerScope") return "enabledProviders";
  return field;
}

const KNOWN_ERROR_KEYS = new Set<string>([
  "mode",
  "autoApplyConsent",
  "recommendScore",
  "minMatchScore",
  "autoApplyScore",
  "maxApplicationsPerDay",
  "maxJobAgeDays",
  "searchFrequencyMinutes",
  "enabledProviders",
  "quietHours",
  "timezone",
  "tailorResume",
  "generateCoverLetter",
  "allowEmailApplications",
  "notifyStrongMatches",
  "dailySummaryHour",
  ...[
    "targetTitles",
    "excludedTitles",
    "preferredCompanies",
    "excludedCompanies",
    "requiredSkills",
    "requiredSkillsMode",
    "allowMissingMandatorySkills",
    "maxExperienceGapYears",
    "locationMode",
    "allowedWorkModes",
    "minSalary",
    "salaryCurrency",
    "allowedApplyMethods",
  ].map((k) => `rules.${k}`),
]);

/** Map the API's Zod paths ("rules.targetTitles.2", "quietHoursEnd") to UI error keys; unknown ones are returned separately. */
export function mapServerFieldErrors(fieldErrors: Record<string, string[]>): { fields: FieldErrors; other: string[] } {
  const fields: FieldErrors = {};
  const other: string[] = [];
  for (const [path, messages] of Object.entries(fieldErrors)) {
    const message = messages[0];
    if (!message) continue;
    const parts = path.split(".");
    let key = parts[0] === "rules" && parts[1] ? `rules.${parts[1]}` : (parts[0] ?? "_");
    if (key === "quietHoursStart" || key === "quietHoursEnd") key = "quietHours";
    if (KNOWN_ERROR_KEYS.has(key)) fields[key] ??= message;
    else other.push(message);
  }
  return { fields, other };
}
