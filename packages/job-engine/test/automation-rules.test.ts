import type {
  AutomationDecision,
  AutomationRuleConfig,
  RuleCheck,
  RuleCheckKey,
  RuleContext,
  RuleEvaluation,
  RuleJobInput,
  RuleMatchInput,
} from "@applywise/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AUTOMATION_RULE_CHECK_LABELS,
  AUTOMATION_RULES_VERSION,
  DEFAULT_AUTOMATION_RULE_CONFIG,
  automationScoreDecision,
  evaluateAutomationRules,
} from "../src/automation/rules";

const NOW = new Date("2026-09-27T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

function ago(ms: number, now: Date = NOW): string {
  return new Date(now.getTime() - ms).toISOString();
}

function makeRuleJob(overrides: Partial<RuleJobInput> = {}): RuleJobInput {
  return {
    title: "Senior Frontend Engineer",
    company: "Acme Technologies Pvt. Ltd.",
    platform: "GREENHOUSE",
    providerId: "greenhouse",
    locations: ["Bengaluru"],
    workMode: "hybrid",
    applyMethod: "PLATFORM",
    salaryMin: null,
    salaryMax: null,
    currency: null,
    experienceMinYears: 3,
    experienceMaxYears: 6,
    postedAt: ago(2 * DAY),
    foundAt: ago(1 * DAY),
    descriptionLevel: "FULL",
    requiredSkills: ["React", "TypeScript"],
    preferredSkills: ["GraphQL"],
    ...overrides,
  };
}

function makeMatch(overrides: Partial<RuleMatchInput> = {}): RuleMatchInput {
  return { score: 93, missingMandatorySkills: [], locationFit: "good", ...overrides };
}

function makeConfig(overrides: Partial<AutomationRuleConfig> = {}): AutomationRuleConfig {
  return {
    ...DEFAULT_AUTOMATION_RULE_CONFIG,
    autoApplyScore: 90,
    maxJobAgeDays: 7,
    maxApplicationsPerDay: 30,
    ...overrides,
  };
}

function makeCtx(overrides: Partial<RuleContext> = {}): RuleContext {
  return { now: NOW, candidateYoe: 5, applicationsToday: 3, alreadyApplied: false, ...overrides };
}

interface EvalInput {
  job?: Partial<RuleJobInput>;
  match?: Partial<RuleMatchInput>;
  config?: Partial<AutomationRuleConfig>;
  ctx?: Partial<RuleContext>;
}

function evaluate(input: EvalInput = {}): RuleEvaluation {
  return evaluateAutomationRules(
    makeRuleJob(input.job),
    makeMatch(input.match),
    makeConfig(input.config),
    makeCtx(input.ctx),
  );
}

function checkOf(result: RuleEvaluation, key: RuleCheckKey): RuleCheck {
  const found = result.checks.filter((c) => c.key === key);
  expect(found).toHaveLength(1);
  return found[0]!;
}

function expectCheck(
  result: RuleEvaluation,
  key: RuleCheckKey,
  outcome: RuleCheck["outcome"],
  effect: RuleCheck["effect"],
): RuleCheck {
  const check = checkOf(result, key);
  expect({ key, outcome: check.outcome, effect: check.effect }).toEqual({ key, outcome, effect });
  expect(check.detail.length).toBeGreaterThan(0);
  return check;
}

const ALL_KEYS = Object.keys(AUTOMATION_RULE_CHECK_LABELS) as RuleCheckKey[];

// ------------------------------------------------------------------ score routing

describe("score routing", () => {
  it.each<[number, AutomationDecision]>([
    [0, "IGNORE"],
    [49, "IGNORE"],
    [50, "RECOMMEND"],
    [69, "RECOMMEND"],
    [70, "REVIEW"],
    [89, "REVIEW"],
    [90, "AUTO_ELIGIBLE"],
    [100, "AUTO_ELIGIBLE"],
  ])("routes score %i to %s at the exact thresholds", (score, expected) => {
    const result = evaluate({ match: { score } });
    expect(result.scoreDecision).toBe(expected);
    expect(result.decision).toBe(expected);
    expect(result.score).toBe(score);
    expect(automationScoreDecision(score, makeConfig())).toBe(expected);
  });

  it("follows custom thresholds", () => {
    const config = { recommendScore: 30, minMatchScore: 60, autoApplyScore: 80 };
    expect(evaluate({ match: { score: 29 }, config }).decision).toBe("IGNORE");
    expect(evaluate({ match: { score: 30 }, config }).decision).toBe("RECOMMEND");
    expect(evaluate({ match: { score: 60 }, config }).decision).toBe("REVIEW");
    expect(evaluate({ match: { score: 80 }, config }).decision).toBe("AUTO_ELIGIBLE");
  });

  it("always emits an explained match_score check", () => {
    expect(
      expectCheck(evaluate({ match: { score: 93 } }), "match_score", "pass", "none").detail,
    ).toBe("Match score 93 ≥ auto-apply threshold 90");
    expect(
      expectCheck(evaluate({ match: { score: 89 } }), "match_score", "warn", "none").detail,
    ).toMatch(/Match score 89 .*auto-apply threshold 90/);
    expect(
      expectCheck(evaluate({ match: { score: 60 } }), "match_score", "warn", "none").detail,
    ).toMatch(/Match score 60 .*minimum match score 70/);
    expect(
      expectCheck(evaluate({ match: { score: 40 } }), "match_score", "fail", "ignore").detail,
    ).toMatch(/Match score 40 .*recommend threshold 50/);
  });

  it("keeps the score decision separate from the final decision", () => {
    const result = evaluate({ match: { score: 95 }, job: { descriptionLevel: "SNIPPET" } });
    expect(result.scoreDecision).toBe("AUTO_ELIGIBLE");
    expect(result.decision).toBe("REVIEW");
  });
});

// ------------------------------------------------------------------ check list shape

describe("check list", () => {
  it("returns exactly one labelled check per key, in the documented order", () => {
    const result = evaluate();
    expect(result.checks.map((c) => c.key)).toEqual(ALL_KEYS);
    expect(ALL_KEYS).toHaveLength(17);
    for (const check of result.checks) {
      expect(check.label).toBe(AUTOMATION_RULE_CHECK_LABELS[check.key]);
      expect(check.detail.trim().length).toBeGreaterThan(0);
    }
  });

  it("skips every rule that is not configured", () => {
    const result = evaluateAutomationRules(
      makeRuleJob(),
      makeMatch(),
      DEFAULT_AUTOMATION_RULE_CONFIG,
      makeCtx(),
    );
    const skipped = result.checks.filter((c) => c.outcome === "skip").map((c) => c.key);
    expect(skipped).toEqual([
      "excluded_title",
      "target_title",
      "excluded_company",
      "preferred_company",
      "required_skills",
      "work_mode",
      "salary",
      "provider",
      "apply_method",
    ]);
    expect(result.decision).toBe("AUTO_ELIGIBLE");
  });

  it("treats blank list entries as not configured", () => {
    const result = evaluate({
      config: {
        excludedTitles: ["  "],
        targetTitles: [""],
        excludedCompanies: [" "],
        requiredSkills: [""],
        enabledProviders: [" "],
      },
    });
    for (const key of [
      "excluded_title",
      "target_title",
      "excluded_company",
      "required_skills",
      "provider",
    ] as const) {
      expectCheck(result, key, "skip", "none");
    }
    expect(result.decision).toBe("AUTO_ELIGIBLE");
  });

  it("gives passing and skipped checks no effect", () => {
    const result = evaluate({ config: { preferredCompanies: ["Globex"] } });
    for (const check of result.checks.filter((c) => c.outcome === "pass" || c.outcome === "skip")) {
      expect(check.effect).toBe("none");
    }
  });
});

// ------------------------------------------------------------------ ignore checks

describe("excluded_title", () => {
  it("ignores a case-insensitive whole-word match", () => {
    const result = evaluate({
      job: { title: "Senior SALES Engineer" },
      config: { excludedTitles: ["sales"] },
    });
    expect(result.decision).toBe("IGNORE");
    expect(expectCheck(result, "excluded_title", "fail", "ignore").detail).toContain('"sales"');
  });

  it("matches multi-word phrases only when contiguous", () => {
    expect(
      evaluate({ job: { title: "Frontend Team Lead" }, config: { excludedTitles: ["team lead"] } })
        .decision,
    ).toBe("IGNORE");
    const apart = evaluate({
      job: { title: "Lead Frontend Engineer, Platform Team" },
      config: { excludedTitles: ["team lead"] },
    });
    expect(apart.decision).toBe("AUTO_ELIGIBLE");
    expectCheck(apart, "excluded_title", "pass", "none");
  });

  it("does not match inside other words", () => {
    expect(
      evaluate({
        job: { title: "Internal Tools Engineer" },
        config: { excludedTitles: ["intern"] },
      }).decision,
    ).toBe("AUTO_ELIGIBLE");
    expect(
      evaluate({ job: { title: "Frontend Intern" }, config: { excludedTitles: ["intern"] } })
        .decision,
    ).toBe("IGNORE");
  });

  it("ignores punctuation around words", () => {
    expect(
      evaluate({
        job: { title: "Frontend Engineer (QA Automation)" },
        config: { excludedTitles: ["qa"] },
      }).decision,
    ).toBe("IGNORE");
    expect(
      evaluate({ job: { title: "C++ Developer" }, config: { excludedTitles: ["C++"] } }).decision,
    ).toBe("IGNORE");
    expect(
      evaluate({ job: { title: "C Developer" }, config: { excludedTitles: ["C++"] } }).decision,
    ).not.toBe("IGNORE");
  });
});

describe("excluded_company", () => {
  it("normalises legal suffixes and punctuation", () => {
    const result = evaluate({
      job: { company: "ACME Technologies Pvt. Ltd." },
      config: { excludedCompanies: ["acme technologies private limited"] },
    });
    expect(result.decision).toBe("IGNORE");
    expect(expectCheck(result, "excluded_company", "fail", "ignore").detail).toContain(
      "excluded companies list",
    );
    expect(
      evaluate({ job: { company: "Zoho India Pvt Ltd" }, config: { excludedCompanies: ["Zoho"] } })
        .decision,
    ).toBe("IGNORE");
    expect(
      evaluate({
        job: { company: "Acme Labs" },
        config: { excludedCompanies: ["ACME Software Solutions"] },
      }).decision,
    ).toBe("IGNORE");
  });

  it("matches when one name contains the other as whole words, in either direction", () => {
    expect(
      evaluate({
        job: { company: "Google Cloud India" },
        config: { excludedCompanies: ["Google"] },
      }).decision,
    ).toBe("IGNORE");
    expect(
      evaluate({
        job: { company: "Amazon" },
        config: { excludedCompanies: ["Amazon Web Services"] },
      }).decision,
    ).toBe("IGNORE");
  });

  it("does not match partial words or unrelated names", () => {
    const partial = evaluate({
      job: { company: "Acmeware" },
      config: { excludedCompanies: ["Acme"] },
    });
    expect(partial.decision).toBe("AUTO_ELIGIBLE");
    expectCheck(partial, "excluded_company", "pass", "none");
    expect(
      evaluate({ job: { company: "Metaform Solutions" }, config: { excludedCompanies: ["Meta"] } })
        .decision,
    ).toBe("AUTO_ELIGIBLE");
  });

  it("never lets a suffix-only name match every company", () => {
    expect(
      evaluate({
        job: { company: "Globex Corporation" },
        config: { excludedCompanies: ["Software Solutions Pvt Ltd"] },
      }).decision,
    ).toBe("AUTO_ELIGIBLE");
    expect(
      evaluate({
        job: { company: "Globex Corporation" },
        config: { excludedCompanies: ["Pvt. Ltd."] },
      }).decision,
    ).toBe("AUTO_ELIGIBLE");
  });
});

describe("required_skills", () => {
  it("mode any passes when at least one configured skill is listed", () => {
    const result = evaluate({
      config: { requiredSkills: ["Vue", "React"], requiredSkillsMode: "any" },
    });
    expect(result.decision).toBe("AUTO_ELIGIBLE");
    expect(expectCheck(result, "required_skills", "pass", "none").detail).toContain("React");
  });

  it("mode any ignores the job when none is listed", () => {
    const result = evaluate({
      config: { requiredSkills: ["Vue", "Svelte"], requiredSkillsMode: "any" },
    });
    expect(result.decision).toBe("IGNORE");
    expectCheck(result, "required_skills", "fail", "ignore");
  });

  it("mode all needs every configured skill", () => {
    expect(
      evaluate({ config: { requiredSkills: ["React", "Kubernetes"], requiredSkillsMode: "all" } })
        .decision,
    ).toBe("IGNORE");
    const result = evaluate({
      config: { requiredSkills: ["react", "typescript", "graphql"], requiredSkillsMode: "all" },
    });
    expect(result.decision).toBe("AUTO_ELIGIBLE");
    expectCheck(result, "required_skills", "pass", "none");
  });

  it("normalises aliases and counts preferred skills", () => {
    const result = evaluate({
      job: { requiredSkills: ["Kubernetes"], preferredSkills: ["React"] },
      config: { requiredSkills: ["k8s", "reactjs"], requiredSkillsMode: "all" },
    });
    expect(result.decision).toBe("AUTO_ELIGIBLE");
    expect(checkOf(result, "required_skills").detail).toContain("Kubernetes");
  });

  it("treats an alert snippet without the skills as unknown (review), not a mismatch", () => {
    const result = evaluate({
      job: { descriptionLevel: "SNIPPET", requiredSkills: [], preferredSkills: [] },
      config: { requiredSkills: ["React"] },
    });
    expect(result.decision).toBe("REVIEW");
    expectCheck(result, "required_skills", "warn", "cap_review");
  });
});

describe("experience", () => {
  it("passes when the job states no minimum", () => {
    expectCheck(
      evaluate({ job: { experienceMinYears: null }, ctx: { candidateYoe: 0 } }),
      "experience",
      "pass",
      "none",
    );
    expectCheck(
      evaluate({ job: { experienceMinYears: null }, ctx: { candidateYoe: null } }),
      "experience",
      "pass",
      "none",
    );
  });

  it("passes when the candidate meets the minimum", () => {
    expectCheck(
      evaluate({ job: { experienceMinYears: 3 }, ctx: { candidateYoe: 5 } }),
      "experience",
      "pass",
      "none",
    );
  });

  it("allows a gap up to maxExperienceGapYears (inclusive)", () => {
    const atLimit = evaluate({
      job: { experienceMinYears: 3 },
      ctx: { candidateYoe: 2 },
      config: { maxExperienceGapYears: 1 },
    });
    expect(atLimit.decision).toBe("AUTO_ELIGIBLE");
    expectCheck(atLimit, "experience", "pass", "none");
    // Floating-point years compare cleanly: 2.1 - 1.1 is a 1-year gap.
    expect(
      evaluate({
        job: { experienceMinYears: 2.1 },
        ctx: { candidateYoe: 1.1 },
        config: { maxExperienceGapYears: 1 },
      }).decision,
    ).toBe("AUTO_ELIGIBLE");
  });

  it("ignores the job when the gap exceeds the allowance", () => {
    const result = evaluate({
      job: { experienceMinYears: 3 },
      ctx: { candidateYoe: 1.9 },
      config: { maxExperienceGapYears: 1 },
    });
    expect(result.decision).toBe("IGNORE");
    expectCheck(result, "experience", "fail", "ignore");
    expect(
      evaluate({
        job: { experienceMinYears: 3 },
        ctx: { candidateYoe: 2 },
        config: { maxExperienceGapYears: 0 },
      }).decision,
    ).toBe("IGNORE");
  });

  it("caps at review when the candidate's experience is unknown", () => {
    const result = evaluate({ job: { experienceMinYears: 3 }, ctx: { candidateYoe: null } });
    expect(result.decision).toBe("REVIEW");
    expectCheck(result, "experience", "warn", "cap_review");
  });
});

describe("location", () => {
  it("passes good and partial fits", () => {
    expectCheck(evaluate({ match: { locationFit: "good" } }), "location", "pass", "none");
    expect(evaluate({ match: { locationFit: "partial" } }).decision).toBe("AUTO_ELIGIBLE");
  });

  it("ignores a poor fit in preferences mode", () => {
    const result = evaluate({ job: { locations: ["Pune"] }, match: { locationFit: "poor" } });
    expect(result.decision).toBe("IGNORE");
    expect(expectCheck(result, "location", "fail", "ignore").detail).toContain("Pune");
  });

  it("caps an unknown fit at review", () => {
    const result = evaluate({ job: { locations: [] }, match: { locationFit: "unknown" } });
    expect(result.decision).toBe("REVIEW");
    expectCheck(result, "location", "warn", "cap_review");
  });

  it("is skipped when any location is accepted", () => {
    for (const locationFit of ["poor", "unknown"] as const) {
      const result = evaluate({ match: { locationFit }, config: { locationMode: "any" } });
      expect(result.decision).toBe("AUTO_ELIGIBLE");
      expectCheck(result, "location", "skip", "none");
    }
  });
});

describe("work_mode", () => {
  it("is skipped when no work mode is configured, even if unknown", () => {
    const result = evaluate({ job: { workMode: "unknown" } });
    expect(result.decision).toBe("AUTO_ELIGIBLE");
    expectCheck(result, "work_mode", "skip", "none");
  });

  it("passes an allowed mode and ignores a disallowed one", () => {
    const config = {
      allowedWorkModes: ["remote", "hybrid"] as AutomationRuleConfig["allowedWorkModes"],
    };
    expectCheck(evaluate({ job: { workMode: "hybrid" }, config }), "work_mode", "pass", "none");
    const onsite = evaluate({ job: { workMode: "onsite" }, config });
    expect(onsite.decision).toBe("IGNORE");
    expectCheck(onsite, "work_mode", "fail", "ignore");
  });

  it("caps an unknown work mode at review when modes are configured", () => {
    const result = evaluate({
      job: { workMode: "unknown" },
      config: { allowedWorkModes: ["remote"] },
    });
    expect(result.decision).toBe("REVIEW");
    expectCheck(result, "work_mode", "warn", "cap_review");
  });
});

describe("salary", () => {
  it("is skipped without a minimum", () => {
    expectCheck(evaluate({ job: { salaryMax: 100, currency: "INR" } }), "salary", "skip", "none");
  });

  it("ignores a stated maximum below the minimum in the same currency", () => {
    const result = evaluate({
      job: { salaryMax: 1_000_000, currency: "INR" },
      config: { minSalary: 1_200_000, salaryCurrency: "INR" },
    });
    expect(result.decision).toBe("IGNORE");
    expect(expectCheck(result, "salary", "fail", "ignore").detail).toBe(
      "Maximum salary 1,000,000 INR is below your minimum of 1,200,000 INR",
    );
  });

  it("passes at exactly the minimum", () => {
    expectCheck(
      evaluate({
        job: { salaryMax: 1_200_000, currency: "INR" },
        config: { minSalary: 1_200_000 },
      }),
      "salary",
      "pass",
      "none",
    );
  });

  it("compares when the job currency is missing or differs only in case", () => {
    expect(
      evaluate({
        job: { salaryMax: 900_000, currency: null },
        config: { minSalary: 1_200_000, salaryCurrency: "INR" },
      }).decision,
    ).toBe("IGNORE");
    expect(
      evaluate({
        job: { salaryMax: 900_000, currency: "inr" },
        config: { minSalary: 1_200_000, salaryCurrency: "INR" },
      }).decision,
    ).toBe("IGNORE");
  });

  it("does not compare different currencies or an unknown maximum", () => {
    expectCheck(
      evaluate({
        job: { salaryMax: 90_000, currency: "USD" },
        config: { minSalary: 1_200_000, salaryCurrency: "INR" },
      }),
      "salary",
      "pass",
      "none",
    );
    const onlyMin = evaluate({
      job: { salaryMin: 500_000, salaryMax: null, currency: "INR" },
      config: { minSalary: 1_200_000 },
    });
    expect(onlyMin.decision).toBe("AUTO_ELIGIBLE");
    expectCheck(onlyMin, "salary", "pass", "none");
  });
});

describe("job_age", () => {
  it("passes at exactly maxJobAgeDays and within the last day of it", () => {
    expectCheck(evaluate({ job: { postedAt: ago(7 * DAY) } }), "job_age", "pass", "none");
    expect(evaluate({ job: { postedAt: ago(8 * DAY - HOUR) } }).decision).toBe("AUTO_ELIGIBLE");
  });

  it("ignores a job older than maxJobAgeDays", () => {
    const result = evaluate({ job: { postedAt: ago(8 * DAY) } });
    expect(result.decision).toBe("IGNORE");
    expect(expectCheck(result, "job_age", "fail", "ignore").detail).toBe(
      "Posted 8 days ago (max 7)",
    );
  });

  it("falls back to foundAt when postedAt is unknown", () => {
    const result = evaluate({ job: { postedAt: null, foundAt: ago(10 * DAY) } });
    expect(result.decision).toBe("IGNORE");
    expect(checkOf(result, "job_age").detail).toMatch(/^Found 10 days ago/);
    expect(evaluate({ job: { postedAt: null, foundAt: ago(1 * DAY) } }).decision).toBe(
      "AUTO_ELIGIBLE",
    );
  });

  it("measures age from ctx.now", () => {
    const job = { postedAt: "2026-09-20T12:00:00.000Z" };
    expect(evaluate({ job, ctx: { now: new Date("2026-09-27T12:00:00.000Z") } }).decision).toBe(
      "AUTO_ELIGIBLE",
    );
    expect(evaluate({ job, ctx: { now: new Date("2026-09-28T12:00:00.000Z") } }).decision).toBe(
      "IGNORE",
    );
  });

  it("counts a future posting date as today", () => {
    expect(checkOf(evaluate({ job: { postedAt: ago(-2 * DAY) } }), "job_age").detail).toBe(
      "Posted today (max 7)",
    );
  });

  it("caps unparseable dates at review", () => {
    const result = evaluate({ job: { postedAt: "not a date", foundAt: "also not a date" } });
    expect(result.decision).toBe("REVIEW");
    expectCheck(result, "job_age", "warn", "cap_review");
  });
});

describe("provider and apply_method", () => {
  it("ignores a provider that is not enabled", () => {
    expectCheck(
      evaluate({ config: { enabledProviders: ["greenhouse", "lever"] } }),
      "provider",
      "pass",
      "none",
    );
    const result = evaluate({
      job: { providerId: "linkedin" },
      config: { enabledProviders: ["greenhouse", "lever"] },
    });
    expect(result.decision).toBe("IGNORE");
    expectCheck(result, "provider", "fail", "ignore");
  });

  it("ignores an apply method that is not allowed", () => {
    expectCheck(
      evaluate({ config: { allowedApplyMethods: ["PLATFORM"] } }),
      "apply_method",
      "pass",
      "none",
    );
    const result = evaluate({
      job: { applyMethod: "EMAIL" },
      config: { allowedApplyMethods: ["PLATFORM", "CAREER_PAGE"] },
    });
    expect(result.decision).toBe("IGNORE");
    expect(expectCheck(result, "apply_method", "fail", "ignore").detail).toContain("email");
  });
});

describe("already_applied", () => {
  it("ignores a job already applied to", () => {
    expectCheck(evaluate(), "already_applied", "pass", "none");
    const result = evaluate({ ctx: { alreadyApplied: true } });
    expect(result.decision).toBe("IGNORE");
    expectCheck(result, "already_applied", "fail", "ignore");
  });
});

// ------------------------------------------------------------------ caps

describe("target_title (cap RECOMMEND)", () => {
  it("is skipped without target titles", () => {
    expectCheck(evaluate({ job: { title: "Data Analyst" } }), "target_title", "skip", "none");
  });

  it("passes when the title has every significant word of a target, ignoring seniority", () => {
    const result = evaluate({
      job: { title: "Senior Frontend Engineer" },
      config: { targetTitles: ["Backend Engineer", "Frontend Engineer"] },
    });
    expect(result.decision).toBe("AUTO_ELIGIBLE");
    expect(expectCheck(result, "target_title", "pass", "none").detail).toContain(
      '"Frontend Engineer"',
    );
  });

  it("passes when role families overlap", () => {
    const result = evaluate({
      job: { title: "React Developer" },
      config: { targetTitles: ["Vue Developer"] },
    });
    expect(result.decision).toBe("AUTO_ELIGIBLE");
    expect(checkOf(result, "target_title").detail).toMatch(/role family/);
  });

  it("caps a non-matching title at RECOMMEND", () => {
    const result = evaluate({
      job: { title: "Backend Engineer" },
      config: { targetTitles: ["Frontend Engineer"] },
    });
    expect(result.decision).toBe("RECOMMEND");
    expectCheck(result, "target_title", "fail", "cap_recommend");
    expect(result.reasons[0]).toBe(checkOf(result, "target_title").detail);
    expect(
      evaluate({
        match: { score: 75 },
        job: { title: "Backend Engineer" },
        config: { targetTitles: ["Frontend Engineer"] },
      }).decision,
    ).toBe("RECOMMEND");
  });

  it("never raises a lower decision", () => {
    expect(
      evaluate({
        match: { score: 40 },
        job: { title: "Data Analyst" },
        config: { targetTitles: ["Frontend Engineer"] },
      }).decision,
    ).toBe("IGNORE");
    expect(
      evaluate({
        match: { score: 60 },
        job: { title: "Data Analyst" },
        config: { targetTitles: ["Frontend Engineer"] },
      }).decision,
    ).toBe("RECOMMEND");
  });
});

describe("cap REVIEW checks", () => {
  it("caps missing mandatory skills at review", () => {
    const result = evaluate({ match: { missingMandatorySkills: ["Kubernetes"] } });
    expect(result.decision).toBe("REVIEW");
    expect(expectCheck(result, "mandatory_skills", "warn", "cap_review").detail).toContain(
      "Kubernetes",
    );
    expect(
      evaluate({ match: { score: 60, missingMandatorySkills: ["Kubernetes"] } }).decision,
    ).toBe("RECOMMEND");
  });

  it("skips the mandatory-skill rule when missing skills are allowed", () => {
    const result = evaluate({
      match: { missingMandatorySkills: ["Kubernetes"] },
      config: { allowMissingMandatorySkills: true },
    });
    expect(result.decision).toBe("AUTO_ELIGIBLE");
    expectCheck(result, "mandatory_skills", "skip", "none");
    expectCheck(evaluate(), "mandatory_skills", "pass", "none");
  });

  it("caps a description snippet at review", () => {
    expectCheck(evaluate(), "description_level", "pass", "none");
    const result = evaluate({ job: { descriptionLevel: "SNIPPET" } });
    expect(result.decision).toBe("REVIEW");
    expectCheck(result, "description_level", "warn", "cap_review");
  });
});

// ------------------------------------------------------------------ raise / defer / precedence

describe("preferred_company (raise RECOMMEND -> REVIEW)", () => {
  it("is skipped without preferred companies", () => {
    expectCheck(evaluate(), "preferred_company", "skip", "none");
  });

  it("raises RECOMMEND to REVIEW", () => {
    const result = evaluate({
      match: { score: 60 },
      job: { company: "Globex India Pvt Ltd" },
      config: { preferredCompanies: ["Globex"] },
    });
    expect(result.scoreDecision).toBe("RECOMMEND");
    expect(result.decision).toBe("REVIEW");
    const check = expectCheck(result, "preferred_company", "pass", "raise_review");
    expect(check.detail).toMatch(/raised to review/);
    expect(result.reasons[0]).toBe(check.detail);
  });

  it("never raises from IGNORE", () => {
    expect(
      evaluate({
        match: { score: 40 },
        job: { company: "Globex" },
        config: { preferredCompanies: ["Globex"] },
      }).decision,
    ).toBe("IGNORE");
  });

  it("never raises above REVIEW", () => {
    expect(
      evaluate({
        match: { score: 80 },
        job: { company: "Globex" },
        config: { preferredCompanies: ["Globex"] },
      }).decision,
    ).toBe("REVIEW");
    expect(
      evaluate({
        match: { score: 93 },
        job: { company: "Globex" },
        config: { preferredCompanies: ["Globex"] },
      }).decision,
    ).toBe("AUTO_ELIGIBLE");
  });

  it("does nothing for other companies", () => {
    const result = evaluate({ match: { score: 60 }, config: { preferredCompanies: ["Globex"] } });
    expect(result.decision).toBe("RECOMMEND");
    expectCheck(result, "preferred_company", "pass", "none");
  });
});

describe("precedence", () => {
  it("ignore beats every cap and the raise", () => {
    const result = evaluate({
      match: { score: 60, missingMandatorySkills: ["Kubernetes"] },
      job: { title: "Data Analyst", descriptionLevel: "SNIPPET", company: "Globex" },
      config: {
        targetTitles: ["Frontend Engineer"],
        preferredCompanies: ["Globex"],
        excludedTitles: ["analyst"],
      },
    });
    expect(result.decision).toBe("IGNORE");
    expect(result.reasons[0]).toBe(checkOf(result, "excluded_title").detail);
  });

  it("caps beat the raise", () => {
    const result = evaluate({
      match: { score: 60 },
      job: { title: "Data Analyst", company: "Globex" },
      config: { targetTitles: ["Frontend Engineer"], preferredCompanies: ["Globex"] },
    });
    expect(result.decision).toBe("RECOMMEND");
    expect(checkOf(result, "preferred_company").detail).toMatch(/another rule limits/);
    expect(result.reasons[0]).toBe(checkOf(result, "target_title").detail);
  });

  it("a REVIEW cap does not undo a raise to REVIEW", () => {
    const result = evaluate({
      match: { score: 60 },
      job: { company: "Globex", descriptionLevel: "SNIPPET" },
      config: { preferredCompanies: ["Globex"] },
    });
    expect(result.decision).toBe("REVIEW");
  });

  it("the lowest cap wins", () => {
    const result = evaluate({
      match: { score: 95, missingMandatorySkills: ["Kubernetes"] },
      job: { title: "Backend Engineer", descriptionLevel: "SNIPPET" },
      config: { targetTitles: ["Frontend Engineer"] },
    });
    expect(result.decision).toBe("RECOMMEND");
    expect(result.reasons[0]).toBe(checkOf(result, "target_title").detail);
    expect(result.reasons).toContain(checkOf(result, "mandatory_skills").detail);
  });
});

describe("daily_limit (defer)", () => {
  it("keeps AUTO_ELIGIBLE but defers when the limit is reached", () => {
    const result = evaluate({
      ctx: { applicationsToday: 30 },
      config: { maxApplicationsPerDay: 30 },
    });
    expect(result.decision).toBe("AUTO_ELIGIBLE");
    expect(result.deferredByDailyLimit).toBe(true);
    expect(expectCheck(result, "daily_limit", "warn", "defer").detail).toBe(
      "Daily limit reached (30/30) - will be submitted when a slot frees up",
    );
    expect(result.reasons).toEqual([
      checkOf(result, "match_score").detail,
      checkOf(result, "daily_limit").detail,
    ]);
  });

  it("does not defer below the limit", () => {
    const result = evaluate({
      ctx: { applicationsToday: 29 },
      config: { maxApplicationsPerDay: 30 },
    });
    expect(result.deferredByDailyLimit).toBe(false);
    expectCheck(result, "daily_limit", "pass", "none");
  });

  it("defers when over the limit or when the limit is zero", () => {
    expect(
      evaluate({ ctx: { applicationsToday: 31 }, config: { maxApplicationsPerDay: 30 } })
        .deferredByDailyLimit,
    ).toBe(true);
    expect(
      evaluate({ ctx: { applicationsToday: 0 }, config: { maxApplicationsPerDay: 0 } })
        .deferredByDailyLimit,
    ).toBe(true);
  });

  it("only applies to AUTO_ELIGIBLE decisions", () => {
    const review = evaluate({ match: { score: 80 }, ctx: { applicationsToday: 30 } });
    expect(review.deferredByDailyLimit).toBe(false);
    expectCheck(review, "daily_limit", "pass", "none");
    const capped = evaluate({
      job: { descriptionLevel: "SNIPPET" },
      ctx: { applicationsToday: 30 },
    });
    expect(capped.decision).toBe("REVIEW");
    expect(capped.deferredByDailyLimit).toBe(false);
    expect(
      evaluate({ ctx: { applicationsToday: 30, alreadyApplied: true } }).deferredByDailyLimit,
    ).toBe(false);
  });
});

// ------------------------------------------------------------------ reasons & determinism

describe("reasons", () => {
  it("returns 1-5 non-empty reasons with the most decisive first", () => {
    const auto = evaluate();
    expect(auto.reasons).toEqual(["Match score 93 ≥ auto-apply threshold 90"]);

    const manyIgnores = evaluate({
      match: { score: 10, locationFit: "poor" },
      job: {
        title: "Sales Manager",
        company: "Globex",
        providerId: "linkedin",
        applyMethod: "EMAIL",
        postedAt: ago(30 * DAY),
      },
      config: {
        excludedTitles: ["sales"],
        excludedCompanies: ["Globex"],
        enabledProviders: ["greenhouse"],
        allowedApplyMethods: ["PLATFORM"],
      },
      ctx: { alreadyApplied: true },
    });
    expect(manyIgnores.decision).toBe("IGNORE");
    expect(manyIgnores.reasons).toHaveLength(5);
    expect(manyIgnores.reasons[0]).toBe(checkOf(manyIgnores, "already_applied").detail);
    expect(manyIgnores.reasons[1]).toBe(checkOf(manyIgnores, "excluded_company").detail);

    for (const result of [
      auto,
      manyIgnores,
      evaluate({ match: { score: 60 } }),
      evaluate({ match: { score: 30 } }),
    ]) {
      expect(result.reasons.length).toBeGreaterThanOrEqual(1);
      expect(result.reasons.length).toBeLessThanOrEqual(5);
      for (const reason of result.reasons) expect(reason.trim().length).toBeGreaterThan(0);
    }
  });

  it("explains an IGNORE by score with the score", () => {
    expect(evaluate({ match: { score: 30 } }).reasons).toEqual([
      checkOf(evaluate({ match: { score: 30 } }), "match_score").detail,
    ]);
  });

  it("puts the binding cap before the score", () => {
    const result = evaluate({ match: { missingMandatorySkills: ["Kubernetes"] } });
    expect(result.reasons[0]).toBe(checkOf(result, "mandatory_skills").detail);
    expect(result.reasons[1]).toBe(checkOf(result, "match_score").detail);
  });
});

describe("determinism", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns identical output for identical input and stamps the engine version", () => {
    const input: EvalInput = {
      match: { score: 72, missingMandatorySkills: ["Kubernetes", "Go"] },
      config: { preferredCompanies: ["Acme"], targetTitles: ["Frontend Engineer"] },
    };
    const a = evaluate(input);
    const b = evaluate(input);
    expect(a).toEqual(b);
    expect(a.engineVersion).toBe(AUTOMATION_RULES_VERSION);
  });

  it("does not read the system clock", () => {
    const job = makeRuleJob({ postedAt: ago(7 * DAY) });
    const first = evaluateAutomationRules(job, makeMatch(), makeConfig(), makeCtx());
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2040-01-01T00:00:00.000Z"));
    const later = evaluateAutomationRules(job, makeMatch(), makeConfig(), makeCtx());
    expect(later).toEqual(first);
    expect(later.decision).toBe("AUTO_ELIGIBLE");
  });

  it("does not mutate its inputs", () => {
    const job = makeRuleJob();
    const match = makeMatch({ missingMandatorySkills: ["Kubernetes"] });
    const config = makeConfig({
      excludedCompanies: ["Globex", "Globex"],
      allowedWorkModes: ["hybrid", "hybrid"],
      requiredSkills: ["react", "React"],
    });
    const ctx = makeCtx();
    const snapshot = JSON.stringify({ job, match, config, ctx });
    evaluateAutomationRules(job, match, config, ctx);
    expect(JSON.stringify({ job, match, config, ctx })).toBe(snapshot);
  });
});

