import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CONNECTORS,
  ConnectorInputError,
  ConnectorNotConfiguredError,
  DEMO_JOBS,
  parseJobDescription,
  parseJobEmail,
} from "../src";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(join(here, "fixtures", name), "utf8");

describe("job description normalisation", () => {
  it("separates required and preferred skills and never invents data", () => {
    const job = parseJobDescription(
      [
        "Frontend Engineer at Acme",
        "Requirements",
        "- 3-5 years of experience",
        "- Must have React and TypeScript",
        "- Experience with REST APIs",
        "Nice to have",
        "- GraphQL",
      ].join("\n"),
      { importMethod: "MANUAL_ENTRY" },
    );
    expect(job.title).toBe("Frontend Engineer");
    expect(job.company).toBe("Acme");
    expect(job.requiredSkills.map((s) => s.canonicalName)).toEqual(expect.arrayContaining(["React", "TypeScript", "REST API"]));
    expect(job.requiredSkills.find((s) => s.canonicalName === "React")?.mandatory).toBe(true);
    expect(job.preferredSkills.map((s) => s.canonicalName)).toEqual(["GraphQL"]);
    expect(job.experienceMinYears).toBe(3);
    expect(job.experienceMaxYears).toBe(5);
    // Not present in the text -> null, not guessed.
    expect(job.salaryMin).toBeNull();
    expect(job.hrEmail).toBeNull();
    expect(job.applyUrl).toBeNull();
    expect(job.applyMethod).toBe("MANUAL");
  });

  it("extracts explicit LPA salary and email application method", () => {
    const job = parseJobDescription("React Developer\nCompensation: 12-18 LPA\nSend CV to hiring@demo.test\nLocation: Gurugram (onsite)", {
      importMethod: "MANUAL_ENTRY",
    });
    expect(job.salaryMin).toBe(1_200_000);
    expect(job.salaryMax).toBe(1_800_000);
    expect(job.currency).toBe("INR");
    expect(job.hrEmail).toBe("hiring@demo.test");
    expect(job.applyMethod).toBe("EMAIL");
    expect(job.location).toContain("Gurgaon");
    expect(job.workMode).toBe("onsite");
  });
});

describe("manual / paste / career-page connectors", () => {
  it("manual entry uses explicit fields", async () => {
    const [raw] = await CONNECTORS.manual.importJobs({
      payload: {
        title: "React Developer",
        company: "Demo",
        location: ["Pune"],
        description: "Build things with React and TypeScript for our users.",
        requiredSkills: ["ReactJS", "TS"],
        applyUrl: "https://jobs.lever.co/demo/123",
      },
    });
    const job = await CONNECTORS.manual.normalize(raw!);
    expect(job.importMethod).toBe("MANUAL_ENTRY");
    expect(job.platform).toBe("LEVER");
    expect(job.requiredSkills.map((s) => s.canonicalName)).toEqual(["React", "TypeScript"]);
    expect(job.applyMethod).toBe("CAREER_PAGE");
  });

  it("career-page import requires a URL and does not fetch the page", async () => {
    await expect(CONNECTORS.careerPageUrl.importJobs({ payload: { description: "x".repeat(30) } })).rejects.toBeInstanceOf(ConnectorInputError);
    const [raw] = await CONNECTORS.careerPageUrl.importJobs({
      payload: { sourceUrl: "https://boards.greenhouse.io/demo/jobs/1", description: "Senior Frontend Engineer. Requirements: React" },
    });
    expect(raw!.raw).toMatchObject({ kind: "career_page_url", fetched: false });
    expect(raw!.provider).toBe("GREENHOUSE");
    expect(raw!.attribution).toContain("boards.greenhouse.io");
  });
});

describe("CSV connector", () => {
  it("imports valid rows and skips invalid ones, preserving raw rows", async () => {
    const raws = await CONNECTORS.csv.importJobs({ payload: { csv: fixture("jobs.csv") } });
    expect(raws).toHaveLength(2);
    expect(raws[0]!.raw).toMatchObject({ kind: "csv_row", rowNumber: 2 });
    const [a, b] = await Promise.all(raws.map((r) => CONNECTORS.csv.normalize(r)));
    expect(a!.platform).toBe("GREENHOUSE");
    expect(a!.importMethod).toBe("CSV_IMPORT");
    expect(b!.location).toEqual(["Pune", "Remote - India"]);
    expect(b!.applyMethod).toBe("EMAIL");
    expect(b!.hrEmail).toBe("jobs@beta.test");
  });

  it("rejects CSVs without required columns", async () => {
    await expect(CONNECTORS.csv.importJobs({ payload: { csv: "a,b\n1,2" } })).rejects.toThrow(/title/);
  });
});

