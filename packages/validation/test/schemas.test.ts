import { describe, expect, it } from "vitest";
import {
  accountDeleteSchema,
  applicationUpdateSchema,
  batchPrepareSchema,
  browserImportSchema,
  emailSendSchema,
  jobListQuerySchema,
  manualJobSchema,
  markSubmittedSchema,
  profileUpdateSchema,
  questionnaireAnswersSchema,
  signUpSchema,
} from "../src";

describe("auth & account schemas", () => {
  it("enforces strong passwords and terms acceptance", () => {
    expect(signUpSchema.safeParse({ name: "A", email: "A@Example.test", password: "Password123", acceptTerms: true }).data?.email).toBe("a@example.test");
    expect(signUpSchema.safeParse({ name: "A", email: "a@example.test", password: "short", acceptTerms: true }).success).toBe(false);
    expect(signUpSchema.safeParse({ name: "A", email: "a@example.test", password: "Password123", acceptTerms: false }).success).toBe(false);
  });
  it("requires typing DELETE", () => {
    expect(accountDeleteSchema.safeParse({ confirmText: "DELETE" }).success).toBe(true);
    expect(accountDeleteSchema.safeParse({ confirmText: "delete" }).success).toBe(false);
  });
});

describe("profile schema", () => {
  it("normalises optional URLs/emails and validates salary ordering", () => {
    const ok = profileUpdateSchema.parse({ githubUrl: "", email: "X@Y.test", expectedSalaryMin: 1, expectedSalaryMax: 2 });
    expect(ok.githubUrl).toBeNull();
    expect(ok.email).toBe("x@y.test");
    expect(profileUpdateSchema.safeParse({ expectedSalaryMin: 5, expectedSalaryMax: 2 }).success).toBe(false);
    expect(profileUpdateSchema.safeParse({ portfolioUrl: "javascript:alert(1)" }).success).toBe(false);
    expect(profileUpdateSchema.safeParse({ workModePreference: "sometimes" }).success).toBe(false);
  });
});

describe("job schemas", () => {
  it("validates manual and career-page imports", () => {
    const m = manualJobSchema.parse({ description: "A reasonably long job description.", requiredSkills: "React, TypeScript" });
    expect(m.requiredSkills).toEqual(["React", "TypeScript"]);
    expect(manualJobSchema.safeParse({ mode: "career_page_url", description: "A reasonably long job description." }).success).toBe(false);
    expect(manualJobSchema.safeParse({ description: "short" }).success).toBe(false);
  });
  it("browser imports require explicit user confirmation", () => {
    const base = { pageUrl: "https://jobs.example/1", title: "Engineer", description: "A reasonably long job description." };
    expect(browserImportSchema.safeParse(base).success).toBe(false);
    expect(browserImportSchema.safeParse({ ...base, userConfirmed: true }).success).toBe(true);
    expect(browserImportSchema.safeParse({ ...base, pageUrl: "file:///etc/passwd", userConfirmed: true }).success).toBe(false);
  });
  it("parses list query strings and caps batch preparation at 10", () => {
    const q = jobListQuerySchema.parse({ platform: "NAUKRI,LEVER", minScore: "60", savedOnly: "true" });
    expect(q.platform).toEqual(["NAUKRI", "LEVER"]);
    expect(q.minScore).toBe(60);
    expect(q.savedOnly).toBe(true);
    expect(batchPrepareSchema.safeParse({ jobIds: Array.from({ length: 11 }, (_, i) => `j${i}`) }).success).toBe(false);
    expect(batchPrepareSchema.safeParse({ jobIds: ["a"] }).success).toBe(true);
  });
});

describe("application safety schemas", () => {
  it("email send needs token, explicit confirmation and consent", () => {
    const token = "t".repeat(40);
    expect(emailSendSchema.safeParse({ confirmationToken: token, userConfirmed: true, consentToSend: true }).success).toBe(true);
    expect(emailSendSchema.safeParse({ confirmationToken: token, userConfirmed: false, consentToSend: true }).success).toBe(false);
    expect(emailSendSchema.safeParse({ confirmationToken: token, userConfirmed: true }).success).toBe(false);
  });
  it("mark-submitted requires the user's own statement", () => {
    expect(markSubmittedSchema.safeParse({}).success).toBe(false);
    expect(markSubmittedSchema.safeParse({ submittedByUser: true }).success).toBe(true);
  });
  it("application updates are strict", () => {
    expect(applicationUpdateSchema.safeParse({ status: "INTERVIEW" }).success).toBe(true);
    expect(applicationUpdateSchema.safeParse({ approvedAt: "now" }).success).toBe(false);
  });
  it("questionnaire answers are bounded", () => {
    expect(questionnaireAnswersSchema.parse({ answers: { q1: { value: "no" } } }).complete).toBe(false);
    expect(questionnaireAnswersSchema.safeParse({ answers: { q1: { value: "x".repeat(81) } } }).success).toBe(false);
  });
});