// ------------------------------------------------------------------ canonical example

describe("canonical example: score >= 90, age <= 7 days, location match, no missing mandatory skill, company not excluded, under the daily limit", () => {
  const base: Required<EvalInput> = {
    job: { company: "Initech", postedAt: ago(7 * DAY) },
    match: { score: 90, missingMandatorySkills: [], locationFit: "good" },
    config: {
      autoApplyScore: 90,
      maxJobAgeDays: 7,
      maxApplicationsPerDay: 30,
      excludedCompanies: ["Globex"],
    },
    ctx: { applicationsToday: 29 },
  };
  const variant = (patch: EvalInput): RuleEvaluation =>
    evaluate({
      job: { ...base.job, ...patch.job },
      match: { ...base.match, ...patch.match },
      config: { ...base.config, ...patch.config },
      ctx: { ...base.ctx, ...patch.ctx },
    });

  it("is AUTO_ELIGIBLE when every condition holds", () => {
    const result = variant({});
    expect(result.decision).toBe("AUTO_ELIGIBLE");
    expect(result.deferredByDailyLimit).toBe(false);
    expect(result.checks.filter((c) => c.outcome === "fail" || c.outcome === "warn")).toEqual([]);
  });

  it.each<[string, EvalInput, AutomationDecision, boolean]>([
    ["score 89 (one below the threshold)", { match: { score: 89 } }, "REVIEW", false],
    ["job 8 days old", { job: { postedAt: ago(8 * DAY) } }, "IGNORE", false],
    ["location outside preferences", { match: { locationFit: "poor" } }, "IGNORE", false],
    ["location unknown", { match: { locationFit: "unknown" } }, "REVIEW", false],
    [
      "a mandatory skill missing",
      { match: { missingMandatorySkills: ["Kubernetes"] } },
      "REVIEW",
      false,
    ],
    ["company excluded", { job: { company: "Globex Corporation" } }, "IGNORE", false],
    ["daily limit reached", { ctx: { applicationsToday: 30 } }, "AUTO_ELIGIBLE", true],
  ])("%s", (_label, patch, decision, deferred) => {
    const result = variant(patch);
    expect(result.decision).toBe(decision);
    expect(result.deferredByDailyLimit).toBe(deferred);
    expect(result.reasons.length).toBeGreaterThan(0);
  });
});
