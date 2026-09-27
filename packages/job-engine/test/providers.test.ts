import { describe, expect, it } from "vitest";
import { CAPABILITY_STATUSES, type JobPlatform } from "@applywise/types";
import { FeedProviderError } from "../src/feeds/types";
import {
  JOB_PROVIDER_IDS,
  applicationProviderForJob,
  atsProviderIdForUrl,
  getProvider,
  greenhouseQuestionsFromPosting,
  jobBoardProviderIdForUrl,
  listProviders,
  parseGreenhouseExternalId,
  parseGreenhousePostingUrl,
  providerInfos,
  sourceProviderIdForJob,
  type GreenhousePosting,
  type JobProvider,
  type ProviderEnv,
  type ProviderJobRef,
} from "../src/providers";

// ---------------------------------------------------------------- helpers

const provider = (id: string): JobProvider => {
  const p = getProvider(id);
  if (!p) throw new Error(`missing provider ${id}`);
  return p;
};

const info = (id: string, env: ProviderEnv) => {
  const found = providerInfos(env).find((p) => p.id === id);
  if (!found) throw new Error(`missing info ${id}`);
  return found;
};

function jobRef(overrides: Partial<ProviderJobRef> = {}): ProviderJobRef {
  return {
    jobId: "job_1",
    platform: "OTHER",
    title: "Frontend Engineer",
    company: "Acme",
    applyMethod: "CAREER_PAGE",
    applyUrl: null,
    sourceUrl: null,
    sourceExternalId: null,
    hrEmail: null,
    isDemo: false,
    feedProvider: null,
    sourceMetadata: {},
    ...overrides,
  };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const JOB_BOARDS = ["linkedin", "indeed", "naukri", "foundit", "wellfound", "instahyre", "glassdoor", "cutshort", "hirist"];

/** Environments from nothing configured to everything an operator could turn on. */
const ENVS: Record<string, ProviderEnv> = {
  empty: {},
  production: { NODE_ENV: "production" },
  development: { NODE_ENV: "development", EMAIL_PROVIDER: "dev" },
  everything: {
    NODE_ENV: "production",
    DEMO_PROVIDER_ENABLED: "true",
    BROWSER_EXECUTOR_ENABLED: "true",
    BROWSER_EXECUTOR_PROVIDERS: "demo,greenhouse,lever,ashby,workday,linkedin,smartrecruiters",
    EMAIL_PROVIDER: "resend",
    RESEND_API_KEY: "re_test",
    ADZUNA_APP_ID: "id",
    ADZUNA_APP_KEY: "key",
  },
};

// ---------------------------------------------------------------- registry

describe("provider registry", () => {
  it("registers exactly one provider per id", () => {
    expect(listProviders().map((p) => p.id)).toEqual([...JOB_PROVIDER_IDS]);
    expect(JOB_PROVIDER_IDS).toHaveLength(24);
    for (const id of JOB_PROVIDER_IDS) expect(getProvider(id)?.id).toBe(id);
    expect(getProvider("myspace")).toBeNull();
    expect(providerInfos({}).map((p) => p.id)).toEqual([...JOB_PROVIDER_IDS]);
  });

  it("reports well-formed, browser-safe capability metadata in every environment", () => {
    for (const env of Object.values(ENVS)) {
      for (const p of providerInfos(env)) {
        expect(JSON.parse(JSON.stringify(p))).toEqual(p);
        for (const c of Object.values(p.capabilities)) {
          expect(CAPABILITY_STATUSES).toContain(c.status);
          expect(c.note.length).toBeGreaterThan(10);
        }
        const submits = p.capabilities.AUTO_APPLY.status === "SUPPORTED" || p.capabilities.AUTO_APPLY.status === "EXPERIMENTAL";
        expect(p.manualOnly).toBe(!submits);
        expect(p.demo).toBe(p.id === "demo");
        expect(p.label).toBeTruthy();
      }
    }
  });

  it("never claims automatic submission for anything but the demo provider and configured email applications", () => {
    for (const env of Object.values(ENVS)) {
      const supported = providerInfos(env).filter((p) => p.capabilities.AUTO_APPLY.status === "SUPPORTED").map((p) => p.id);
      expect(supported.every((id) => id === "demo" || id === "email_application")).toBe(true);
      const experimental = providerInfos(env).filter((p) => p.capabilities.AUTO_APPLY.status === "EXPERIMENTAL").map((p) => p.id);
      expect(experimental.every((id) => ["greenhouse", "lever", "ashby"].includes(id))).toBe(true);
    }
    expect(info("email_application", ENVS.empty!).capabilities.AUTO_APPLY.status).not.toBe("SUPPORTED");
  });

  it("job boards: alert-only discovery, applications limited by the platform", () => {
    for (const env of Object.values(ENVS)) {
      for (const id of JOB_BOARDS) {
        const p = info(id, env);
        expect(p.kind).toBe("job_board");
        expect(p.capabilities.DISCOVERY.status).toBe("LIMITED");
        expect(p.capabilities.DISCOVERY.via).toBe("job-alert emails");
        expect(p.capabilities.AUTO_APPLY.status).toBe("EXTERNAL_LIMITATION");
        expect(p.auth).toBe("not_supported");
        expect(p.manualOnly).toBe(true);
        expect(p.externalRequirements.length).toBeGreaterThan(0);
      }
    }
    expect(info("linkedin", {}).capabilities.AUTO_APPLY.note).toMatch(/User Agreement/);
    expect(info("indeed", {}).capabilities.AUTO_APPLY.note).toMatch(/partner/);
    expect(info("naukri", {}).externalRequirements.join(" ")).toMatch(/partner/i);
  });

  it("Greenhouse, Lever and Ashby are EXPERIMENTAL only behind the browser-executor opt-in", () => {
    for (const id of ["greenhouse", "lever", "ashby"]) {
      const off = info(id, {});
      expect(off.capabilities.DISCOVERY.status).toBe("AVAILABLE");
      expect(off.capabilities.AUTO_APPLY.status).toBe("REQUIRES_EXTERNAL_CONFIGURATION");
      expect(off.manualOnly).toBe(true);
      expect(off.externalRequirements.join(" ")).toMatch(/BROWSER_EXECUTOR_ENABLED/);
      // Listed but the executor is off / enabled but not listed.
      expect(info(id, { BROWSER_EXECUTOR_ENABLED: "false", BROWSER_EXECUTOR_PROVIDERS: id }).capabilities.AUTO_APPLY.status).toBe("REQUIRES_EXTERNAL_CONFIGURATION");
      expect(info(id, { BROWSER_EXECUTOR_ENABLED: "true" }).capabilities.AUTO_APPLY.status).toBe("REQUIRES_EXTERNAL_CONFIGURATION");
      expect(info(id, { BROWSER_EXECUTOR_ENABLED: "true", BROWSER_EXECUTOR_PROVIDERS: "demo" }).capabilities.AUTO_APPLY.status).toBe("REQUIRES_EXTERNAL_CONFIGURATION");
      const on = info(id, { BROWSER_EXECUTOR_ENABLED: "true", BROWSER_EXECUTOR_PROVIDERS: ` demo , ${id.toUpperCase()} ` });
      expect(on.capabilities.AUTO_APPLY.status).toBe("EXPERIMENTAL");
      expect(on.capabilities.AUTO_APPLY.via).toMatch(/browser/);
      expect(on.manualOnly).toBe(false);
    }
    // Only the listed provider is opted in.
    const env = { BROWSER_EXECUTOR_ENABLED: "true", BROWSER_EXECUTOR_PROVIDERS: "greenhouse" };
    expect(info("greenhouse", env).capabilities.AUTO_APPLY.status).toBe("EXPERIMENTAL");
    expect(info("lever", env).capabilities.AUTO_APPLY.status).toBe("REQUIRES_EXTERNAL_CONFIGURATION");
    expect(info("greenhouse", {}).capabilities.QUESTION_EXTRACTION.status).toBe("AVAILABLE");
    expect(info("lever", {}).capabilities.QUESTION_EXTRACTION.status).toBe("NOT_SUPPORTED");
  });

  it("other ATS boards, Workday and career sites hand applications to the user", () => {
    for (const id of ["smartrecruiters", "workable", "recruitee"]) {
      const p = info(id, ENVS.everything!);
      expect(p.capabilities.DISCOVERY.status).toBe("AVAILABLE");
      expect(p.capabilities.AUTO_APPLY.status).toBe("REQUIRES_EXTERNAL_CONFIGURATION");
    }
    const workday = info("workday", ENVS.everything!);
    expect(workday.capabilities.DISCOVERY.status).toBe("NOT_SUPPORTED");
    expect(workday.capabilities.AUTO_APPLY.status).toBe("EXTERNAL_LIMITATION");
    const career = info("career_site", {});
    expect(career.capabilities.DISCOVERY.status).toBe("LIMITED");
    expect(career.capabilities.AUTO_APPLY.status).toBe("MANUAL");
    const alerts = info("job_alert_email", {});
    expect(alerts.capabilities.DISCOVERY.status).toBe("AVAILABLE");
    // Connected mailboxes read job-alert senders only; employer emails are tracked when forwarded.
    expect(alerts.capabilities.STATUS_TRACKING.status).toBe("LIMITED");
    expect(alerts.capabilities.STATUS_TRACKING.note).toMatch(/forward/i);
    expect(alerts.capabilities.AUTO_APPLY.status).toBe("NOT_SUPPORTED");
  });

  it("never claims that connected mailboxes track employer emails (only forwarding and provider status sync do)", () => {
    for (const env of Object.values(ENVS)) {
      for (const id of JOB_PROVIDER_IDS) {
        const tracking = info(id, env).capabilities.STATUS_TRACKING;
        const text = `${tracking.via ?? ""} ${tracking.note}`;
        expect(tracking.via ?? "", id).not.toMatch(/connected mailbox/i);
        expect(text, id).not.toMatch(/(?:read|tracked|update)[^.]*\b(?:in|from) (?:a|your) connected mailbox|connected mailbox (?:update|track)/i);
        if (id !== "demo") expect(tracking.status, id).not.toBe("AVAILABLE");
        if (tracking.status === "LIMITED") expect(tracking.note, id).toMatch(/forward/i);
      }
    }
  });

  it("search APIs are NOT_CONFIGURED until the operator key is set, and always apply manually", () => {
    const adzuna = info("adzuna", {});
    expect(adzuna.capabilities.DISCOVERY.status).toBe("NOT_CONFIGURED");
    expect(adzuna.externalRequirements.join(" ")).toMatch(/ADZUNA_APP_ID/);
    const keyed = info("adzuna", { ADZUNA_APP_ID: "id", ADZUNA_APP_KEY: "key" });
    expect(keyed.capabilities.DISCOVERY.status).toBe("AVAILABLE");
    expect(keyed.capabilities.DETAIL_FETCH.status).toBe("LIMITED");
    expect(keyed.externalRequirements).toEqual([]);
    for (const id of ["himalayas", "jobicy", "themuse"]) {
      expect(info(id, {}).capabilities.DISCOVERY.status).toBe("AVAILABLE");
      expect(info(id, {}).capabilities.AUTO_APPLY.status).toBe("MANUAL");
    }
    expect(keyed.capabilities.AUTO_APPLY.status).toBe("MANUAL");
    expect(keyed.notes.join(" ")).toMatch(/Jobs by Adzuna/);
  });

  it("email applications are SUPPORTED only with a delivering email provider", () => {
    const dev = info("email_application", { EMAIL_PROVIDER: "dev" });
    expect(dev.capabilities.AUTO_APPLY.status).toBe("LIMITED");
    expect(dev.capabilities.AUTO_APPLY.note).toMatch(/outbox/i);
    expect(dev.manualOnly).toBe(true);
    expect(info("email_application", {}).capabilities.AUTO_APPLY.status).toBe("LIMITED");
    // The email adapter falls back to the dev outbox without SMTP_HOST / RESEND_API_KEY.
    expect(info("email_application", { EMAIL_PROVIDER: "smtp" }).capabilities.AUTO_APPLY.status).toBe("LIMITED");
    expect(info("email_application", { EMAIL_PROVIDER: "resend" }).capabilities.AUTO_APPLY.status).toBe("LIMITED");
    const smtp = info("email_application", { EMAIL_PROVIDER: "smtp", SMTP_HOST: "localhost" });
    expect(smtp.capabilities.AUTO_APPLY.status).toBe("SUPPORTED");
    expect(smtp.notes.join(" ")).toMatch(/SMTP_DELIVERS_EXTERNALLY/);
    expect(smtp.manualOnly).toBe(false);
    const resend = info("email_application", { EMAIL_PROVIDER: "resend", RESEND_API_KEY: "re_x" });
    expect(resend.capabilities.AUTO_APPLY.status).toBe("SUPPORTED");
    expect(resend.capabilities.DISCOVERY.status).toBe("NOT_SUPPORTED");
  });

  it("the demo provider is available outside production or when enabled explicitly", () => {
    for (const env of [{}, { NODE_ENV: "development" }, { NODE_ENV: "test" }, { NODE_ENV: "production", DEMO_PROVIDER_ENABLED: "true" }]) {
      const demo = info("demo", env);
      expect(demo.capabilities.DISCOVERY.status).toBe("AVAILABLE");
      expect(demo.capabilities.AUTO_APPLY.status).toBe("SUPPORTED");
      expect(demo.manualOnly).toBe(false);
      expect(demo.auth).toBe("api_key");
      expect(demo.demo).toBe(true);
    }
    for (const env of [{ NODE_ENV: "production" }, { DEMO_PROVIDER_ENABLED: "false" }, { NODE_ENV: "development", DEMO_PROVIDER_ENABLED: "false" }]) {
      const demo = info("demo", env);
      expect(demo.capabilities.DISCOVERY.status).toBe("NOT_CONFIGURED");
      expect(demo.capabilities.AUTO_APPLY.status).toBe("NOT_CONFIGURED");
      expect(demo.manualOnly).toBe(true);
      expect(demo.externalRequirements.join(" ")).toMatch(/DEMO_PROVIDER_ENABLED=true/);
    }
  });
});

// ---------------------------------------------------------------- routing

describe("apply-URL host detection", () => {
  it.each([
    ["https://boards.greenhouse.io/acme/jobs/4012345", "greenhouse"],
    ["https://job-boards.greenhouse.io/acme/jobs/4012345?gh_src=abc", "greenhouse"],
    ["https://job-boards.eu.greenhouse.io/acme/jobs/4012345", "greenhouse"],
    ["https://boards.greenhouse.io/embed/job_app?for=acme&token=4012345", "greenhouse"],
    ["https://boards.greenhouse.io/", "greenhouse"],
    ["https://jobs.lever.co/acme/5f1c2a9e-1111-2222-3333-444455556666/apply", "lever"],
    ["https://jobs.eu.lever.co/acme/5f1c2a9e-1111-2222-3333-444455556666", "lever"],
    ["https://jobs.ashbyhq.com/acme/0b7c5e1d-aaaa-bbbb-cccc-ddddeeeeffff", "ashby"],
    ["https://acme.wd3.myworkdayjobs.com/en-US/External/job/Bengaluru/Frontend-Engineer_R123", "workday"],
    ["https://jobs.smartrecruiters.com/AcmeCorp/743999912345-frontend-engineer", "smartrecruiters"],
    ["https://careers.smartrecruiters.com/AcmeCorp", "smartrecruiters"],
    ["https://apply.workable.com/j/ABC123DEF4", "workable"],
    ["https://apply.workable.com/acme/j/ABC123DEF4/", "workable"],
    ["https://acme.recruitee.com/o/frontend-engineer", "recruitee"],
  ])("%s -> %s", (url, expected) => {
    expect(atsProviderIdForUrl(url)).toBe(expected);
  });

  it.each([
    "https://boards.greenhouse.io.evil.test/acme/jobs/1",
    "https://evil.test/redirect?to=https://jobs.lever.co/acme/1",
    "https://notgreenhouse.io/acme/jobs/1",
    "https://www.workable.com/",
    "https://careers.acme.example/jobs/1",
    "javascript:alert(1)",
    "ftp://jobs.lever.co/acme",
    "not a url",
    "",
  ])("rejects %s", (url) => {
    expect(atsProviderIdForUrl(url)).toBeNull();
  });

  it("detects job-board hosts with anchored matching", () => {
    expect(jobBoardProviderIdForUrl("https://www.linkedin.com/jobs/view/123")).toBe("linkedin");
    expect(jobBoardProviderIdForUrl("https://www.naukri.com/job-listings-x-123")).toBe("naukri");
    expect(jobBoardProviderIdForUrl("https://in.indeed.com/viewjob?jk=1")).toBe("indeed");
    expect(jobBoardProviderIdForUrl("https://www.foundit.in/job/1")).toBe("foundit");
    expect(jobBoardProviderIdForUrl("https://linkedin.com.evil.test/jobs/view/1")).toBeNull();
    expect(jobBoardProviderIdForUrl(null)).toBeNull();
  });
});

describe("applicationProviderForJob", () => {
  it("routes demo jobs to the demo provider first", () => {
    const demo = jobRef({ isDemo: true, sourceMetadata: { demo: true, demoScenario: "auto_success" }, applyUrl: "https://boards.greenhouse.io/acme/jobs/1", applyMethod: "EMAIL", hrEmail: "hr@acme.test" });
    expect(applicationProviderForJob(demo).id).toBe("demo");
    // Both flags are required.
    expect(applicationProviderForJob({ ...demo, sourceMetadata: {} }).id).toBe("greenhouse");
    expect(applicationProviderForJob({ ...demo, isDemo: false }).id).toBe("greenhouse");
  });

  it("prefers a known ATS apply URL, then email, then job-board links and the platform", () => {
    expect(applicationProviderForJob(jobRef({ platform: "LINKEDIN", applyUrl: "https://boards.greenhouse.io/acme/jobs/1" })).id).toBe("greenhouse");
    expect(applicationProviderForJob(jobRef({ platform: "OTHER", applyUrl: "https://jobs.lever.co/acme/1" })).id).toBe("lever");
    expect(applicationProviderForJob(jobRef({ platform: "OTHER", sourceUrl: "https://jobs.ashbyhq.com/acme/1" })).id).toBe("ashby");
    expect(applicationProviderForJob(jobRef({ platform: "OTHER", applyUrl: "https://acme.wd1.myworkdayjobs.com/x" })).id).toBe("workday");
    expect(applicationProviderForJob(jobRef({ applyMethod: "EMAIL", hrEmail: "hiring@acme.test" })).id).toBe("email_application");
    expect(applicationProviderForJob(jobRef({ applyMethod: "EMAIL", hrEmail: null, platform: "NAUKRI" })).id).toBe("naukri");
    expect(applicationProviderForJob(jobRef({ platform: "OTHER", applyUrl: "https://www.linkedin.com/jobs/view/1" })).id).toBe("linkedin");
    expect(applicationProviderForJob(jobRef({ platform: "WELLFOUND", applyUrl: "https://careers.acme.example/1" })).id).toBe("wellfound");
    // Greenhouse board jobs whose absolute_url is on the company site stay with Greenhouse.
    expect(applicationProviderForJob(jobRef({ platform: "GREENHOUSE", applyUrl: "https://acme.example/careers?gh_jid=1" })).id).toBe("greenhouse");
    expect(applicationProviderForJob(jobRef({ platform: "JOB_SEARCH_API", feedProvider: "adzuna", applyUrl: "https://www.adzuna.in/land/ad/1" })).id).toBe("adzuna");
    expect(applicationProviderForJob(jobRef({ platform: "JOB_SEARCH_API" })).id).toBe("career_site");
    expect(applicationProviderForJob(jobRef({ platform: "COMPANY_CAREER_PAGE" })).id).toBe("career_site");
    expect(applicationProviderForJob(jobRef({ platform: "OTHER" })).id).toBe("career_site");
  });

  it("exactly one provider matches each job", () => {
    const jobs = [
      jobRef({ platform: "LINKEDIN" }),
      jobRef({ applyUrl: "https://boards.greenhouse.io/acme/jobs/1" }),
      jobRef({ applyMethod: "EMAIL", hrEmail: "hr@acme.test" }),
      jobRef({ isDemo: true, sourceMetadata: { demo: true } }),
      jobRef({ platform: "JOB_SEARCH_API", feedProvider: "themuse" }),
      jobRef(),
    ];
    for (const job of jobs) {
      const matching = listProviders().filter((p) => p.matchesJob(job));
      expect(matching.map((p) => p.id)).toEqual([applicationProviderForJob(job).id]);
    }
  });
});

describe("sourceProviderIdForJob", () => {
  const src = (platform: JobPlatform, feedProvider: string | null, extra: Partial<ProviderJobRef> = {}) =>
    sourceProviderIdForJob({ platform, feedProvider, isDemo: false, sourceMetadata: {}, ...extra });

  it("uses the automatic source, then the platform", () => {
    expect(src("JOB_SEARCH_API", "adzuna")).toBe("adzuna");
    expect(src("GREENHOUSE", "greenhouse")).toBe("greenhouse");
    expect(src("LINKEDIN", "imap")).toBe("linkedin");
    expect(src("NAUKRI", "gmail")).toBe("naukri");
    expect(src("OTHER", "outlook")).toBe("job_alert_email");
    expect(src("WELLFOUND", null)).toBe("wellfound");
    expect(src("OTHER", null)).toBe("career_site");
    expect(src("INDEED", "something-new")).toBe("indeed");
    expect(src("LINKEDIN", "demo", { isDemo: true, sourceMetadata: { demo: true } })).toBe("demo");
    expect(src("LINKEDIN", null, { isDemo: true, sourceMetadata: { demo: true } })).toBe("demo");
  });
});

describe("supportsApplication", () => {
  it("job boards and Workday are restricted by the platform", () => {
    for (const id of [...JOB_BOARDS, "workday"]) {
      const s = provider(id).supportsApplication!(jobRef(), {});
      expect(s).toMatchObject({ supported: false, channel: "manual", reason: "PROVIDER_RESTRICTION" });
      expect(s.detail.length).toBeGreaterThan(10);
    }
  });

  it("career sites, search APIs and API-key ATS boards are not automated", () => {
    for (const id of ["career_site", "adzuna", "himalayas", "jobicy", "themuse", "smartrecruiters", "workable", "recruitee", "job_alert_email"]) {
      expect(provider(id).supportsApplication!(jobRef(), ENVS.everything!)).toMatchObject({ supported: false, channel: "manual", reason: "AUTOMATION_NOT_SUPPORTED" });
    }
  });

  it("Greenhouse, Lever and Ashby go through the browser channel; email needs an HR address", () => {
    for (const id of ["greenhouse", "lever", "ashby"]) {
      expect(provider(id).supportsApplication!(jobRef(), {})).toMatchObject({ supported: true, channel: "browser", reason: null });
    }
    expect(provider("email_application").supportsApplication!(jobRef({ hrEmail: "hr@acme.test" }), {})).toMatchObject({ supported: true, channel: "email" });
    expect(provider("email_application").supportsApplication!(jobRef(), {})).toMatchObject({ supported: false, channel: "email" });
  });
});

describe("discovery wraps the existing feed adapters", () => {
  it("board providers call the board adapter with config.slug", async () => {
    const calls: string[] = [];
    const fetch = (async (input: string | URL | Request) => {
      calls.push(String(input));
      return json({ jobs: [{ id: 11, title: "Frontend Engineer", company_name: "Acme", absolute_url: "https://boards.greenhouse.io/acme/jobs/11", location: { name: "Bengaluru, India" }, content: "&lt;p&gt;Build React apps&lt;/p&gt;" }] });
    }) as typeof globalThis.fetch;
    const jobs = await provider("greenhouse").discover!({ config: { slug: "acme" }, runtime: { env: {}, fetch } });
    expect(calls).toEqual(["https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true"]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ provider: "GREENHOUSE", externalId: "greenhouse:acme:11" });
    await expect(provider("lever").discover!({ config: {}, runtime: { env: {}, fetch } })).rejects.toBeInstanceOf(FeedProviderError);
  });

  it("search providers refuse to run without their operator key", async () => {
    const fetch = (async () => json({ results: [] })) as typeof globalThis.fetch;
    await expect(provider("adzuna").discover!({ config: { keywords: "react" }, runtime: { env: {}, fetch } })).rejects.toThrow(/not configured/);
  });
});

