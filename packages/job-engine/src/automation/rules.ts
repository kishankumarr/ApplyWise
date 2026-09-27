import type {
  ApplyMethod,
  AutomationDecision,
  AutomationRuleConfig,
  JobWorkMode,
  RuleCheck,
  RuleCheckKey,
  RuleContext,
  RuleEffect,
  RuleEvaluation,
  RuleJobInput,
  RuleMatchInput,
  RuleOutcome,
} from "@applywise/types";
import { titleMatchesRole } from "../feeds/relevance";
import { roleFamilies } from "../matching";
import { normalizeSkill } from "../taxonomy";

/**
 * Automation rule engine.
 *
 * Deterministic and explainable. It never recomputes the match score: the numeric score comes from
 * computeMatchReport (matching.ts); rules only route the job:
 *   score < recommendScore -> IGNORE; < minMatchScore -> RECOMMEND; < autoApplyScore -> REVIEW; else AUTO_ELIGIBLE,
 * then each check may ignore the job, cap the decision (RECOMMEND/REVIEW), raise it (preferred company) or defer it
 * (daily limit). Every check is returned with a plain-language detail.
 *
 * Pure: no I/O and no clock reads (the current time is `ctx.now`), so identical inputs give identical output.
 */

export const AUTOMATION_RULES_VERSION = "rules-v1";

export const DEFAULT_AUTOMATION_RULE_CONFIG: AutomationRuleConfig = {
  recommendScore: 50,
  minMatchScore: 70,
  autoApplyScore: 90,
  maxJobAgeDays: 14,
  maxApplicationsPerDay: 10,
  enabledProviders: [],
  targetTitles: [],
  excludedTitles: [],
  preferredCompanies: [],
  excludedCompanies: [],
  requiredSkills: [],
  requiredSkillsMode: "any",
  allowMissingMandatorySkills: false,
  maxExperienceGapYears: 1,
  locationMode: "preferences",
  allowedWorkModes: [],
  minSalary: null,
  salaryCurrency: "INR",
  allowedApplyMethods: [],
};

/** Display label per check, in the order checks are returned. */
export const AUTOMATION_RULE_CHECK_LABELS: Record<RuleCheckKey, string> = {
  match_score: "Match score",
  excluded_title: "Excluded titles",
  target_title: "Target titles",
  excluded_company: "Excluded companies",
  preferred_company: "Preferred companies",
  required_skills: "Required skills",
  mandatory_skills: "Mandatory skills",
  experience: "Experience",
  location: "Location",
  work_mode: "Work mode",
  salary: "Salary",
  job_age: "Job age",
  provider: "Job source",
  apply_method: "Apply method",
  description_level: "Job description",
  daily_limit: "Daily limit",
  already_applied: "Already applied",
};

/** IGNORE < RECOMMEND < REVIEW < AUTO_ELIGIBLE. */
const DECISION_RANK: Record<AutomationDecision, number> = {
  IGNORE: 0,
  RECOMMEND: 1,
  REVIEW: 2,
  AUTO_ELIGIBLE: 3,
};

/** Most decisive first when several checks ignore the same job. */
const IGNORE_REASON_ORDER: RuleCheckKey[] = [
  "already_applied",
  "excluded_company",
  "excluded_title",
  "provider",
  "apply_method",
  "required_skills",
  "experience",
  "location",
  "work_mode",
  "salary",
  "job_age",
  "match_score",
];

const MAX_REASONS = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

const WORK_MODE_TEXT: Record<JobWorkMode, string> = {
  remote: "Remote",
  hybrid: "Hybrid",
  onsite: "On-site",
  unknown: "Unknown",
};

const APPLY_METHOD_TEXT: Record<ApplyMethod, string> = {
  PLATFORM: "the job platform",
  CAREER_PAGE: "the company career page",
  EMAIL: "email",
  MANUAL: "a manual process",
};

/** Legal-form and generic words dropped from the end of company names ("Zoho India Pvt. Ltd." -> "zoho"). */
const COMPANY_SUFFIXES = new Set([
  "pvt",
  "private",
  "ltd",
  "limited",
  "inc",
  "incorporated",
  "llp",
  "llc",
  "corp",
  "corporation",
  "co",
  "plc",
  "gmbh",
  "technologies",
  "technology",
  "labs",
  "india",
  "solutions",
  "software",
]);

// ------------------------------------------------------------------ text helpers

