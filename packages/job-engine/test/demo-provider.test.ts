import { describe, expect, it } from "vitest";
import { STATUS_EMAIL_MIN_CONFIDENCE, classifyStatusEmail } from "../src/automation/email-status";
import { DEMO_NOTICE } from "../src/connectors/seeded";
import { normalizeRawJob } from "../src/connectors/normalize";
import type { RawImportedJob } from "../src/connectors/types";
import { DEMO_JOBS } from "../src/demo/jobs";
import { normalizeLocation } from "../src/locations";
import {
  DEMO_AUTOMATION_JOB_COUNT,
  DEMO_SCENARIOS,
  DEMO_SINGAPORE_PERMIT_QUESTION,
  DEMO_SOURCES,
  applicationProviderForJob,
  demoAutomationJobBySlug,
  demoAutomationJobTier,
  demoCompanySlug,
  demoProvider,
  generateDemoAutomationJobs,
  providerInfos,
  sourceProviderIdForJob,
  type DemoScenario,
  type ProviderJobRef,
  type SubmissionPayload,
} from "../src/providers";

// ---------------------------------------------------------------- helpers

const APP_URL = "http://localhost:3000";
const NOW = new Date("2026-09-01T06:30:00.000Z");
const DAY = 86_400_000;
const jobs = generateDemoAutomationJobs({ appUrl: APP_URL, now: NOW });

const meta = (raw: RawImportedJob) =>
  raw.raw as { kind: string; demo: boolean; demoScenario: DemoScenario; demoChannel: "api" | "browser"; demoSource: string; key: string };

