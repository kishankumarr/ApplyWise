import { describe, expect, it } from "vitest";
import { computeMatchReport, generateRuleBasedQuestionnaire } from "../src";
import { makeCandidate, makeJob } from "./fixtures";

const ctx = {
  noticePeriod: null,
  expectedSalaryMin: null,
  expectedSalaryMax: null,
  preferredLocations: ["Bengaluru"],
  openToRelocation: false,
  topExperienceBullets: [{ id: "f1", text: "Built a video timeline editor" }],
};

describe("rule-based questionnaire", () => {
  it("returns 3-8 questions with conditional detail questions for missing skills", () => {
    const job = makeJob({
      requiredSkills: [
        { name: "Kubernetes", canonicalName: "Kubernetes", mandatory: true },
        { name: "React", canonicalName: "React", mandatory: false },
      ],
      screeningQuestions: ["Are you comfortable with on-call?"],
      description: "Immediate joiners preferred. Please share expected CTC.",
    });
    const qs = generateRuleBasedQuestionnaire(job, computeMatchReport(job, makeCandidate()), ctx);
    expect(qs.length).toBeGreaterThanOrEqual(3);
    expect(qs.length).toBeLessThanOrEqual(8);
    const skill = qs.find((q) => q.id === "skill_kubernetes")!;
    expect(skill.type).toBe("SKILL_CONFIRMATION");
    expect(skill.options!.map((o) => o.value)).toEqual(expect.arrayContaining(["no", "not_sure"]));
    const detail = qs.find((q) => q.id === "skill_kubernetes_detail")!;
    expect(detail.showWhen).toEqual({ questionId: "skill_kubernetes", equalsAny: ["yes_professional", "yes_project"] });
    expect(qs[0]!.type).toBe("SCREENING");
    expect(qs.some((q) => q.id === "elig_notice")).toBe(true);
    expect(qs.some((q) => q.id === "pref_salary")).toBe(true);
  });

  it("only asks about salary / work authorisation when the JD makes it relevant", () => {
    const job = makeJob({ description: "Build UIs." });
    const qs = generateRuleBasedQuestionnaire(job, computeMatchReport(job, makeCandidate()), ctx);
    expect(qs.some((q) => q.id === "pref_salary" || q.id === "elig_work_auth" || q.id === "elig_notice")).toBe(false);
    expect(qs.length).toBeGreaterThanOrEqual(3);
  });
});