function cleanList(values: readonly string[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim().replace(/\s+/g, " ");
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

/** "A", "A and B", "A, B and C", "A, B, C and 2 more". */
function humanList(items: readonly string[], max = 3): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length > max) return `${items.slice(0, max).join(", ")} and ${items.length - max} more`;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** Round to 2 decimals so year arithmetic like 2.1 - 1.1 compares cleanly. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Locale-independent thousands grouping (1200000 -> "1,200,000"). */
function formatAmount(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Lowercase words; letters, digits, "+" and "#" are word characters ("C++", "C#"). */
function words(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^\p{L}\p{N}+#]+/u)
    .filter(Boolean);
}

/** Case-insensitive whole-word phrase match. */
function containsPhrase(text: string, phrase: string): boolean {
  const needle = words(phrase).join(" ");
  if (!needle) return false;
  return ` ${words(text).join(" ")} `.includes(` ${needle} `);
}

/** Lowercase, punctuation stripped, trailing legal/generic suffixes removed. Never empty for a non-empty name. */
function normalizeCompany(name: string): string {
  const tokens = name
    .toLowerCase()
    .replace(/['’]/g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  const stripped = [...tokens];
  while (stripped.length > 0 && COMPANY_SUFFIXES.has(stripped[stripped.length - 1]!))
    stripped.pop();
  // "Software Solutions Pvt Ltd" would strip to nothing and then match every company: keep the full name instead.
  return (stripped.length > 0 ? stripped : tokens).join(" ");
}

/** Equal after normalisation, or one name contains the other as whole words ("Google" ~ "Google Cloud India"). */
function companyMatches(company: string, listed: string): boolean {
  const a = normalizeCompany(company);
  const b = normalizeCompany(listed);
  if (!a || !b) return false;
  return a === b || ` ${a} `.includes(` ${b} `) || ` ${b} `.includes(` ${a} `);
}

function skillKey(name: string): string {
  return normalizeSkill(name).toLowerCase();
}

// ------------------------------------------------------------------ checks

function makeCheck(
  key: RuleCheckKey,
  outcome: RuleOutcome,
  effect: RuleEffect,
  detail: string,
): RuleCheck {
  return { key, label: AUTOMATION_RULE_CHECK_LABELS[key], outcome, effect, detail };
}

const pass = (key: RuleCheckKey, detail: string) => makeCheck(key, "pass", "none", detail);
const skip = (key: RuleCheckKey, detail: string) => makeCheck(key, "skip", "none", detail);

/** Decision from the score thresholds alone. */
export function automationScoreDecision(
  score: number,
  config: Pick<AutomationRuleConfig, "recommendScore" | "minMatchScore" | "autoApplyScore">,
): AutomationDecision {
  if (score < config.recommendScore) return "IGNORE";
  if (score < config.minMatchScore) return "RECOMMEND";
  if (score < config.autoApplyScore) return "REVIEW";
  return "AUTO_ELIGIBLE";
}

function checkMatchScore(
  score: number,
  decision: AutomationDecision,
  config: AutomationRuleConfig,
): RuleCheck {
  switch (decision) {
    case "IGNORE":
      return makeCheck(
        "match_score",
        "fail",
        "ignore",
        `Match score ${score} is below the recommend threshold ${config.recommendScore}`,
      );
    case "RECOMMEND":
      return makeCheck(
        "match_score",
        "warn",
        "none",
        `Match score ${score} is below the minimum match score ${config.minMatchScore}`,
      );
    case "REVIEW":
      return makeCheck(
        "match_score",
        "warn",
        "none",
        `Match score ${score} is below the auto-apply threshold ${config.autoApplyScore}`,
      );
    case "AUTO_ELIGIBLE":
      return pass(
        "match_score",
        `Match score ${score} ≥ auto-apply threshold ${config.autoApplyScore}`,
      );
  }
}

function checkExcludedTitle(job: RuleJobInput, config: AutomationRuleConfig): RuleCheck {
  const excluded = cleanList(config.excludedTitles);
  if (excluded.length === 0) return skip("excluded_title", "No excluded title words set");
  const hit = excluded.find((term) => containsPhrase(job.title, term));
  if (hit) {
    return makeCheck(
      "excluded_title",
      "fail",
      "ignore",
      `Title "${job.title}" contains the excluded term "${hit}"`,
    );
  }
  return pass("excluded_title", "Title contains none of your excluded terms");
}

function checkTargetTitle(job: RuleJobInput, config: AutomationRuleConfig): RuleCheck {
  const targets = cleanList(config.targetTitles);
  if (targets.length === 0)
    return skip("target_title", "No target titles set - every title is considered");
  // Every significant word of a target (seniority and filler words ignored, synonyms merged).
  const direct = targets.find((target) => titleMatchesRole(job.title, target));
  if (direct) return pass("target_title", `Title matches your target "${direct}"`);
  const families = new Set(roleFamilies(job.title));
  const sameFamily =
    families.size > 0
      ? targets.find((target) => roleFamilies(target).some((f) => families.has(f)))
      : undefined;
  if (sameFamily)
    return pass("target_title", `Title is in the same role family as your target "${sameFamily}"`);
  return makeCheck(
    "target_title",
    "fail",
    "cap_recommend",
    `Title "${job.title}" does not match your target titles (${humanList(targets)})`,
  );
}

function checkExcludedCompany(job: RuleJobInput, config: AutomationRuleConfig): RuleCheck {
  const excluded = cleanList(config.excludedCompanies);
  if (excluded.length === 0) return skip("excluded_company", "No excluded companies set");
  const hit = excluded.find((name) => companyMatches(job.company, name));
  if (hit) {
    const detail =
      normalizeCompany(hit) === normalizeCompany(job.company)
        ? `${job.company} is on your excluded companies list`
        : `${job.company} matches the excluded company "${hit}"`;
    return makeCheck("excluded_company", "fail", "ignore", detail);
  }
  return pass("excluded_company", `${job.company} is not an excluded company`);
}

/** Preferred-company match; the detail is finalised once the decision is known. */
function findPreferredCompany(
  job: RuleJobInput,
  config: AutomationRuleConfig,
): { configured: boolean; hit: string | null } {
  const preferred = cleanList(config.preferredCompanies);
  return {
    configured: preferred.length > 0,
    hit: preferred.find((name) => companyMatches(job.company, name)) ?? null,
  };
}

function checkRequiredSkills(job: RuleJobInput, config: AutomationRuleConfig): RuleCheck {
  const wanted: { key: string; label: string }[] = [];
  for (const skill of cleanList(config.requiredSkills)) {
    const label = normalizeSkill(skill);
    const key = label.toLowerCase();
    if (!wanted.some((w) => w.key === key)) wanted.push({ key, label });
  }
  if (wanted.length === 0) return skip("required_skills", "No required skills set");

  const jobSkills = new Set([...job.requiredSkills, ...job.preferredSkills].map(skillKey));
  const present = wanted.filter((w) => jobSkills.has(w.key)).map((w) => w.label);
  const absent = wanted.filter((w) => !jobSkills.has(w.key)).map((w) => w.label);
  const all = config.requiredSkillsMode === "all";

  if (all ? absent.length === 0 : present.length > 0) {
    return pass(
      "required_skills",
      all
        ? `The job lists all your required skills (${humanList(present)})`
        : `The job lists ${humanList(present)}`,
    );
  }
  const missingText = all
    ? `does not list ${humanList(absent)}`
    : `lists none of your required skills (${humanList(absent)})`;
  // An alert-email snippet rarely names every skill: absence is unknown, not a mismatch.
  if (job.descriptionLevel === "SNIPPET") {
    return makeCheck(
      "required_skills",
      "warn",
      "cap_review",
      `Only a description snippet is available and it ${missingText} - check the full posting`,
    );
  }
  return makeCheck("required_skills", "fail", "ignore", `The job ${missingText}`);
}

function checkMandatorySkills(match: RuleMatchInput, config: AutomationRuleConfig): RuleCheck {
  const missing = cleanList(match.missingMandatorySkills);
  if (config.allowMissingMandatorySkills) {
    return skip(
      "mandatory_skills",
      missing.length > 0
        ? `Missing mandatory skills are allowed by your rules (${humanList(missing)})`
        : "Missing mandatory skills are allowed by your rules",
    );
  }
  if (missing.length === 0)
    return pass("mandatory_skills", "No mandatory skill is missing from your verified profile");
  return makeCheck(
    "mandatory_skills",
    "warn",
    "cap_review",
    `Missing mandatory skill${missing.length === 1 ? "" : "s"}: ${humanList(missing)} - needs your review`,
  );
}

function checkExperience(
  job: RuleJobInput,
  config: AutomationRuleConfig,
  ctx: RuleContext,
): RuleCheck {
  const min = job.experienceMinYears;
  const yoe = ctx.candidateYoe;
  if (min == null) return pass("experience", "The job does not state a minimum experience");
  if (yoe == null) {
    return makeCheck(
      "experience",
      "warn",
      "cap_review",
      `The job asks for at least ${plural(min, "year")}; add your years of experience to check the fit`,
    );
  }
  const gap = round2(min - yoe);
  if (gap <= 0) {
    return pass(
      "experience",
      `Your ${plural(yoe, "year")} meet the ${plural(min, "year")} minimum`,
    );
  }
  const allowance = config.maxExperienceGapYears;
  if (gap > allowance) {
    return makeCheck(
      "experience",
      "fail",
      "ignore",
      `The job asks for at least ${plural(min, "year")}; you have ${yoe} (${plural(gap, "year")} short, allowed gap ${allowance})`,
    );
  }
  return pass(
    "experience",
    `The job asks for ${plural(min, "year")}; you have ${yoe} (within your ${plural(allowance, "year")} allowance)`,
  );
}

function checkLocation(
  job: RuleJobInput,
  match: RuleMatchInput,
  config: AutomationRuleConfig,
): RuleCheck {
  if (config.locationMode !== "preferences") return skip("location", "Any location is accepted");
  const where = job.locations.length > 0 ? job.locations.join(" / ") : "The job location";
  switch (match.locationFit) {
    case "good":
      return pass("location", `${where} matches your location preferences`);
    case "partial":
      return pass("location", `${where} partly matches your location preferences`);
    case "poor":
      return makeCheck("location", "fail", "ignore", `${where} is not in your preferred locations`);
    case "unknown":
      return makeCheck(
        "location",
        "warn",
        "cap_review",
        "The job location is unclear - needs your review",
      );
  }
}

function checkWorkMode(job: RuleJobInput, config: AutomationRuleConfig): RuleCheck {
  const allowed = [...new Set(config.allowedWorkModes)].filter((m) => m !== "unknown");
  if (allowed.length === 0) return skip("work_mode", "Every work mode is accepted");
  const allowedText = humanList(allowed.map((m) => WORK_MODE_TEXT[m].toLowerCase()));
  if (job.workMode === "unknown") {
    return makeCheck(
      "work_mode",
      "warn",
      "cap_review",
      `The job does not state a work mode (you accept ${allowedText})`,
    );
  }
  if (allowed.includes(job.workMode))
    return pass("work_mode", `${WORK_MODE_TEXT[job.workMode]} is an accepted work mode`);
  return makeCheck(
    "work_mode",
    "fail",
    "ignore",
    `${WORK_MODE_TEXT[job.workMode]} is not an accepted work mode (you accept ${allowedText})`,
  );
}

function checkSalary(job: RuleJobInput, config: AutomationRuleConfig): RuleCheck {
  const min = config.minSalary;
  if (min == null) return skip("salary", "No minimum salary set");
  const currency = config.salaryCurrency.trim().toUpperCase();
  const minText = `${formatAmount(min)} ${currency}`;
  if (job.salaryMax == null)
    return pass("salary", `The job does not state a maximum salary (your minimum is ${minText})`);
  const jobCurrency = job.currency?.trim().toUpperCase() || null;
  if (jobCurrency != null && jobCurrency !== currency) {
    return pass(
      "salary",
      `The salary is in ${jobCurrency}; your minimum is in ${currency}, so it was not compared`,
    );
  }
  const maxText = `${formatAmount(job.salaryMax)} ${jobCurrency ?? currency}`;
  if (job.salaryMax < min) {
    return makeCheck(
      "salary",
      "fail",
      "ignore",
      `Maximum salary ${maxText} is below your minimum of ${minText}`,
    );
  }
  return pass("salary", `Salary up to ${maxText} meets your minimum of ${minText}`);
}

function parseTime(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

function checkJobAge(job: RuleJobInput, config: AutomationRuleConfig, ctx: RuleContext): RuleCheck {
  const posted = parseTime(job.postedAt);
  const since = posted ?? parseTime(job.foundAt);
  const now = ctx.now.getTime();
  if (since == null || Number.isNaN(now)) {
    return makeCheck(
      "job_age",
      "warn",
      "cap_review",
      "The posting date is unknown - needs your review",
    );
  }
  // Whole days elapsed; a posting dated in the future (clock skew) counts as today.
  const days = Math.max(0, Math.floor((now - since) / DAY_MS));
  const verb = posted != null ? "Posted" : "Found";
  const age = days === 0 ? `${verb} today` : `${verb} ${plural(days, "day")} ago`;
  const note = posted != null ? "" : "; posting date unknown";
  if (days > config.maxJobAgeDays)
    return makeCheck("job_age", "fail", "ignore", `${age} (max ${config.maxJobAgeDays}${note})`);
  return pass("job_age", `${age} (max ${config.maxJobAgeDays}${note})`);
}

function checkProvider(job: RuleJobInput, config: AutomationRuleConfig): RuleCheck {
  const enabled = cleanList(config.enabledProviders).map((p) => p.toLowerCase());
  if (enabled.length === 0) return skip("provider", "Every job source is enabled");
  if (enabled.includes(job.providerId.trim().toLowerCase()))
    return pass("provider", `Job source "${job.providerId}" is enabled`);
  return makeCheck(
    "provider",
    "fail",
    "ignore",
    `Job source "${job.providerId}" is not enabled for automation`,
  );
}

function checkApplyMethod(job: RuleJobInput, config: AutomationRuleConfig): RuleCheck {
  const allowed = [...new Set(config.allowedApplyMethods)];
  if (allowed.length === 0) return skip("apply_method", "Every apply method is accepted");
  const how = APPLY_METHOD_TEXT[job.applyMethod] ?? job.applyMethod;
  if (allowed.includes(job.applyMethod))
    return pass("apply_method", `Applies via ${how}, an accepted apply method`);
  return makeCheck(
    "apply_method",
    "fail",
    "ignore",
    `Applies via ${how}, which is not an accepted apply method`,
  );
}

function checkDescriptionLevel(job: RuleJobInput): RuleCheck {
  if (job.descriptionLevel === "SNIPPET") {
    return makeCheck(
      "description_level",
      "warn",
      "cap_review",
      "Only a description snippet is available (job alert) - needs your review",
    );
  }
  return pass("description_level", "The full job description is available");
}

function checkAlreadyApplied(ctx: RuleContext): RuleCheck {
  if (ctx.alreadyApplied) {
    return makeCheck(
      "already_applied",
      "fail",
      "ignore",
      "You already applied to this job (possibly through another source)",
    );
  }
  return pass("already_applied", "No other application for this job");
}

function checkDailyLimit(
  decision: AutomationDecision,
  config: AutomationRuleConfig,
  ctx: RuleContext,
): { check: RuleCheck; deferred: boolean } {
  const used = ctx.applicationsToday;
  const limit = config.maxApplicationsPerDay;
  if (decision !== "AUTO_ELIGIBLE") {
    return {
      check: pass(
        "daily_limit",
        `Applies only to auto-eligible jobs (${used}/${limit} used today)`,
      ),
      deferred: false,
    };
  }
  if (used >= limit) {
    return {
      check: makeCheck(
        "daily_limit",
        "warn",
        "defer",
        `Daily limit reached (${used}/${limit}) - will be submitted when a slot frees up`,
      ),
      deferred: true,
    };
  }
  return {
    check: pass("daily_limit", `${used} of ${limit} automatic applications used today`),
    deferred: false,
  };
}

function capOf(effect: RuleEffect): AutomationDecision | null {
  if (effect === "cap_recommend") return "RECOMMEND";
  if (effect === "cap_review") return "REVIEW";
  return null;
}

// ------------------------------------------------------------------ engine

/**
 * Route one job. Each check reports `outcome` (pass / fail / warn / skip = rule not configured) and `effect`: the
 * effect it contributes to the decision ("none" when it contributes nothing). Combination: any `ignore` -> IGNORE;
 * otherwise the score decision, raised RECOMMEND -> REVIEW by a preferred company, then lowered to the lowest cap.
 * An AUTO_ELIGIBLE job over the daily limit stays AUTO_ELIGIBLE with `deferredByDailyLimit`.
 */
export function evaluateAutomationRules(
  job: RuleJobInput,
  match: RuleMatchInput,
  config: AutomationRuleConfig,
  ctx: RuleContext,
): RuleEvaluation {
  const score = match.score;
  const scoreDecision = automationScoreDecision(score, config);
  const preferred = findPreferredCompany(job, config);

  const checks: RuleCheck[] = [
    checkMatchScore(score, scoreDecision, config),
    checkExcludedTitle(job, config),
    checkTargetTitle(job, config),
    checkExcludedCompany(job, config),
    // preferred_company and daily_limit are finalised below, once the decision is known.
    skip("preferred_company", ""),
    checkRequiredSkills(job, config),
    checkMandatorySkills(match, config),
    checkExperience(job, config, ctx),
    checkLocation(job, match, config),
    checkWorkMode(job, config),
    checkSalary(job, config),
    checkJobAge(job, config, ctx),
    checkProvider(job, config),
    checkApplyMethod(job, config),
    checkDescriptionLevel(job),
    skip("daily_limit", ""),
    checkAlreadyApplied(ctx),
  ];

  const ignoring = checks.filter((c) => c.effect === "ignore");
  const caps = checks.filter((c) => capOf(c.effect) != null);

  let decision: AutomationDecision;
  let afterRaise: AutomationDecision = scoreDecision;
  if (ignoring.length > 0) {
    decision = "IGNORE";
  } else {
    if (preferred.hit != null && scoreDecision === "RECOMMEND") afterRaise = "REVIEW";
    decision = afterRaise;
    for (const c of caps) {
      const cap = capOf(c.effect)!;
      if (DECISION_RANK[cap] < DECISION_RANK[decision]) decision = cap;
    }
  }
  const raised = afterRaise !== scoreDecision && decision === afterRaise;

  let preferredCheck: RuleCheck;
  if (!preferred.configured) {
    preferredCheck = skip("preferred_company", "No preferred companies set");
  } else if (preferred.hit == null) {
    preferredCheck = pass(
      "preferred_company",
      `${job.company} is not one of your preferred companies`,
    );
  } else {
    const suffix = raised
      ? " - raised to review"
      : afterRaise !== scoreDecision
        ? ", but another rule limits this job to a recommendation"
        : "";
    preferredCheck = makeCheck(
      "preferred_company",
      "pass",
      "raise_review",
      `${job.company} is a preferred company${suffix}`,
    );
  }
  const daily = checkDailyLimit(decision, config, ctx);
  const finalChecks = checks.map((c) =>
    c.key === "preferred_company" ? preferredCheck : c.key === "daily_limit" ? daily.check : c,
  );

  return {
    decision,
    scoreDecision,
    score,
    checks: finalChecks,
    reasons: buildReasons(decision, scoreDecision, afterRaise, raised, finalChecks),
    deferredByDailyLimit: daily.deferred,
    engineVersion: AUTOMATION_RULES_VERSION,
  };
}

/** 1-5 short reasons for the final decision, most decisive first. */
function buildReasons(
  decision: AutomationDecision,
  scoreDecision: AutomationDecision,
  afterRaise: AutomationDecision,
  raised: boolean,
  checks: RuleCheck[],
): string[] {
  const byKey = (key: RuleCheckKey) => checks.find((c) => c.key === key)!;
  const reasons: string[] = [];

  if (decision === "IGNORE") {
    const ignoring = checks.filter((c) => c.effect === "ignore");
    ignoring.sort(
      (a, b) => IGNORE_REASON_ORDER.indexOf(a.key) - IGNORE_REASON_ORDER.indexOf(b.key),
    );
    reasons.push(...ignoring.map((c) => c.detail));
  } else {
    const capChecks = checks.filter((c) => capOf(c.effect) != null);
    // Caps that actually lowered the decision explain it best; the others still block automation later.
    const binding =
      DECISION_RANK[decision] < DECISION_RANK[afterRaise]
        ? capChecks.filter((c) => capOf(c.effect) === decision)
        : [];
    const preferred = byKey("preferred_company");
    const daily = byKey("daily_limit");
    reasons.push(...binding.map((c) => c.detail));
    if (raised) reasons.push(preferred.detail);
    reasons.push(byKey("match_score").detail);
    if (daily.effect === "defer") reasons.push(daily.detail);
    reasons.push(...capChecks.filter((c) => !binding.includes(c)).map((c) => c.detail));
    if (!raised && preferred.effect === "raise_review" && afterRaise !== scoreDecision)
      reasons.push(preferred.detail);
  }

  return [...new Set(reasons)].slice(0, MAX_REASONS);
}