// ---------------------------------------------------------------- Greenhouse questions

/** Trimmed from a real Job Board API response (GET /v1/boards/{token}/jobs/{id}?questions=true); company data replaced. */
const GREENHOUSE_POSTING: GreenhousePosting & Record<string, unknown> = {
  id: 4012345,
  title: "Senior Frontend Engineer",
  absolute_url: "https://boards.greenhouse.io/acme/jobs/4012345",
  location: { name: "Bengaluru" },
  questions: [
    { required: true, label: "First Name", description: null, fields: [{ name: "first_name", type: "input_text", values: [] }] },
    { required: true, label: "Last Name", description: null, fields: [{ name: "last_name", type: "input_text", values: [] }] },
    { required: true, label: "Email", description: null, fields: [{ name: "email", type: "input_text", values: [] }] },
    { required: false, label: "Phone", description: null, fields: [{ name: "phone", type: "input_text", values: [] }] },
    {
      required: true,
      label: "Resume/CV",
      description: null,
      fields: [
        { name: "resume", type: "input_file", values: [] },
        { name: "resume_text", type: "textarea", values: [] },
      ],
    },
    {
      required: false,
      label: "Cover Letter",
      description: null,
      fields: [
        { name: "cover_letter", type: "input_file", values: [] },
        { name: "cover_letter_text", type: "textarea", values: [] },
      ],
    },
    { required: false, label: "LinkedIn Profile", description: null, fields: [{ name: "question_28001", type: "input_text", values: [] }] },
    { required: false, label: "Website", description: null, fields: [{ name: "question_28002", type: "input_text", values: [] }] },
    {
      required: true,
      label: "Are you legally authorised to work in India?",
      description: null,
      fields: [
        {
          name: "question_28003",
          type: "multi_value_single_select",
          values: [
            { label: "Yes", value: 1 },
            { label: "No", value: 0 },
          ],
        },
      ],
    },
    {
      required: true,
      label: "What is your notice period?",
      description: "<p>In days</p>",
      fields: [{ name: "question_28004", type: "input_text", values: [] }],
    },
    {
      required: false,
      label: "Which of these have you used in production? <em>(select all)</em>",
      description: null,
      fields: [
        {
          name: "question_28005[]",
          type: "multi_value_multi_select",
          values: [
            { label: "React", value: 1 },
            { label: "Vue", value: 2 },
            { label: "Angular", value: 3 },
          ],
        },
      ],
    },
    { required: true, label: "Why do you want to join Acme?", description: null, fields: [{ name: "question_28006", type: "textarea", values: [] }] },
    { required: false, label: "Internal tracking", description: null, fields: [{ name: "gh_src", type: "input_hidden", values: [] }] },
  ],
  location_questions: [{ required: true, label: "Location (City)", description: null, fields: [{ name: "location", type: "input_text", values: [] }] }],
  compliance: [
    {
      type: "eeoc",
      description: "<p>Voluntary self-identification</p>",
      questions: [
        {
          required: false,
          label: "Gender",
          description: null,
          fields: [{ name: "gender", type: "multi_value_single_select", values: [{ label: "Decline to self identify", value: 3 }] }],
        },
      ],
    },
    {
      type: "consent",
      questions: [
        {
          required: true,
          label: "I consent to Acme storing my application data",
          description: null,
          fields: [{ name: "data_consent", type: "multi_value_single_select", values: [{ label: "I agree", value: 1 }] }],
        },
      ],
    },
  ],
};

