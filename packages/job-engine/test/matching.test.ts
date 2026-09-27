import { describe, expect, it } from "vitest";
import { computeMatchReport, PENALTIES, scoreLocation, scoreYoe, SCORE_WEIGHTS } from "../src/matching";
import { makeCandidate, makeJob } from "./fixtures";

describe("match score calculation", () => {
  it("is deterministic and sums its factors", () => {
    const job = makeJob();
    const candidate = makeCandidate();
    const a = computeMatchReport(job, candidate);
    const b = computeMatchReport(job, candidate);
    expect(a).toEqual(b);
    const positive = a.scoreFactors.filter((f) => f.key !== "mandatory_gap_penalty").reduce((s, f) => s + f.points, 0);
    const penalty = a.scoreFactors.find((f) => f.key === "mandatory_gap_penalty")!.points;
    expect(a.estimatedMatchScore).toBe(Math.max(0, Math.min(100, Math.round(positive + penalty))));
    expect(a.scoreFactors.map((f) => f.maxPoints)).toEqual([35, 25, 15, 10, 10, 5, 0]);
  });

  it("scores a strong, verified candidate highly", () => {
    const report = computeMatchReport(makeJob(), makeCandidate());
    expect(report.estimatedMatchScore).toBeGreaterThanOrEqual(70);
    expect(report.scoreLabel).toBe("strong");
    expect(report.applicationRecommendation).toBe("apply");
    expect(report.exactMatches.map((m) => m.canonicalName)).toEqual(expect.arrayContaining(["React", "TypeScript"]));
  });

  it("does not count unverified parsed claims as verified evidence", () => {
    const verified = computeMatchReport(makeJob(), makeCandidate());
    const unverified = computeMatchReport(
      makeJob(),
      makeCandidate({
        facts: makeCandidate().facts.map((f) => ({ ...f, status: "PARSED_UNVERIFIED" as const })),
        skills: makeCandidate().skills.map((s) => ({ ...s, status: "PARSED_UNVERIFIED" as const })),
      }),
    );
    expect(unverified.estimatedMatchScore).toBeLessThan(verified.estimatedMatchScore - 30);
    expect(unverified.exactMatches).toHaveLength(0);
    expect(unverified.unverifiedMatches.map((m) => m.canonicalName)).toContain("React");
    expect(unverified.risks.join(" ")).toMatch(/unverified/);
  });

  it("ignores rejected facts entirely", () => {
    const report = computeMatchReport(
      makeJob(),
      makeCandidate({
        facts: [],
        skills: [{ id: "s1", name: "React", source: "SKILLS_SECTION", status: "USER_REJECTED" }],
      }),
    );
    expect(report.unverifiedMatches).toHaveLength(0);
    expect(report.missingMandatoryRequirements.map((m) => m.canonicalName)).toContain("React");
  });

  it("treats a skills-section-only skill as weaker evidence than experience", () => {
    const job = makeJob({ requiredSkills: [{ name: "Redux", canonicalName: "Redux", mandatory: false }], preferredSkills: [] });
    const skillsOnly = computeMatchReport(
      job,
      makeCandidate({ facts: [], skills: [{ id: "s", name: "Redux", source: "SKILLS_SECTION", status: "USER_VERIFIED" }] }),
    );
    const experience = computeMatchReport(
      job,
      makeCandidate({
        facts: [{ id: "f", kind: "EXPERIENCE_BULLET", text: "Designed Redux store for the dashboard", status: "USER_VERIFIED" }],
        skills: [],
      }),
    );
    const ev = (r: typeof skillsOnly) => r.scoreFactors.find((f) => f.key === "evidence_strength")!.points;
    expect(ev(experience)).toBeGreaterThan(ev(skillsOnly));
    expect(skillsOnly.resumeImprovements.join(" ")).toMatch(/only in your skills list/);
  });

  it("gives related technology partial, not full, credit", () => {
    const job = makeJob({ requiredSkills: [{ name: "Next.js", canonicalName: "Next.js", mandatory: false }], preferredSkills: [] });
    const exact = computeMatchReport(
      job,
      makeCandidate({ facts: [{ id: "f", kind: "EXPERIENCE_BULLET", text: "Built Next.js storefront", status: "USER_VERIFIED" }], skills: [] }),
    );
    const related = computeMatchReport(
      job,
      makeCandidate({ facts: [{ id: "f", kind: "EXPERIENCE_BULLET", text: "Built React storefront", status: "USER_VERIFIED" }], skills: [] }),
    );
    const cov = (r: typeof exact) => r.scoreFactors.find((f) => f.key === "required_skill_coverage")!.points;
    expect(cov(exact)).toBe(35);
    expect(cov(related)).toBe(14);
    expect(related.relatedMatches[0]?.relatedVia).toBe("React");
  });
});

