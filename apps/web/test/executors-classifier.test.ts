import { describe, expect, it } from "vitest";
import { classifyQuestion, questionKeyFor, type ProviderJobRef, type SubmissionPayload } from "@applywise/job-engine";
import { demoAtsAdapter } from "@/server/services/executors/browser/adapters";
import type { BrowserField, BrowserFile, BrowserSession } from "@/server/services/executors/browser/driver";
import { planField, runBrowserApplication } from "@/server/services/executors/browser/flow";

/**
 * Browser field mapping with the REAL question classifier (executors.test.ts uses a stand-in): a country-specific
 * work-authorisation field is only ever filled by an answer to that same question.
 */

const APP_URL = "http://localhost:3000";
const US_LABEL = "Are you legally authorized to work in the United States?";

const job: ProviderJobRef = {
  jobId: "job-1",
  platform: "GREENHOUSE",
  title: "Frontend Engineer",
  company: "Acme Test",
  applyMethod: "CAREER_PAGE",
  applyUrl: `${APP_URL}/demo/ats/greenhouse/acme-frontend`,
  sourceUrl: null,
  sourceExternalId: null,
  hrEmail: null,
  isDemo: true,
  feedProvider: null,
  sourceMetadata: {},
};

function payload(answers: SubmissionPayload["answers"]): SubmissionPayload {
  return {
    idempotencyKey: "user-1:canonical-1",
    job,
    applicant: {
      fullName: "Asha Rao",
      firstName: "Asha",
      lastName: "Rao",
      email: "asha@example.test",
      phone: null,
      location: null,
      linkedinUrl: null,
      githubUrl: null,
      portfolioUrl: null,
      currentCompany: null,
      currentTitle: null,
      yearsOfExperience: null,
    },
    resume: null,
    coverLetter: null,
    answers,
    credential: null,
  };
}

const usField: BrowserField = { index: 0, label: US_LABEL, name: "question_0", type: "select", required: true, options: ["Select...", "Yes", "No"] };

class OneFieldSession implements BrowserSession {
  readonly filled = new Map<number, string>();
  submitted = false;
  private url = "about:blank";
  async goto(url: string) {
    this.url = url;
  }
  currentUrl() {
    return this.url;
  }
  async detectChallenge() {
    return null;
  }
  async listFields() {
    return [usField];
  }
  async fill(index: number, value: string) {
    this.filled.set(index, value);
  }
  async upload(_index: number, _file: BrowserFile) {}
  async submit() {
    this.submitted = true;
  }
  async readConfirmation() {
    return this.submitted ? "Application received" : null;
  }
  async close() {}
}

describe("browser field mapping with the real classifier", () => {
  it("the US field is qualified by its country (precondition of the cases below)", () => {
    const q = classifyQuestion(US_LABEL, { required: true, origin: "provider" });
    expect(q.canonicalKey).toBe("work_authorization");
    expect(q.key).not.toBe("work_authorization");
  });

  it("an unqualified work-authorisation answer never fills a country-specific field", async () => {
    const answers = [{ key: "work_authorization", question: "Are you legally authorized to work?", answer: "Yes" }];
    expect(planField(usField, payload(answers))).toBeNull();
    const session = new OneFieldSession();
    const result = await runBrowserApplication(session, demoAtsAdapter, payload(answers), { dryRun: false, confirmationTimeoutMs: 1_000, env: { APP_URL } });
    expect(result).toEqual({ outcome: "NEEDS_INFORMATION", questions: [{ question: US_LABEL, required: true }] });
    expect(session.filled.size).toBe(0);
    expect(session.submitted).toBe(false);
  });

  it("the answer to exactly this question wins over an earlier unqualified one", () => {
    const answers = [
      { key: "work_authorization", question: "Are you legally authorized to work?", answer: "Yes" },
      { key: questionKeyFor(US_LABEL), question: US_LABEL, answer: "No" },
    ];
    expect(planField(usField, payload(answers))).toMatchObject({ kind: "fill", value: "No" });
  });
});