describe("Greenhouse question extraction", () => {
  it("parses posting links, embeds, API URLs and board external ids", () => {
    expect(parseGreenhousePostingUrl("https://boards.greenhouse.io/acme/jobs/4012345")).toEqual({ boardToken: "acme", jobId: "4012345" });
    expect(parseGreenhousePostingUrl("https://job-boards.eu.greenhouse.io/acme/jobs/4012345?gh_src=x")).toEqual({ boardToken: "acme", jobId: "4012345" });
    expect(parseGreenhousePostingUrl("https://boards.greenhouse.io/embed/job_app?for=acme&token=4012345")).toEqual({ boardToken: "acme", jobId: "4012345" });
    expect(parseGreenhousePostingUrl("https://boards-api.greenhouse.io/v1/boards/acme/jobs/4012345?questions=true")).toEqual({ boardToken: "acme", jobId: "4012345" });
    expect(parseGreenhouseExternalId("greenhouse:acme:4012345")).toEqual({ boardToken: "acme", jobId: "4012345" });
    for (const bad of [
      "https://boards.greenhouse.io/acme",
      "https://boards.greenhouse.io/acme/jobs/not-a-number",
      "https://boards.greenhouse.io.evil.test/acme/jobs/1",
      "https://acme.example/careers?gh_jid=4012345",
      "https://boards.greenhouse.io/..%2F..%2Fetc/jobs/1",
      null,
    ]) {
      expect(parseGreenhousePostingUrl(bad)).toBeNull();
    }
    expect(parseGreenhouseExternalId("lever:acme:1")).toBeNull();
  });

  it("maps form, location and required compliance questions; skips hidden and voluntary ones", () => {
    const questions = greenhouseQuestionsFromPosting(GREENHOUSE_POSTING);
    const byKey = new Map(questions.map((q) => [q.providerKey, q]));
    expect(byKey.get("first_name")).toEqual({ question: "First Name", required: true, inputType: "text", options: null, providerKey: "first_name" });
    expect(byKey.get("email")?.inputType).toBe("email");
    expect(byKey.get("phone")?.required).toBe(false);
    expect(byKey.get("resume")).toMatchObject({ question: "Resume/CV", required: true, inputType: "file" });
    expect(byKey.get("cover_letter")).toMatchObject({ inputType: "file", required: false });
    expect(byKey.get("question_28001")).toMatchObject({ question: "LinkedIn Profile", inputType: "url" });
    expect(byKey.get("question_28002")?.inputType).toBe("url");
    expect(byKey.get("question_28003")).toMatchObject({ inputType: "select", options: ["Yes", "No"], required: true });
    expect(byKey.get("question_28004")).toMatchObject({ question: "What is your notice period?", inputType: "text" });
    expect(byKey.get("question_28005[]")).toMatchObject({ question: "Which of these have you used in production? (select all)", options: ["React", "Vue", "Angular"] });
    expect(byKey.get("question_28006")?.inputType).toBe("textarea");
    expect(byKey.get("location")).toMatchObject({ question: "Location (City)", required: true });
    expect(byKey.get("data_consent")).toMatchObject({ required: true, options: ["I agree"] });
    expect(byKey.has("gh_src")).toBe(false);
    expect(byKey.has("gender")).toBe(false);
    expect(byKey.has("resume_text")).toBe(false);
    expect(questions).toHaveLength(14);
  });

  it("tolerates malformed payloads", () => {
    expect(greenhouseQuestionsFromPosting({})).toEqual([]);
    expect(greenhouseQuestionsFromPosting({ questions: [null as never, { label: "No fields" }, { fields: [{ name: "x", type: "input_text" }] }] })).toEqual([]);
  });

  it("fetches questions from the official Job Board API", async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
      return json(GREENHOUSE_POSTING);
    }) as typeof globalThis.fetch;
    const job = jobRef({ platform: "GREENHOUSE", applyUrl: "https://boards.greenhouse.io/acme/jobs/4012345" });
    expect(applicationProviderForJob(job).id).toBe("greenhouse");
    const req = await provider("greenhouse").getApplicationRequirements!(job, { env: {}, fetch });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://boards-api.greenhouse.io/v1/boards/acme/jobs/4012345?questions=true");
    expect(calls[0]!.headers["user-agent"]).toMatch(/ApplyWise/);
    expect(req.questions).toHaveLength(14);
    expect(req.requiresResume).toBe(true);
    expect(req.acceptsCoverLetter).toBe(true);
    expect(req.requiresLogin).toBe(false);
    expect(req.notes.join(" ")).toMatch(/self-identification/);

    // Falls back to the board adapter's external id when the links are on the company site.
    await provider("greenhouse").getApplicationRequirements!(
      jobRef({ platform: "GREENHOUSE", applyUrl: "https://acme.example/careers?gh_jid=4012345", sourceExternalId: "greenhouse:acme:4012345" }),
      { env: {}, fetch },
    );
    expect(calls[1]!.url).toBe("https://boards-api.greenhouse.io/v1/boards/acme/jobs/4012345?questions=true");
  });

  it("reports closed postings, unknown links and outages as provider errors", async () => {
    const status = (code: number) => (async () => new Response("", { status: code })) as unknown as typeof globalThis.fetch;
    const job = jobRef({ applyUrl: "https://boards.greenhouse.io/acme/jobs/4012345" });
    const gone = await provider("greenhouse").getApplicationRequirements!(job, { env: {}, fetch: status(404) }).catch((e: unknown) => e);
    expect(gone).toBeInstanceOf(FeedProviderError);
    expect((gone as FeedProviderError).retryable).toBe(false);
    const down = await provider("greenhouse").getApplicationRequirements!(job, { env: {}, fetch: status(503) }).catch((e: unknown) => e);
    expect((down as FeedProviderError).retryable).toBe(true);
    const unknown = await provider("greenhouse").getApplicationRequirements!(jobRef({ applyUrl: "https://acme.example/jobs/1" }), { env: {}, fetch: status(200) }).catch((e: unknown) => e);
    expect(unknown).toBeInstanceOf(FeedProviderError);
    expect((unknown as FeedProviderError).message).toMatch(/do not identify/);
  });
});