describe("forwarded email connector", () => {
  it("parses an EML job alert", async () => {
    const parsed = await parseJobEmail(fixture("naukri-alert.eml"));
    expect(parsed.title).toBe("Frontend Engineer");
    expect(parsed.company).toBe("Pixelwave Studios");
    expect(parsed.location).toBe("Bengaluru");
    expect(parsed.applyUrl).toBe("https://careers.pixelwave.example/jobs/frontend-engineer-42");
    expect(parsed.contactEmail).toBe("talent@pixelwave.test");
    expect(parsed.platform).toBe("NAUKRI");

    const [raw] = await CONNECTORS.email.importJobs({ payload: { raw: fixture("naukri-alert.eml") } });
    // Minimal metadata: never the recipient address.
    expect(JSON.stringify(raw!.raw)).not.toContain("candidate@example.test");
    const job = await CONNECTORS.email.normalize(raw!);
    expect(job.requiredSkills.map((s) => s.canonicalName)).toEqual(expect.arrayContaining(["React", "TypeScript", "Canvas API", "Redux"]));
    expect(job.preferredSkills.map((s) => s.canonicalName)).toEqual(expect.arrayContaining(["WebGL", "Chunked uploads"]));
    expect(job.experienceMinYears).toBe(3);
    expect(job.importMethod).toBe("USER_FORWARDED_EMAIL");
  });

  it("parses a plain-text HR email into an email application", async () => {
    const [raw] = await CONNECTORS.email.importJobs({ payload: { raw: fixture("hr-email.txt") } });
    const job = await CONNECTORS.email.normalize(raw!);
    expect(job.title).toBe("Full-Stack Developer");
    expect(job.company).toBe("Bytewise Foods");
    expect(job.hrEmail).toBe("hiring@bytewise.test");
    expect(job.applyMethod).toBe("EMAIL");
    expect(job.screeningQuestions).toContain("Are you comfortable working onsite in Pune?");
  });
});

describe("browser import connector", () => {
  it("requires explicit user confirmation", async () => {
    await expect(
      CONNECTORS.browser.importJobs({ payload: { pageUrl: "https://jobs.ashbyhq.com/x", title: "t", description: "d" } }),
    ).rejects.toThrow(/confirmation/);
    const [raw] = await CONNECTORS.browser.importJobs({
      payload: { pageUrl: "https://jobs.ashbyhq.com/demo/1", title: "Frontend Engineer", description: "We need React and TypeScript.", userConfirmed: true },
    });
    expect(raw!.provider).toBe("ASHBY");
    expect(raw!.importMethod).toBe("USER_INITIATED_BROWSER_IMPORT");
  });
});

describe("seeded demo connector and stubs", () => {
  it("provides at least 30 labelled demo jobs across sources", async () => {
    const raws = await CONNECTORS.seeded.importJobs({ payload: { appUrl: "http://localhost:3000" } });
    expect(raws.length).toBeGreaterThanOrEqual(30);
    expect(raws.length).toBe(DEMO_JOBS.length);
    const jobs = await Promise.all(raws.map((r) => CONNECTORS.seeded.normalize(r)));
    expect(jobs.every((j) => j.isDemo && j.description.includes("[DEMO CONTENT]"))).toBe(true);
    const platforms = new Set(jobs.map((j) => j.platform));
    for (const p of ["NAUKRI", "INDEED", "INSTAHYRE", "GREENHOUSE", "LEVER", "WORKDAY", "ASHBY"]) expect(platforms).toContain(p);
    expect(jobs.some((j) => j.applyMethod === "EMAIL" && j.hrEmail?.endsWith(".test"))).toBe(true);
    expect(jobs.filter((j) => j.applyUrl?.includes("{{APP_URL}}"))).toHaveLength(0);
  });

  it("keeps integration stubs disabled by default", async () => {
    expect(CONNECTORS.officialPartnerApi.isConfigured()).toBe(false);
    expect(CONNECTORS.apiKeyFeed.isConfigured()).toBe(false);
    expect(CONNECTORS.greenhouseBoardApi.isConfigured()).toBe(false);
    await expect(CONNECTORS.officialPartnerApi.importJobs({ payload: {} })).rejects.toBeInstanceOf(ConnectorNotConfiguredError);
  });
});