/** Mirrors jobMatchKey (packages/database/src/jobs.ts): normalised title + company without suffixes + primary city. */
function matchKey(raw: RawImportedJob): string {
  const norm = (v: string) => v.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
  const title = norm(raw.hints.title ?? "").replace(/\b(urgent|hiring|immediate joiner|wfh|remote)\b/g, " ").replace(/\s+/g, " ").trim();
  const company = norm(raw.hints.company ?? "")
    .replace(/\b(private|pvt|limited|ltd|llp|inc|incorporated|corp|corporation|co|company|technologies|technology|tech|solutions|software|labs|india|global)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const locations = Array.isArray(raw.hints.location) ? raw.hints.location : [];
  return `${title}|${company}|${locations[0] ? norm(normalizeLocation(locations[0])) : ""}`;
}

const originals = (() => {
  const seen = new Set<string>();
  return jobs.filter((j) => {
    const key = meta(j).key;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
})();

const byScenario = (scenario: DemoScenario, filter: (raw: RawImportedJob) => boolean = () => true) => {
  const raw = originals.find((j) => meta(j).demoScenario === scenario && filter(j));
  if (!raw) throw new Error(`no demo job with scenario ${scenario}`);
  return raw;
};

async function refFor(raw: RawImportedJob): Promise<ProviderJobRef> {
  const job = await normalizeRawJob(raw);
  return {
    jobId: `job_${meta(raw).key}`,
    platform: job.platform,
    title: job.title,
    company: job.company,
    applyMethod: job.applyMethod,
    applyUrl: job.applyUrl,
    sourceUrl: job.sourceUrl,
    sourceExternalId: job.sourceExternalId,
    hrEmail: job.hrEmail,
    isDemo: job.isDemo ?? false,
    feedProvider: "demo",
    sourceMetadata: raw.raw,
  };
}

let keyCounter = 0;
async function payloadFor(raw: RawImportedJob, overrides: Partial<SubmissionPayload> = {}): Promise<SubmissionPayload> {
  keyCounter += 1;
  return {
    idempotencyKey: `user_demo_test_${keyCounter}:${meta(raw).key}`,
    job: await refFor(raw),
    applicant: {
      fullName: "Aarav Mehta",
      firstName: "Aarav",
      lastName: "Mehta",
      email: "aarav.mehta@example.test",
      phone: null,
      location: "Bengaluru",
      linkedinUrl: null,
      githubUrl: null,
      portfolioUrl: null,
      currentCompany: null,
      currentTitle: null,
      yearsOfExperience: 5,
    },
    resume: null,
    coverLetter: null,
    answers: [],
    credential: { token: "demo-token" },
    ...overrides,
  };
}

const runtime = { env: {} };

// ---------------------------------------------------------------- generator

describe("generateDemoAutomationJobs", () => {
  it("returns at least 110 distinct jobs plus at least 12 cross-provider duplicates", () => {
    expect(DEMO_AUTOMATION_JOB_COUNT).toBeGreaterThanOrEqual(110);
    expect(originals.length).toBeGreaterThanOrEqual(110);
    const groups = new Map<string, RawImportedJob[]>();
    for (const j of jobs) groups.set(matchKey(j), [...(groups.get(matchKey(j)) ?? []), j]);
    // Distinct postings never collide on the merge key.
    expect(groups.size).toBe(originals.length);
    const duplicated = [...groups.values()].filter((g) => g.length > 1);
    expect(jobs.length - originals.length).toBeGreaterThanOrEqual(12);
    expect(duplicated.length).toBeGreaterThanOrEqual(12);
    for (const group of duplicated) {
      expect(new Set(group.map((j) => j.hints.title)).size).toBe(1);
      expect(new Set(group.map((j) => j.hints.company)).size).toBe(1);
      expect(new Set(group.map((j) => normalizeLocation((j.hints.location as string[])[0]!))).size).toBe(1);
      expect(new Set(group.map((j) => meta(j).demoSource)).size).toBe(group.length);
      expect(new Set(group.map((j) => j.provider)).size).toBe(group.length);
      expect(new Set(group.map((j) => j.externalId)).size).toBe(group.length);
      expect(new Set(group.map((j) => j.attribution)).size).toBe(group.length);
    }
    expect(new Set(jobs.map((j) => j.externalId)).size).toBe(jobs.length);
  });

  it("is deterministic for a fixed now", () => {
    expect(generateDemoAutomationJobs({ appUrl: APP_URL, now: NOW })).toEqual(jobs);
    const later = generateDemoAutomationJobs({ appUrl: APP_URL, now: new Date(NOW.getTime() + DAY) });
    expect(later.map((j) => j.text)).toEqual(jobs.map((j) => j.text));
    expect(later[0]!.hints.postedAt).not.toBe(jobs[0]!.hints.postedAt);
  });

  it("honours count and never exceeds the catalogue", () => {
    const few = generateDemoAutomationJobs({ appUrl: APP_URL, now: NOW, count: 5 });
    expect(new Set(few.map((j) => meta(j).key)).size).toBe(5);
    expect(generateDemoAutomationJobs({ appUrl: APP_URL, now: NOW, count: 10_000 })).toHaveLength(jobs.length);
    expect(generateDemoAutomationJobs({ appUrl: APP_URL, now: NOW, count: 0 })).toEqual([]);
  });

  it("labels every job as DEMO CONTENT with demo metadata", () => {
    const labels = new Set(Object.values(DEMO_SOURCES).map((s) => s.label));
    for (const j of jobs) {
      expect(j.text.startsWith(DEMO_NOTICE)).toBe(true);
      expect(j.importMethod).toBe("SEEDED_DEMO");
      expect(j.hints.isDemo).toBe(true);
      expect(j.attribution).toMatch(/\(demo\)$/);
      expect(labels.has(j.attribution)).toBe(true);
      const m = meta(j);
      expect(m.kind).toBe("demo_provider");
      expect(m.demo).toBe(true);
      expect(DEMO_SCENARIOS).toContain(m.demoScenario);
      expect(["api", "browser"]).toContain(m.demoChannel);
      expect(Object.keys(DEMO_SOURCES)).toContain(m.demoSource);
      expect(j.provider).toBe(DEMO_SOURCES[m.demoSource as keyof typeof DEMO_SOURCES].platform);
    }
    // Keys never collide with the seeded demo catalogue (the demo ATS page serves both).
    const seeded = new Set(DEMO_JOBS.map((s) => s.key));
    expect(originals.filter((j) => seeded.has(meta(j).key))).toEqual([]);
  });

  it("only links to reserved .example / .test hosts or the app itself", () => {
    const allowedUrl = (u: string) => u.startsWith(`${APP_URL}/demo/ats/`) || /^https:\/\/([a-z0-9-]+\.)+example(\/|$)/.test(u);
    for (const j of jobs) {
      for (const u of [j.sourceUrl, j.hints.applyUrl, j.hints.companyWebsite].filter((x): x is string => !!x)) expect(allowedUrl(u), u).toBe(true);
      for (const u of j.text.match(/https?:\/\/[^\s"'<>]+/g) ?? []) expect(allowedUrl(u.replace(/[.,;)]+$/, "")), u).toBe(true);
      for (const e of j.text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? []) expect(e).toMatch(/\.test$/);
      if (j.hints.hrEmail) expect(j.hints.hrEmail).toMatch(/^hiring@[a-z0-9-]+\.test$/);
    }
  });

  it("uses the browser channel for exactly two high matches and career-site URLs for the rest", () => {
    const browser = originals.filter((j) => meta(j).demoChannel === "browser");
    expect(browser.map((j) => meta(j).demoScenario).sort()).toEqual(["auto_success", "captcha"]);
    for (const j of browser) {
      expect(demoAutomationJobTier(meta(j).key)).toBe("high");
      expect(j.hints.applyUrl).toBe(`${APP_URL}/demo/ats/greenhouse/${meta(j).key}`);
    }
    for (const j of originals.filter((o) => meta(o).demoChannel === "api")) {
      expect(j.hints.applyUrl).toMatch(new RegExp(`^https://careers\\.${demoCompanySlug(j.hints.company!)}\\.example/jobs/\\d+$`));
    }
    const trailing = generateDemoAutomationJobs({ appUrl: `${APP_URL}/`, now: NOW, count: 1 });
    expect(trailing[0]!.hints.applyUrl).toBe(`${APP_URL}/demo/ats/greenhouse/${meta(trailing[0]!).key}`);
  });

  it("covers every scenario, with the scripted mix among high matches", () => {
    expect(new Set(originals.map((j) => meta(j).demoScenario))).toEqual(new Set(DEMO_SCENARIOS));
    const high = originals.filter((j) => demoAutomationJobTier(meta(j).key) === "high");
    expect(high.length).toBeGreaterThanOrEqual(18);
    const count = (s: DemoScenario) => high.filter((j) => meta(j).demoScenario === s).length;
    expect(count("auto_success")).toBeGreaterThanOrEqual(6);
    expect(count("transient_failure")).toBe(1);
    expect(count("permanent_failure")).toBe(1);
    expect(count("captcha")).toBe(1);
    expect(count("login_required")).toBe(1);
    expect(count("mfa")).toBe(1);
    expect(count("unknown_question")).toBe(2);
    expect(count("assessment")).toBe(1);
    expect(count("interview")).toBe(2);
    expect(count("rejection")).toBe(2);
    expect(count("offer")).toBe(1);
    expect(count("manual_only")).toBe(2);
    expect(high.filter((j) => meta(j).demoScenario === "manual_only").map((j) => meta(j).demoSource).sort()).toEqual(["linkedin", "naukri"]);
    // Medium and low matches: manual_only exactly when the simulated source is LinkedIn or Naukri.
    for (const j of originals.filter((o) => demoAutomationJobTier(meta(o).key) !== "high")) {
      const manual = meta(j).demoSource === "linkedin" || meta(j).demoSource === "naukri";
      expect(meta(j).demoScenario).toBe(manual ? "manual_only" : "auto_success");
    }
    expect(originals.filter((j) => demoAutomationJobTier(meta(j).key) === "medium").length).toBeGreaterThanOrEqual(25);
    expect(originals.filter((j) => demoAutomationJobTier(meta(j).key) === "low").length).toBeGreaterThanOrEqual(55);
  });

  it("spreads posting dates over 45 days and carries salaries, HR emails and screening questions", async () => {
    const ages = originals.map((j) => (NOW.getTime() - Date.parse(j.hints.postedAt!)) / DAY);
    expect(Math.min(...ages)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...ages)).toBeLessThan(46);
    expect(ages.filter((a) => a > 14).length).toBeGreaterThanOrEqual(10);
    // High matches are recent enough for the default 14-day age rule.
    for (const j of originals.filter((o) => demoAutomationJobTier(meta(o).key) === "high")) {
      expect((NOW.getTime() - Date.parse(j.hints.postedAt!)) / DAY).toBeLessThan(14);
    }
    expect(originals.filter((j) => j.hints.salaryMin && j.hints.currency === "INR").length).toBeGreaterThanOrEqual(50);
    const normalized = await Promise.all(originals.map((j) => normalizeRawJob(j)));
    const email = normalized.filter((j) => j.applyMethod === "EMAIL");
    expect(email.length).toBeGreaterThanOrEqual(3);
    for (const j of email) expect(j.hrEmail).toMatch(/\.test$/);
    expect(normalized.filter((j) => j.screeningQuestions.length > 0).length).toBeGreaterThanOrEqual(10);
    for (const j of normalized) {
      expect(j.isDemo).toBe(true);
      expect(j.location.length).toBeGreaterThan(0);
      expect(j.workMode).not.toBe("unknown");
      expect(j.requiredSkills.length).toBeGreaterThan(0);
      expect(j.experienceMinYears).not.toBeNull();
    }
  });
});

// ---------------------------------------------------------------- demo ATS page

describe("demoAutomationJobBySlug", () => {
  it("serves the browser-channel jobs with their page variant", () => {
    const standard = byScenario("auto_success", (j) => meta(j).demoChannel === "browser");
    const page = demoAutomationJobBySlug(meta(standard).key, { appUrl: APP_URL });
    expect(page).toMatchObject({ title: standard.hints.title, company: standard.hints.company, variant: "standard", applyUrl: standard.hints.applyUrl });
    expect(page!.locations).toEqual(standard.hints.location);
    expect(page!.screening).toContain("Are you authorised to work in India?");
    expect(page!.screening).not.toContain("What is your notice period?");
    expect(demoAutomationJobBySlug(meta(byScenario("captcha")).key, { appUrl: APP_URL })?.variant).toBe("captcha");
    expect(demoAutomationJobBySlug(meta(byScenario("login_required")).key, { appUrl: APP_URL })?.variant).toBe("login");
    expect(demoAutomationJobBySlug(meta(byScenario("mfa")).key, { appUrl: APP_URL })?.variant).toBe("login");
    expect(demoAutomationJobBySlug(meta(byScenario("unknown_question")).key, { appUrl: APP_URL })?.screening).toContain(DEMO_SINGAPORE_PERMIT_QUESTION);
    expect(demoAutomationJobBySlug("no-such-job", { appUrl: APP_URL })).toBeNull();
    expect(demoAutomationJobBySlug("framecraft-senior-frontend", { appUrl: APP_URL })).toBeNull();
  });
});

// ---------------------------------------------------------------- provider

describe("demoProvider", () => {
  it("is the application provider and the source for demo jobs", async () => {
    const ref = await refFor(byScenario("auto_success"));
    expect(applicationProviderForJob(ref)).toBe(demoProvider);
    expect(demoProvider.matchesJob(ref)).toBe(true);
    expect(sourceProviderIdForJob(ref)).toBe("demo");
    expect(demoProvider.matchesJob({ ...ref, isDemo: false })).toBe(false);
    expect(demoProvider.info({}).id).toBe("demo");
    expect(providerInfos({}).find((p) => p.id === "demo")).toEqual(demoProvider.info({}));
  });

  it("discovers the demo catalogue only when enabled", async () => {
    const found = await demoProvider.discover!({ config: {}, runtime: { env: { APP_URL: "https://app.applywise.example" }, now: NOW } });
    expect(found).toEqual(generateDemoAutomationJobs({ appUrl: "https://app.applywise.example", now: NOW }));
    const configured = await demoProvider.discover!({ config: { appUrl: "http://127.0.0.1:4000" }, runtime: { env: {}, now: NOW } });
    expect(configured.some((j) => j.hints.applyUrl?.startsWith("http://127.0.0.1:4000/demo/ats/"))).toBe(true);
    await expect(demoProvider.discover!({ config: {}, runtime: { env: { NODE_ENV: "production" } } })).rejects.toThrow(/disabled/);
  });

  it("asks the required screening questions, plus the Singapore permit for unknown_question", async () => {
    const standard = await demoProvider.getApplicationRequirements!(await refFor(byScenario("auto_success")), runtime);
    expect(standard.questions.map((q) => [q.question, q.required])).toEqual([
      ["What is your notice period?", true],
      ["Are you authorised to work in India?", true],
    ]);
    const unknown = await demoProvider.getApplicationRequirements!(await refFor(byScenario("unknown_question")), runtime);
    expect(unknown.questions.map((q) => q.question)).toContain(DEMO_SINGAPORE_PERMIT_QUESTION);
    expect(unknown.questions.every((q) => q.required)).toBe(true);
  });

  it("supports applications per scenario and channel", async () => {
    expect(demoProvider.supportsApplication!(await refFor(byScenario("manual_only")), {})).toEqual({
      supported: false,
      channel: "manual",
      reason: "PROVIDER_RESTRICTION",
      detail: "(demo) This simulated platform does not allow automated applications.",
    });
    expect(demoProvider.supportsApplication!(await refFor(byScenario("captcha")), {})).toMatchObject({ supported: true, channel: "browser" });
    expect(demoProvider.supportsApplication!(await refFor(byScenario("auto_success", (j) => meta(j).demoChannel === "api")), {})).toMatchObject({ supported: true, channel: "api" });
    expect(demoProvider.supportsApplication!(await refFor(byScenario("auto_success")), { NODE_ENV: "production" })).toMatchObject({ supported: false });
  });

  it("rejects missing, foreign and expired connection tokens", async () => {
    const raw = byScenario("auto_success");
    for (const credential of [null, { token: "" }, { token: "live-token" }, { token: "demo-expired" }]) {
      const result = await demoProvider.submitApplication!(await payloadFor(raw, { credential }), runtime);
      expect(result.outcome).toBe("AUTH_FAILED");
    }
  });

  it("submits idempotently: the same key returns the same confirmation", async () => {
    const raw = byScenario("auto_success");
    const payload = await payloadFor(raw);
    const first = await demoProvider.submitApplication!(payload, runtime);
    expect(first).toMatchObject({ outcome: "SUBMITTED" });
    expect(first.outcome === "SUBMITTED" && first.confirmation).toMatch(/^DEMO-[0-9A-F]{8}$/);
    expect(await demoProvider.submitApplication!(payload, runtime)).toEqual(first);
    expect(await demoProvider.submitApplication!({ ...payload, answers: [{ key: "x", question: "y", answer: "z" }] }, runtime)).toEqual(first);
    const other = await demoProvider.submitApplication!(await payloadFor(raw), runtime);
    expect(other.outcome === "SUBMITTED" && other.confirmation).not.toBe(first.outcome === "SUBMITTED" && first.confirmation);
  });

  it("fails a transient_failure job once per key, then succeeds", async () => {
    const payload = await payloadFor(byScenario("transient_failure"));
    expect(await demoProvider.submitApplication!(payload, runtime)).toMatchObject({ outcome: "FAILED", retryable: true, submissionUncertain: false });
    const retry = await demoProvider.submitApplication!(payload, runtime);
    expect(retry).toMatchObject({ outcome: "SUBMITTED" });
    expect(await demoProvider.submitApplication!(payload, runtime)).toEqual(retry);
    // Another key starts over with its own first failure.
    expect(await demoProvider.submitApplication!(await payloadFor(byScenario("transient_failure")), runtime)).toMatchObject({ outcome: "FAILED" });
  });

  it("scripts permanent failures, manual challenges and platform restrictions", async () => {
    expect(await demoProvider.submitApplication!(await payloadFor(byScenario("permanent_failure")), runtime)).toEqual({
      outcome: "FAILED",
      retryable: false,
      error: "(demo) This posting has closed",
      submissionUncertain: false,
    });
    expect(await demoProvider.submitApplication!(await payloadFor(byScenario("captcha")), runtime)).toMatchObject({ outcome: "MANUAL_ACTION_REQUIRED", reason: "CAPTCHA" });
    expect(await demoProvider.submitApplication!(await payloadFor(byScenario("login_required")), runtime)).toMatchObject({ outcome: "MANUAL_ACTION_REQUIRED", reason: "LOGIN_REQUIRED" });
    expect(await demoProvider.submitApplication!(await payloadFor(byScenario("mfa")), runtime)).toMatchObject({ outcome: "MANUAL_ACTION_REQUIRED", reason: "MFA" });
    expect(await demoProvider.submitApplication!(await payloadFor(byScenario("manual_only")), runtime)).toMatchObject({ outcome: "MANUAL_ACTION_REQUIRED", reason: "PROVIDER_RESTRICTION" });
  });

  it("needs the Singapore work-permit answer for unknown_question jobs", async () => {
    const raw = byScenario("unknown_question");
    const missing = await demoProvider.submitApplication!(await payloadFor(raw), runtime);
    expect(missing).toEqual({ outcome: "NEEDS_INFORMATION", questions: [{ question: DEMO_SINGAPORE_PERMIT_QUESTION, required: true }] });
    const blank = await demoProvider.submitApplication!(await payloadFor(raw, { answers: [{ key: "custom:sg", question: DEMO_SINGAPORE_PERMIT_QUESTION, answer: " " }] }), runtime);
    expect(blank.outcome).toBe("NEEDS_INFORMATION");
    const answered = await demoProvider.submitApplication!(
      await payloadFor(raw, { answers: [{ key: "custom:sg", question: "Do you hold a valid work permit for Singapore", answer: "No" }] }),
      runtime,
    );
    expect(answered.outcome).toBe("SUBMITTED");
  });

  it("falls back to a platform-based scenario for seeded demo jobs", async () => {
    const seeded = (platform: ProviderJobRef["platform"]): ProviderJobRef => ({
      jobId: "job_seeded",
      platform,
      title: "React Developer",
      company: "ClipStack Media",
      applyMethod: "PLATFORM",
      applyUrl: "https://demo-naukri.example/job-listings/1",
      sourceUrl: null,
      sourceExternalId: "demo-clipstack-react-dev",
      hrEmail: null,
      isDemo: true,
      feedProvider: null,
      sourceMetadata: { kind: "seeded_demo", key: "clipstack-react-dev", demo: true },
    });
    expect(applicationProviderForJob(seeded("NAUKRI")).id).toBe("demo");
    expect(demoProvider.supportsApplication!(seeded("NAUKRI"), {})).toMatchObject({ supported: false, reason: "PROVIDER_RESTRICTION" });
    expect(demoProvider.supportsApplication!(seeded("GREENHOUSE"), {})).toMatchObject({ supported: true, channel: "api" });
  });

  it("reports scripted outcomes with recruiter messages for the email classifier", async () => {
    const appliedAt = new Date(NOW.getTime() - 5 * DAY);
    const check = async (scenario: DemoScenario) => {
      const ref = await refFor(byScenario(scenario));
      return { ref, result: await demoProvider.checkApplicationStatus!({ externalApplicationId: "demo-app-1", job: ref, appliedAt }, { env: {}, now: NOW }) };
    };
    const expectations: [DemoScenario, string, (title: string) => string, RegExp][] = [
      ["assessment", "ASSESSMENT", (t) => `Online assessment for ${t}`, /assessment/],
      ["interview", "INTERVIEW", (t) => `Interview invitation - ${t}`, /interview/],
      ["rejection", "REJECTED", (t) => `Update on your application for ${t}`, /we will not be moving forward/],
      ["offer", "OFFER", (t) => `Offer letter - ${t}`, /offer/],
      ["auto_success", "UNDER_REVIEW", (t) => `We received your application for ${t}`, /We received your application for/],
    ];
    for (const [scenario, status, subject, body] of expectations) {
      const { ref, result } = await check(scenario);
      expect(result.status).toBe(status);
      expect(result.message).not.toBeNull();
      expect(result.message!.subject).toBe(subject(ref.title));
      expect(result.message!.text).toMatch(body);
      expect(result.message!.text).toContain(ref.title);
      expect(result.message!.from).toBe(`talent@${demoCompanySlug(ref.company)}.example`);
      const at = Date.parse(result.message!.receivedAt);
      expect(at).toBeGreaterThanOrEqual(appliedAt.getTime());
      expect(at).toBeLessThanOrEqual(NOW.getTime());
    }
    expect((await check("auto_success")).result.message!.category).toBe("APPLICATION_CONFIRMATION");
    expect((await check("rejection")).result.message!.category).toBe("REJECTION");
  });

  it("words every simulated message so the status-email classifier is confident about it", async () => {
    const appliedAt = new Date(NOW.getTime() - 3 * DAY);
    for (const raw of originals.filter((j) => ["assessment", "interview", "rejection", "offer", "auto_success"].includes(meta(j).demoScenario))) {
      const result = await demoProvider.checkApplicationStatus!({ externalApplicationId: "demo-app-1", job: await refFor(raw), appliedAt }, { env: {}, now: NOW });
      const classified = classifyStatusEmail(result.message!);
      expect(classified.category, meta(raw).key).toBe(result.message!.category);
      expect(classified.confidence, meta(raw).key).toBeGreaterThanOrEqual(STATUS_EMAIL_MIN_CONFIDENCE);
    }
  });
});