describe("mandatory requirement penalties", () => {
  it("strongly penalises missing mandatory skills", () => {
    const job = makeJob({
      requiredSkills: [
        { name: "React", canonicalName: "React", mandatory: true },
        { name: "Kubernetes", canonicalName: "Kubernetes", mandatory: true },
        { name: "Go", canonicalName: "Go", mandatory: true },
      ],
    });
    const report = computeMatchReport(job, makeCandidate());
    const penalty = report.scoreFactors.find((f) => f.key === "mandatory_gap_penalty")!;
    expect(penalty.points).toBe(-2 * PENALTIES.missingMandatorySkill);
    expect(report.missingMandatoryRequirements.map((m) => m.canonicalName)).toEqual(["Kubernetes", "Go"]);
    expect(report.applicationRecommendation).not.toBe("apply");
  });

  it("does not let a related technology satisfy a mandatory requirement", () => {
    const job = makeJob({ requiredSkills: [{ name: "React Native", canonicalName: "React Native", mandatory: true }], preferredSkills: [] });
    const report = computeMatchReport(job, makeCandidate());
    expect(report.relatedMatches[0]?.relatedVia).toBe("React");
    expect(report.scoreFactors.find((f) => f.key === "mandatory_gap_penalty")!.points).toBe(-PENALTIES.mandatoryOnlyRelated);
    expect(report.risks.join(" ")).toMatch(/only covered by the related skill React/);
    expect(report.applicationRecommendation).not.toBe("apply");
  });

  it("caps total deductions at 25 points", () => {
    const job = makeJob({
      requiredSkills: ["Kubernetes", "Go", "Kafka", "Rust"].map((s) => ({ name: s, canonicalName: s, mandatory: true })),
      location: ["Chennai"],
      workMode: "onsite",
      experienceMinYears: 10,
      experienceMaxYears: 12,
    });
    const report = computeMatchReport(job, makeCandidate());
    expect(report.scoreFactors.find((f) => f.key === "mandatory_gap_penalty")!.points).toBe(-SCORE_WEIGHTS.max_penalty);
    expect(report.scoreLabel).toBe("low");
    expect(report.applicationRecommendation).toBe("do_not_prioritize");
  });
});

describe("YOE scoring", () => {
  it("gives full points within range", () => {
    expect(scoreYoe(5, 4, 7)).toMatchObject({ points: 7, penalty: 0, fit: { fit: "good" } });
  });
  it("reduces points and penalises shortfalls", () => {
    expect(scoreYoe(3, 4, 7)).toMatchObject({ points: 4.5, penalty: PENALTIES.yoeShortfallMinor, fit: { fit: "partial" } });
    expect(scoreYoe(1, 4, 7)).toMatchObject({ points: 0, penalty: PENALTIES.yoeShortfallMajor, fit: { fit: "poor" } });
  });
  it("flags over-qualification without penalty", () => {
    const r = scoreYoe(10, 1, 3);
    expect(r.penalty).toBe(0);
    expect(r.points).toBeGreaterThanOrEqual(2);
    expect(r.fit.explanation).toMatch(/over-qualified/);
  });
  it("is neutral when data is missing", () => {
    expect(scoreYoe(null, 2, 4).fit.fit).toBe("unknown");
    expect(scoreYoe(4, null, null).points).toBe(5);
  });
});

describe("location and work-mode scoring", () => {
  const cand = { preferredLocations: ["Bengaluru", "Remote - India"], workModePreference: "any" as const, openToRelocation: false };

  it("rewards preferred city and remote roles", () => {
    expect(scoreLocation({ location: ["Bangalore"], workMode: "hybrid" }, cand).points).toBe(10);
    expect(scoreLocation({ location: ["Remote - India"], workMode: "remote" }, cand).points).toBe(10);
  });

  it("matches NCR cities as one region", () => {
    const ncr = { ...cand, preferredLocations: ["Gurgaon"] };
    expect(scoreLocation({ location: ["Noida"], workMode: "onsite" }, ncr).fit.fit).toBe("good");
  });

  it("penalises a location conflict unless open to relocation", () => {
    const conflict = scoreLocation({ location: ["Chennai"], workMode: "onsite" }, cand);
    expect(conflict.fit.fit).toBe("poor");
    expect(conflict.penalty).toBe(PENALTIES.locationConflict);
    const relocate = scoreLocation({ location: ["Chennai"], workMode: "onsite" }, { ...cand, openToRelocation: true });
    expect(relocate.fit.fit).toBe("partial");
    expect(relocate.penalty).toBe(0);
  });

  it("scores work-mode mismatch", () => {
    const remoteOnly = { ...cand, workModePreference: "remote" as const };
    expect(scoreLocation({ location: ["Bengaluru"], workMode: "onsite" }, remoteOnly).points).toBe(6);
    expect(scoreLocation({ location: ["Bengaluru"], workMode: "hybrid" }, remoteOnly).points).toBe(7);
  });
});
