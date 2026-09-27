import { describe, expect, it } from "vitest";
import { classifyQuestion, questionKeyFor } from "../src/automation/questions";

describe("work authorisation keys never take a non-country phrase as the country", () => {
  const generic = [
    "Are you legally authorized to work in the Country where this role is based?",
    "Are you legally authorized to work for Acme Corp in the country where this job is located?",
    "Are you authorised to work in This Country?",
    "Do you require sponsorship to work in the Hiring Country?",
  ];

  it("uses the job's country for questions that name no real country", () => {
    for (const q of generic) {
      const c = classifyQuestion(q, { jobCountry: "india" });
      expect(["work_authorization", "visa_sponsorship"]).toContain(c.canonicalKey);
      expect(c.key).toBe(`${c.canonicalKey}:india`);
    }
  });

  it("leaves them unqualified (never reused across jobs) when the job's country is unknown", () => {
    for (const q of generic) {
      const key = questionKeyFor(q);
      expect(key === "work_authorization" || key === "visa_sponsorship").toBe(true);
    }
  });

  it("still recognises real countries and cities", () => {
    expect(questionKeyFor("Are you authorised to work in India?")).toBe(questionKeyFor("Are you authorised to work in Pune?"));
    expect(questionKeyFor("Are you authorized to work in the United States?", { jobCountry: "india" })).not.toBe(questionKeyFor("Are you authorised to work in India?"));
  });
});
