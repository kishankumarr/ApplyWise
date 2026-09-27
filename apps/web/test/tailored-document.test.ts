import { describe, expect, it } from "vitest";
import type { TailoredResumePlan } from "@applywise/types";
import { buildTailoredDocument } from "@/server/services/application.service";

type Doc = Parameters<typeof buildTailoredDocument>[0];

const base = {
  contact: { fullName: "Test User", email: "t@example.test", phone: null, location: null, links: [] },
  headline: null,
  summary: "Original summary",
  experience: [
    { title: "Engineer", company: "One", location: null, startDate: null, endDate: null, bullets: ["A1", "A2", "A3"] },
    { title: "Engineer", company: "Two", location: null, startDate: null, endDate: null, bullets: ["B1"] },
  ],
  projects: [],
  skills: ["React"],
  education: [],
  achievements: [],
  sectionOrder: ["summary", "experience", "skills"],
} as unknown as Doc;

const change = (over: Record<string, unknown>) => ({
  experienceId: "e1",
  originalFactId: null,
  original: null,
  proposed: "",
  sourceFactIds: [],
  rationale: "",
  confidence: "high" as const,
  ...over,
});

describe("buildTailoredDocument", () => {
  it("rewrites accepted bullets in place and keeps every uncovered original bullet", () => {
    const plan = {
      summary: { text: "Tailored summary", sourceFactIds: [] },
      bulletChanges: [
        change({ originalFactId: "a2", original: "A2", proposed: "A2 rewritten" }),
        change({ originalFactId: "a3", original: "A3", proposed: "A3 rewritten" }),
        change({ proposed: "New grounded bullet" }),
      ],
      selectedSkills: [],
      sectionOrder: [],
      warnings: [],
    } as unknown as TailoredResumePlan;
    const edits = [
      { proposed: "A2 rewritten", accepted: true },
      { proposed: "A3 rewritten", accepted: false },
      { proposed: "New grounded bullet", accepted: true },
    ];
    const doc = buildTailoredDocument(base, plan, null, edits as never, ["e1", "e2"]);
    expect(doc.experience[0]!.bullets).toEqual(["A1", "A2 rewritten", "A3", "New grounded bullet"]);
    expect(doc.experience[1]!.bullets).toEqual(["B1"]);
    expect(doc.summary).toBe("Tailored summary");
  });
});
