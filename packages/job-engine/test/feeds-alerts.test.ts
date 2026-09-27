import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { simpleParser } from "mailparser";
import { describe, expect, it } from "vitest";
import { CONNECTORS, normalizeRawJob, type RawImportedJob } from "../src/connectors";
import {
  ALERT_SETUP_GUIDES,
  JOB_ALERT_SENDER_DOMAINS,
  buildMailFilterQuery,
  detectAlertPlatformFromLinks,
  isJobAlertSender,
  parseAlertJobLink,
  parseJobAlertEmail,
  postedAtFromAge,
} from "../src/feeds/alerts";
import type { AlertEmail } from "../src/feeds/types";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(join(here, "fixtures", "alerts", name), "utf8");
const DATE = new Date("2026-09-24T06:00:00.000Z");

function mail(from: string, parts: { html?: string; text?: string; subject?: string; date?: Date | null }): AlertEmail {
  return { from, subject: parts.subject ?? "Job alert", html: parts.html ?? null, text: parts.text ?? null, date: parts.date === undefined ? DATE : parts.date, messageId: "<fixture@example.test>" };
}
const parse = (from: string, parts: Parameters<typeof mail>[1]) => parseJobAlertEmail(mail(from, parts));
const titles = (jobs: RawImportedJob[]) => jobs.map((j) => j.hints.title);

/** Every fixture with its sender and expected job count (multi-job digests and single-job mails per site). */
const FIXTURES: { file: string; from: string; kind: "html" | "text"; jobs: number; platform: string }[] = [
  { file: "linkedin-digest.html", from: "LinkedIn Job Alerts <jobalerts-noreply@linkedin.com>", kind: "html", jobs: 3, platform: "LINKEDIN" },
  { file: "linkedin-digest.txt", from: "jobalerts-noreply@linkedin.com", kind: "text", jobs: 3, platform: "LINKEDIN" },
  { file: "linkedin-recommended.html", from: "LinkedIn <jobs-noreply@linkedin.com>", kind: "html", jobs: 2, platform: "LINKEDIN" },
  { file: "linkedin-single.html", from: "LinkedIn <jobs-listings@linkedin.com>", kind: "html", jobs: 1, platform: "LINKEDIN" },
  { file: "indeed-digest.html", from: '"Indeed" <donotreply@jobalert.indeed.com>', kind: "html", jobs: 3, platform: "INDEED" },
  { file: "indeed-digest.txt", from: '"Indeed" <donotreply@jobalert.indeed.com>', kind: "text", jobs: 3, platform: "INDEED" },
  { file: "indeed-match.html", from: '"Indeed" <donotreply@match.indeed.com>', kind: "html", jobs: 1, platform: "INDEED" },
  { file: "naukri-recommended.html", from: "Naukri <naukrialerts@naukri.com>", kind: "html", jobs: 3, platform: "NAUKRI" },
  { file: "naukri-custom-alert.html", from: "Naukri Job Alert <naukrialerts@naukri.com>", kind: "html", jobs: 2, platform: "NAUKRI" },
  { file: "naukri-recruiter.html", from: "Recruiter via Naukri <info@naukri.com>", kind: "html", jobs: 1, platform: "NAUKRI" },
  { file: "foundit-digest.html", from: "foundit <jobalerts@foundit.in>", kind: "html", jobs: 3, platform: "FOUNDIT" },
  { file: "foundit-recruiter.html", from: "foundit <recruiter@mailer.foundit.in>", kind: "html", jobs: 1, platform: "FOUNDIT" },
  { file: "instahyre-digest.html", from: "Instahyre <notifications@instahyre.com>", kind: "html", jobs: 2, platform: "INSTAHYRE" },
  { file: "instahyre-recruiter.html", from: "Instahyre <recruiter@instahyre.com>", kind: "html", jobs: 1, platform: "INSTAHYRE" },
  { file: "cutshort-digest.html", from: "Cutshort <jobs@cutshort.io>", kind: "html", jobs: 2, platform: "CUTSHORT" },
  { file: "cutshort-single.txt", from: "Team Cutshort <team@cutshort.io>", kind: "text", jobs: 1, platform: "CUTSHORT" },
  { file: "wellfound-digest.html", from: "Wellfound <team@hi.wellfound.com>", kind: "html", jobs: 3, platform: "WELLFOUND" },
  { file: "wellfound-single.html", from: "Wellfound <talent@wellfound.com>", kind: "html", jobs: 1, platform: "WELLFOUND" },
  { file: "glassdoor-digest.html", from: "Glassdoor Jobs <noreply@glassdoor.com>", kind: "html", jobs: 2, platform: "GLASSDOOR" },
  { file: "glassdoor-single.html", from: "Glassdoor <noreply@glassdoor.co.in>", kind: "html", jobs: 1, platform: "GLASSDOOR" },
  { file: "hirist-digest.html", from: "hirist.tech <info@hirist.tech>", kind: "html", jobs: 3, platform: "HIRIST" },
  { file: "iimjobs-single.html", from: "iimjobs <info@iimjobs.com>", kind: "html", jobs: 1, platform: "HIRIST" },
];
const parsedFixture = (f: (typeof FIXTURES)[number]) => parse(f.from, f.kind === "html" ? { html: fixture(f.file) } : { text: fixture(f.file) });

// ---------------------------------------------------------------- senders

describe("job-alert senders", () => {
  it("matches the sender domain anchored, so look-alike domains are rejected", () => {
    for (const ok of [
      "LinkedIn Job Alerts <jobalerts-noreply@linkedin.com>",
      "jobs-listings@linkedin.com",
      '"Indeed" <donotreply@jobalert.indeed.com>',
      "Naukri <naukrialerts@naukri.com>",
      "alerts@FOUNDIT.IN",
      "info@hirist.tech",
      "info@iimjobs.com",
      "noreply@glassdoor.co.in",
      "team@cutshort.io",
      "hello@instahyre.com",
      "talent@wellfound.com",
    ]) {
      expect(isJobAlertSender(ok), ok).toBe(true);
    }
    for (const bad of [
      "jobalerts-noreply@linkedin.com.evil.test",
      "LinkedIn <jobalerts-noreply@linkedin.com.evil.test>",
      "alerts@notlinkedin.com",
      "alerts@naukri.com-jobs.test",
      '"jobalerts-noreply@linkedin.com" <attacker@evil.test>',
      "naukrifastforward@jobs4u.com",
      "recruitmentnaukri@gmail.com",
      "messages-noreply@linkedin.com",
      "invitations@linkedin.com",
      // InMail is a private message, not job mail.
      "inmail-hit-reply@linkedin.com",
      // A display name or comment that holds an address never counts; two addresses are ambiguous.
      '"<jobalerts-noreply@linkedin.com>" <attacker@evil.test>',
      '"LinkedIn <jobalerts-noreply@linkedin.com>" <attacker@evil.test>',
      "attacker@evil.test (jobalerts-noreply@linkedin.com)",
      "<jobalerts-noreply@linkedin.com> attacker@evil.test",
      "jobalerts-noreply@linkedin.com <attacker@evil.test>",
      "",
      "not an address",
    ]) {
      expect(isJobAlertSender(bad), bad).toBe(false);
    }
  });

  it("rejects a spoofed digest and unknown senders without parsing", () => {
    const html = fixture("linkedin-digest.html");
    expect(parse("LinkedIn Job Alerts <jobalerts-noreply@linkedin.com.evil.test>", { html })).toEqual({
      platform: null,
      jobs: [],
      notes: ["not a known job-alert sender"],
    });
    expect(parse("Some Recruiter <hr@example.test>", { html })).toEqual({ platform: null, jobs: [], notes: ["not a known job-alert sender"] });
  });

  it("ignores LinkedIn notifications and application updates", () => {
    const html = fixture("linkedin-digest.html");
    const social = parse("LinkedIn <messages-noreply@linkedin.com>", { html });
    expect(social.platform).toBe("LINKEDIN");
    expect(social.jobs).toEqual([]);
    const update = parse("LinkedIn <jobs-noreply@linkedin.com>", { html, subject: "Your application was sent to Northwind Analytics" });
    expect(update.jobs).toEqual([]);
    expect(update.notes).toEqual(["application status update, not a job alert"]);
  });

  it("lists focused mailbox senders and builds a Gmail filter query", () => {
    for (const d of ["naukri.com", "indeed.com", "foundit.in", "instahyre.com", "cutshort.io", "wellfound.com", "glassdoor.com", "glassdoor.co.in", "hirist.tech", "iimjobs.com"]) {
      expect(JOB_ALERT_SENDER_DOMAINS).toContain(d);
    }
    // LinkedIn is narrowed to job mail so private messages are never fetched.
    expect(JOB_ALERT_SENDER_DOMAINS).toContain("jobalerts-noreply@linkedin.com");
    expect(JOB_ALERT_SENDER_DOMAINS).not.toContain("linkedin.com");
    for (const s of JOB_ALERT_SENDER_DOMAINS) expect(s).toMatch(/^(?:[a-z0-9._%+-]+@)?[a-z0-9-]+(?:\.[a-z0-9-]+)+$/);
    for (const s of JOB_ALERT_SENDER_DOMAINS) expect(isJobAlertSender(s.includes("@") ? s : `alerts@${s}`), s).toBe(true);

    const q = buildMailFilterQuery();
    expect(q.startsWith("from:(")).toBe(true);
    expect(q).toContain("naukri.com OR ");
    expect(q.endsWith(")")).toBe(true);
    expect(buildMailFilterQuery(["linkedin.com", "NAUKRI.COM", "naukri.com", "bad domain", "x) OR label:(y", "@indeed.com"])).toBe("from:(linkedin.com OR naukri.com OR indeed.com)");
    expect(buildMailFilterQuery([])).toBe("");
    // A leading "-" would turn a sender into an exclusion in Gmail search.
    expect(buildMailFilterQuery(["-naukri.com", "-x@indeed.com", "naukri.-com", "naukri.com"])).toBe("from:(naukri.com)");
  });

  it("has one alert setup guide per supported site", () => {
    const platforms = ALERT_SETUP_GUIDES.map((g) => g.platform);
    expect(new Set(platforms).size).toBe(platforms.length);
    expect(platforms).toEqual(expect.arrayContaining(["LINKEDIN", "INDEED", "NAUKRI", "FOUNDIT", "INSTAHYRE", "CUTSHORT", "WELLFOUND", "GLASSDOOR", "HIRIST"]));
    for (const g of ALERT_SETUP_GUIDES) {
      expect(g.createAlertUrl).toMatch(/^https:\/\//);
      expect(g.steps.length).toBeGreaterThanOrEqual(2);
      expect(g.steps.every((s) => s.length > 10 && s.length < 200)).toBe(true);
      if (g.searchUrlTemplate) expect(g.searchUrlTemplate).toMatch(/^https:\/\/.*\{keywords\}.*\{location\}/);
    }
    const byPlatform = Object.fromEntries(ALERT_SETUP_GUIDES.map((g) => [g.platform, g]));
    expect(byPlatform.LINKEDIN!.searchUrlTemplate).toBe("https://www.linkedin.com/jobs/search/?keywords={keywords}&location={location}");
    expect(byPlatform.LINKEDIN!.steps.join(" ")).toMatch(/20/);
    expect(byPlatform.NAUKRI!.createAlertUrl).toBe("https://www.naukri.com/free-job-alerts");
    expect(byPlatform.NAUKRI!.steps.join(" ")).toMatch(/Communication and Privacy/);
    expect(byPlatform.NAUKRI!.steps.join(" ")).toMatch(/up to 5/);
  });
});

// ---------------------------------------------------------------- links

describe("job links", () => {
  const cts = (json: unknown) => `https://cts.indeed.com/v3/${gzipSync(Buffer.from(JSON.stringify(json))).toString("base64url")}/FAKESIG`;

  it("canonicalises job links and strips member tokens", () => {
    expect(parseAlertJobLink("https://www.linkedin.com/comm/jobs/view/4312345601/?trackingId=X&midToken=M&otpToken=O&trk=eml")).toMatchObject({
      platform: "LINKEDIN",
      id: "4312345601",
      url: "https://www.linkedin.com/jobs/view/4312345601/",
    });
    expect(parseAlertJobLink("https://in.linkedin.com/jobs/view/senior-python-developer-at-acme-4312345601")?.id).toBe("4312345601");
    expect(parseAlertJobLink("https://www.linkedin.com/jobs/search/?currentJobId=4312345601&keywords=x")?.id).toBe("4312345601");
    expect(parseAlertJobLink("https://in.indeed.com/rc/clk/dl?jk=3F2A9C1B7E5D4A60&from=ja&tk=T&alid=A&bb=B")?.url).toBe("https://in.indeed.com/viewjob?jk=3f2a9c1b7e5d4a60");
    expect(parseAlertJobLink("https://in.indeed.com/jobs?q=python&vjk=9b1e04c7a2d85f31")?.id).toBe("9b1e04c7a2d85f31");
    expect(parseAlertJobLink("https://www.naukri.com/job-listings-python-developer-cgi-bengaluru-4-to-5-years-260826018602?sid=1&xp=2&px=1")?.url).toBe(
      "https://www.naukri.com/job-listings-python-developer-cgi-bengaluru-4-to-5-years-260826018602",
    );
    expect(parseAlertJobLink("https://www.hirist.com/j/senior-nodejs-backend-developer-1-3-yrs-1389640.html?pref=rl&jobpos=19")).toMatchObject({
      platform: "HIRIST",
      id: "1389640",
      url: "https://www.hirist.tech/j/senior-nodejs-backend-developer-1-3-yrs-1389640.html",
    });
    expect(parseAlertJobLink("https://cutshort.io/job/Backend-Engineer-Kira-Studio-O9oZwtFG?utm_source=x")?.id).toBe("O9oZwtFG");
    expect(parseAlertJobLink("https://www.glassdoor.co.in/partner/jobListing.htm?pos=102&jobListingId=1010148677811&jrtk=abc&guid=g")?.url).toBe(
      "https://www.glassdoor.co.in/partner/jobListing.htm?jobListingId=1010148677811",
    );
    expect(parseAlertJobLink("https://wellfound.com/company/acme/jobs/990389-software-engineer?email_uid=1")?.url).toBe("https://wellfound.com/jobs/990389");
    // Mail hosts have no job pages: the canonical URL uses the main site.
    expect(parseAlertJobLink("https://jobalert.indeed.com/rc/clk?jk=3f2a9c1b7e5d4a60&tk=T")?.url).toBe("https://www.indeed.com/viewjob?jk=3f2a9c1b7e5d4a60");
    expect(parseAlertJobLink("https://uk.indeed.com/viewjob?jk=3f2a9c1b7e5d4a60")?.url).toBe("https://uk.indeed.com/viewjob?jk=3f2a9c1b7e5d4a60");
  });

  it("returns null for non-job links (search, alerts, company, settings, apps, help)", () => {
    for (const u of [
      "https://www.linkedin.com/comm/jobs/search-results/?keywords=x&originToLandingJobPostings=1,2",
      "https://www.linkedin.com/comm/jobs/alerts?savedSearchId=1",
      "https://www.linkedin.com/comm/company/acme/",
      "https://www.linkedin.com/comm/psettings/email-unsubscribe?lipi=x",
      "https://www.linkedin.com/help/linkedin/answer/4788",
      "https://in.indeed.com/jobs?q=python&l=Bengaluru",
      "https://subscriptions.indeed.com/alerts/cancel?token=x",
      "https://match.indeed.com/invitations/not-interested?tk=x",
      "https://www.naukri.com/python-developer-jobs-in-bengaluru",
      "https://www.naukri.com/mnjuser/recommendedjobs",
      "https://www.naukri.com/alert/modify?aId=1&reg=0",
      "https://wellfound.com/company/acme/jobs",
      "https://www.glassdoor.co.in/Overview/Working-at-Acme-EI_IE1.htm",
      "https://play.google.com/store/apps/details?id=com.naukri.jobseeker",
      "https://apps.apple.com/app/linkedin/id288429040",
      "https://www.linkedin.com.evil.test/jobs/view/4312345601/",
      "https://naukri.com.evil.test/job-listings-x-260826018602",
      "javascript:alert(1)",
      "mailto:hr@example.test",
      "not a url",
    ]) {
      expect(parseAlertJobLink(u), u).toBeNull();
    }
  });

  it("decodes Indeed cts click tokens offline and keeps only job clicks", () => {
    const target = "https://in.indeed.com/rc/clk?jk=5c7e2d9a1b3f4e80&from=FAKEFROM&tk=FAKETK";
    expect(parseAlertJobLink(cts({ u: target, m: { clickType: "viewjob", accountId: "A" } }))?.url).toBe("https://in.indeed.com/viewjob?jk=5c7e2d9a1b3f4e80");
    expect(parseAlertJobLink(cts({ u: target }))?.id).toBe("5c7e2d9a1b3f4e80");
    expect(parseAlertJobLink(cts({ u: target, m: { clickType: "bad-match" } }))).toBeNull();
    expect(parseAlertJobLink(cts({ u: "https://in.indeed.com/", m: { clickType: "homepage" } }))).toBeNull();
    expect(parseAlertJobLink(cts({ u: "https://match.indeed.com/invitations/pause?tk=x" }))).toBeNull();
    expect(parseAlertJobLink("https://cts.indeed.com/v3/H4sIAAAAnotreallygzip/SIG")).toBeNull();
    // A decompression bomb is cut off at 64 KB instead of being inflated.
    const bomb = `https://cts.indeed.com/v3/${gzipSync(Buffer.from(`{"u":"${"a".repeat(500_000)}"}`)).toString("base64url")}/S`;
    expect(parseAlertJobLink(bomb)).toBeNull();
  });

  it("unwraps redirect and safe-link wrappers without fetching them", () => {
    expect(parseAlertJobLink("https://www.google.com/url?q=https://www.naukri.com/job-listings-data-engineer-acme-pune-2-to-5-years-200926910045&sa=D")?.id).toBe("200926910045");
    expect(
      parseAlertJobLink("https://eur01.safelinks.protection.outlook.com/?url=https%3A%2F%2Fwww.linkedin.com%2Fcomm%2Fjobs%2Fview%2F4312345601%2F%3FotpToken%3DX&data=05")?.url,
    ).toBe("https://www.linkedin.com/jobs/view/4312345601/");
    expect(parseAlertJobLink("https://www.naukri.com/nlogin/redirect?URL=https%3A%2F%2Fwww.naukri.com%2Fjob-listings-ml-engineer-x-bengaluru-4-to-8-years-230926500777%3Fsrc%3Djobalert&token=T")?.url).toBe(
      "https://www.naukri.com/job-listings-ml-engineer-x-bengaluru-4-to-8-years-230926500777",
    );
    expect(parseAlertJobLink("https://tracker.example.test/c?url=https%3A%2F%2Fexample.test%2Funsubscribe")).toBeNull();
  });

  it("converts relative ages into posting dates only when unambiguous", () => {
    expect(postedAtFromAge("2 days ago", DATE)).toBe("2026-09-22T06:00:00.000Z");
    expect(postedAtFromAge("Just posted", DATE)).toBe(DATE.toISOString());
    expect(postedAtFromAge("22h", DATE)).toBe("2026-09-23T08:00:00.000Z");
    // Hours count back from the mail date ("48 hours ago" is two days, not today).
    expect(postedAtFromAge("48 hours ago", DATE)).toBe("2026-09-22T06:00:00.000Z");
    expect(postedAtFromAge("5 mins ago", DATE)).toBe(DATE.toISOString());
    expect(postedAtFromAge("1 Day Ago", DATE)).toBe("2026-09-23T06:00:00.000Z");
    expect(postedAtFromAge("30+ days ago", DATE)).toBeUndefined();
    expect(postedAtFromAge("2 days ago", null)).toBeUndefined();
  });
});

// ---------------------------------------------------------------- providers

describe("job-alert parsing per provider", () => {
  it.each(FIXTURES)("$file -> $jobs job(s)", (f) => {
    const res = parsedFixture(f);
    expect(res.platform).toBe(f.platform);
    expect(res.jobs).toHaveLength(f.jobs);
    for (const j of res.jobs) {
      expect(j.importMethod).toBe("USER_MAILBOX_ALERT");
      expect(j.descriptionLevel).toBe("SNIPPET");
      expect(j.externalId).toMatch(/^[a-z]+:[\w-]+$/);
      expect(j.sourceUrl).toMatch(/^https:\/\//);
      expect(j.hints.applyUrl).toBe(j.sourceUrl);
      expect(j.hints.title).toBeTruthy();
      expect(j.text.split("\n")[0]).toBe(j.hints.title);
      expect(j.attribution).toMatch(/job alert \(your email\)$/);
    }
    expect(new Set(res.jobs.map((j) => j.externalId)).size).toBe(res.jobs.length);
  });

  it("LinkedIn digest (HTML): three cards, repeated top pick deduped, fields from the card", () => {
    const { jobs, notes } = parse("LinkedIn Job Alerts <jobalerts-noreply@linkedin.com>", { html: fixture("linkedin-digest.html") });
    expect(notes).toEqual([]);
    expect(jobs.map((j) => j.externalId)).toEqual(["linkedin:4312345601", "linkedin:4312345602", "linkedin:4312345603"]);
    const first = jobs[0]!;
    expect(first).toMatchObject({ provider: "LINKEDIN", sourceUrl: "https://www.linkedin.com/jobs/view/4312345601/", attribution: "LinkedIn job alert (your email)" });
    expect(first.hints).toMatchObject({ title: "Senior Python Developer", company: "Northwind Analytics", location: ["Bengaluru"], workMode: "hybrid", salaryMin: 1_800_000, salaryMax: 2_800_000, currency: "INR" });
    expect(jobs[1]!.hints).toMatchObject({ title: "Backend Engineer – Python & Django", company: "Kestrel Payments", location: ["Pune"], workMode: "onsite" });
    expect(jobs[2]!.hints).toMatchObject({ company: "Saffron Cloud Labs", location: ["Remote"], workMode: "remote" });
    expect(first.raw).toEqual({ kind: "job_alert_email", platform: "LINKEDIN", jobId: "4312345601", senderDomain: "linkedin.com", receivedAt: DATE.toISOString() });
  });

  it("LinkedIn text-only and HTML-only variants give the same jobs; both parts merge", () => {
    const from = "jobalerts-noreply@linkedin.com";
    const html = parse(from, { html: fixture("linkedin-digest.html") }).jobs;
    const text = parse(from, { text: fixture("linkedin-digest.txt") }).jobs;
    const both = parse(from, { html: fixture("linkedin-digest.html"), text: fixture("linkedin-digest.txt") }).jobs;
    expect(text.map((j) => j.externalId)).toEqual(html.map((j) => j.externalId));
    expect(titles(text)).toEqual(titles(html));
    expect(text.map((j) => j.hints.company)).toEqual(html.map((j) => j.hints.company));
    expect(both.map((j) => j.externalId)).toEqual(html.map((j) => j.externalId));
  });

  it("LinkedIn recommendations and single-job mail skip navigation, logos and buttons", () => {
    const rec = parse("jobs-noreply@linkedin.com", { html: fixture("linkedin-recommended.html") }).jobs;
    expect(titles(rec)).toEqual(["Android Developer (Kotlin)", "Full Stack Engineer (React / Node.js)"]);
    expect(rec[1]!.hints.location).toEqual(["Gurugram"]);
    const [single] = parse("jobs-listings@linkedin.com", { html: fixture("linkedin-single.html") }).jobs;
    expect(single!.hints).toMatchObject({ title: "Site Reliability Engineer", company: "Juniper Freight", location: ["Chennai"], workMode: "onsite", salaryMin: 2_000_000 });
    // Hidden preheader, greeting, footer and the recipient line never reach the job text.
    expect(single!.text).not.toMatch(/Asha|intended for|Get the app|Unsubscribe|View job/);
  });

  it("Indeed digest: jk ids, a sponsored card keyed by content, ages to dates, INR pay", () => {
    for (const part of [{ html: fixture("indeed-digest.html") }, { text: fixture("indeed-digest.txt") }]) {
      const { jobs } = parse('"Indeed" <donotreply@jobalert.indeed.com>', part);
      expect(jobs.map((j) => j.externalId).slice(0, 2)).toEqual(["indeed:3f2a9c1b7e5d4a60", "indeed:9b1e04c7a2d85f31"]);
      expect(jobs[0]!.hints).toMatchObject({ company: "Cobalt Byte Labs Pvt Ltd", location: ["Bengaluru"], salaryMin: 600_000, salaryMax: 900_000, currency: "INR", postedAt: "2026-09-22T06:00:00.000Z" });
      expect(jobs[1]!.hints).toMatchObject({ company: "Marigold Fintech Private Limited", location: ["Bengaluru"], workMode: "hybrid", postedAt: DATE.toISOString() });
      const sponsored = jobs[2]!;
      expect(sponsored.externalId).toMatch(/^indeed:h-[0-9a-f]{16}$/);
      expect(sponsored.raw.jobId).toBeNull();
      expect(sponsored.hints).toMatchObject({ title: "Software Engineer - Data Platform", company: "Tealeaf Systems", location: ["Remote"], workMode: "remote" });
    }
    // The same sponsored job gets the same key from either part, so the parts merge to 3 jobs.
    const both = parse("donotreply@jobalert.indeed.com", { html: fixture("indeed-digest.html"), text: fixture("indeed-digest.txt") }).jobs;
    expect(both).toHaveLength(3);
  });

  it("Indeed matched job: cts links decoded, button and footer links ignored, monthly pay annualised", () => {
    const { jobs } = parse('"Indeed" <donotreply@match.indeed.com>', { html: fixture("indeed-match.html") });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ externalId: "indeed:5c7e2d9a1b3f4e80", sourceUrl: "https://in.indeed.com/viewjob?jk=5c7e2d9a1b3f4e80" });
    expect(jobs[0]!.hints).toMatchObject({ title: "Data Analyst", company: "Peacock Retail Analytics LLP", location: ["Chennai"], salaryMin: 420_000, salaryMax: 600_000, employmentType: "full_time" });
    expect(jobs[0]!.text).toContain("Power BI");
    expect(jobs[0]!.text).not.toMatch(/Hi Asha|bad match|Pause these emails/);
  });

  it("Naukri recommended jobs: experience, INR salary, skills and places; navigation links skipped", async () => {
    const { jobs } = parse("Naukri <naukrialerts@naukri.com>", { html: fixture("naukri-recommended.html") });
    expect(titles(jobs)).toEqual(["Python Developer", "Senior Software Engineer - Backend", "Data Engineer"]);
    expect(jobs[0]!.hints).toMatchObject({ company: "Cobalt Byte Labs", location: ["Bengaluru"], experienceMinYears: 3, experienceMaxYears: 6, salaryMin: 1_200_000, salaryMax: 1_800_000, postedAt: "2026-09-23T06:00:00.000Z" });
    expect(jobs[1]!.hints).toMatchObject({ location: ["Pune", "Mumbai"], workMode: "hybrid", experienceMinYears: 5 });
    expect(jobs[1]!.hints.salaryMin).toBeUndefined(); // "Not disclosed"
    expect(jobs[0]!.text).toContain("Skills: Python, Django, REST, PostgreSQL, AWS");
    const normalized = await normalizeRawJob(jobs[0]!);
    expect(normalized.requiredSkills.map((s) => s.canonicalName)).toEqual(expect.arrayContaining(["Python", "Django"]));
    expect(normalized).toMatchObject({ platform: "NAUKRI", importMethod: "USER_MAILBOX_ALERT", experienceMinYears: 3, experienceMaxYears: 6, salaryMin: 1_200_000, sourceExternalId: "naukri:220926501234", location: ["Bengaluru"] });
  });

  it("Naukri custom alert: auto-login redirects unwrapped, the Apply link folds into the same job", () => {
    const { jobs } = parse("naukrialerts@naukri.com", { html: fixture("naukri-custom-alert.html") });
    expect(jobs.map((j) => j.externalId)).toEqual(["naukri:230926601010", "naukri:230926500777"]);
    expect(jobs[0]!.sourceUrl).toBe("https://www.naukri.com/job-listings-python-django-developer-lotus-mobility-bengaluru-3-to-5-years-230926601010");
    expect(jobs[0]!.hints).toMatchObject({ title: "Python / Django Developer", company: "Lotus Mobility", salaryMin: 1_000_000, salaryMax: 1_600_000 });
    expect(jobs[1]!.hints).toMatchObject({ workMode: "hybrid", experienceMinYears: 4, experienceMaxYears: 8 });
  });

  it("Naukri recruiter mail: one job with its description, no greeting or signature", () => {
    const [job] = parse("info@naukri.com", { html: fixture("naukri-recruiter.html") }).jobs;
    expect(job!.hints).toMatchObject({ title: "Lead QA Automation Engineer", company: "Peacock Retail Analytics LLP", location: ["Chennai"], experienceMinYears: 6, experienceMaxYears: 9, salaryMin: 1_800_000, salaryMax: 2_400_000 });
    expect(job!.text).toContain("Selenium or Playwright");
    expect(job!.text).not.toMatch(/Dear Asha|Priya Example|Regards|I am interested/);
  });

  it("Foundit: tracking wrappers and legacy monsterindia links; the recipient footer is dropped", () => {
    const { jobs } = parse("jobalerts@foundit.in", { html: fixture("foundit-digest.html") });
    expect(jobs.map((j) => j.externalId)).toEqual(["foundit:31234567", "foundit:31234999", "foundit:29876543"]);
    expect(jobs[1]!.sourceUrl).toBe("https://www.foundit.in/job/senior-backend-engineer-go-rivulet-logistics-pune-31234999");
    expect(jobs[1]!.hints).toMatchObject({ salaryMin: 2_000_000, salaryMax: 3_000_000, experienceMinYears: 5, postedAt: DATE.toISOString() });
    expect(jobs[2]!.sourceUrl).toBe("https://www.monsterindia.com/job/frontend-developer-react-marblewood-digital-hyderabad-chennai-29876543");
    expect(jobs[2]!.hints.location).toEqual(["Hyderabad", "Chennai"]);
    const [rec] = parse("recruiter@mailer.foundit.in", { html: fixture("foundit-recruiter.html") }).jobs;
    expect(rec!.hints).toMatchObject({ title: "DevOps Engineer", company: "Tamarind Health Systems", location: ["Noida"], salaryMin: 1_000_000, salaryMax: 1_500_000 });
    expect(rec!.text).toContain("Terraform");
    for (const j of [...jobs, rec!]) expect(j.text).not.toMatch(/@|Kavya|Hello Asha/);
  });

  it("Instahyre and Cutshort: profile-driven digests, a single recruiter mail and a text-only mail", () => {
    const insta = parse("notifications@instahyre.com", { html: fixture("instahyre-digest.html") }).jobs;
    expect(insta.map((j) => j.externalId)).toEqual(["instahyre:284512", "instahyre:284530"]);
    expect(insta[0]!.hints).toMatchObject({ company: "Pebblepath Technologies", location: ["Bangalore"], experienceMinYears: 4, experienceMaxYears: 8 });
    expect(insta[0]!.text).not.toMatch(/View & Apply/);
    const [staff] = parse("recruiter@instahyre.com", { html: fixture("instahyre-recruiter.html") }).jobs;
    expect(staff!.hints).toMatchObject({ title: "Staff Engineer - Platform", experienceMinYears: 8 });
    expect(staff!.text).not.toMatch(/Neha|Not interested|Team Instahyre/);

    const cut = parse("jobs@cutshort.io", { html: fixture("cutshort-digest.html") }).jobs;
    expect(cut.map((j) => j.externalId)).toEqual(["cutshort:Q7wK2pLm", "cutshort:aB3dE5fG"]);
    expect(cut[0]!.hints).toMatchObject({ salaryMin: 1_500_000, salaryMax: 2_500_000, experienceMinYears: 2, experienceMaxYears: 5 });
    expect(cut[1]!.hints).toMatchObject({ location: ["Remote"], workMode: "remote" });
    const [single] = parse("team@cutshort.io", { text: fixture("cutshort-single.txt") }).jobs;
    expect(single).toMatchObject({ externalId: "cutshort:Zx81LmQa", sourceUrl: "https://cutshort.io/job/Data-Engineer-Remote-Fernhill-Labs-Zx81LmQa" });
    expect(single!.hints).toMatchObject({ title: "Data Engineer", company: "Fernhill Labs", location: ["Remote"], workMode: "remote", experienceMinYears: 3 });
  });

  it("Wellfound: opaque click links keyed by content, the repeated card collapses, company pages ignored", () => {
    const { jobs } = parse("team@hi.wellfound.com", { html: fixture("wellfound-digest.html") });
    expect(titles(jobs)).toEqual(["Founding Backend Engineer", "Senior Product Designer", "Growth Marketer"]);
    expect(jobs[0]!.externalId).toMatch(/^wellfound:h-[0-9a-f]{16}$/);
    expect(jobs[0]!.sourceUrl).toBe("https://links.wellfound.com/s/c/FAKETOKENAAA111/12");
    expect(jobs[0]!.hints).toMatchObject({ company: "Quokka Robotics", location: ["Bengaluru"], workMode: "remote", salaryMin: 3_000_000 });
    expect(jobs[1]).toMatchObject({ externalId: "wellfound:2345678", sourceUrl: "https://wellfound.com/jobs/2345678" });
    expect(jobs[2]!.hints.company).toBe("Lumen Ledger");
    expect(jobs.every((j) => !/Hi Asha|found 3 new jobs/.test(j.text))).toBe(true);
    const [single] = parse("talent@wellfound.com", { html: fixture("wellfound-single.html") }).jobs;
    expect(single).toMatchObject({ externalId: "wellfound:2345999", sourceUrl: "https://wellfound.com/jobs/2345999" });
    expect(single!.hints).toMatchObject({ title: "Staff Data Engineer", company: "Lumen Ledger", workMode: "remote", employmentType: "full_time" });
  });

  it("Glassdoor: company before the title, reissued listing ids deduped by content", () => {
    const { jobs } = parse("noreply@glassdoor.com", { html: fixture("glassdoor-digest.html") });
    expect(titles(jobs)).toEqual(["Data Scientist", "3.0 to 5.0 yrs - Backend Engineer"]);
    expect(jobs[0]!.externalId).toMatch(/^glassdoor:h-[0-9a-f]{16}$/);
    expect(jobs[0]!.sourceUrl).toBe("https://www.glassdoor.co.in/partner/jobListing.htm?jobListingId=1009876543210");
    expect(jobs[0]!.hints).toMatchObject({ company: "Tidewater Analytics", location: ["Bengaluru"], postedAt: "2026-09-21T06:00:00.000Z" });
    expect(jobs[0]!.hints.salaryMin).toBeUndefined(); // an estimate, not an explicit range
    expect(jobs[1]!.hints).toMatchObject({ company: "Harborline Systems", location: ["Pune"] });
    // The same posting in the next digest (new listing id) keeps its external id.
    const again = parse("noreply@glassdoor.com", { html: fixture("glassdoor-digest.html").replace(/1009876543210/g, "1009876549999") }).jobs;
    expect(again[0]!.externalId).toBe(jobs[0]!.externalId);
    const [single] = parse("noreply@glassdoor.co.in", { html: fixture("glassdoor-single.html") }).jobs;
    expect(single!.hints).toMatchObject({ title: "Machine Learning Engineer", company: "Tidewater Analytics", salaryMin: 2_500_000, salaryMax: 4_000_000 });
  });

  it("Hirist / iimjobs: 'Company · Experience · Location' lines; the text stub is ignored", () => {
    const { jobs } = parse("info@hirist.tech", { html: fixture("hirist-digest.html"), text: "Please Enable HTML" });
    expect(jobs.map((j) => j.externalId)).toEqual(["hirist:1523456", "hirist:1523999", "hirist:1524100"]);
    expect(jobs[1]!.sourceUrl).toBe("https://www.hirist.tech/j/golang-developer-driftwood-fintech-2-5-yrs-1523999");
    expect(jobs[0]!.hints).toMatchObject({ company: "Coralbay Commerce", location: ["Bengaluru"], experienceMinYears: 3, experienceMaxYears: 7 });
    expect(jobs[2]!.hints.location).toEqual(["Hyderabad", "Chennai"]);
    const [pm] = parse("info@iimjobs.com", { html: fixture("iimjobs-single.html") }).jobs;
    expect(pm).toMatchObject({ externalId: "hirist:iimjobs-1234567", attribution: "iimjobs job alert (your email)" });
    expect(pm!.hints).toMatchObject({ company: "Marigold Fintech", location: ["Mumbai"], salaryMin: 3_000_000, salaryMax: 4_500_000 });
  });
});

// ---------------------------------------------------------------- privacy and robustness

describe("privacy and robustness", () => {
  it("keeps raw payloads to small metadata and job text free of email content", () => {
    const subject = "Asha, 3 new jobs for python developer";
    for (const f of FIXTURES) {
      const res = parseJobAlertEmail({ ...mail(f.from, f.kind === "html" ? { html: fixture(f.file) } : { text: fixture(f.file) }), subject });
      for (const j of res.jobs) {
        expect(Object.keys(j.raw).sort()).toEqual(["jobId", "kind", "platform", "receivedAt", "senderDomain"]);
        const raw = JSON.stringify(j.raw);
        expect(raw).not.toMatch(/Asha|python developer|example\.test|fixture@/i);
        expect(j.text).not.toMatch(/Asha|asha@|intended for|unsubscribe|otpToken|midToken/i);
        expect(`${j.sourceUrl}`).not.toMatch(/[?&](otpToken|midToken|midSig|trackingId|refId|trk\w*|eid|tk|alid|bb|tmtk|qd|rd|sid|xp|px|src|utm_\w+|jrtk|guid|cb|uid|email_uid|token)=/i);
      }
      expect(res.notes.join(" ")).not.toMatch(/Asha|python developer/i);
    }
  });

  it("never throws on empty or malformed input", () => {
    const from = "jobalerts-noreply@linkedin.com";
    // parseJobAlertEmail catches everything, so "no jobs" alone would also pass after a crash: check the notes.
    const read = (parts: Parameters<typeof mail>[1]) => {
      const res = parse(from, parts);
      expect(res.notes).not.toContain("the email could not be read");
      return res;
    };
    expect(read({}).jobs).toEqual([]);
    expect(read({ html: "", text: "" }).jobs).toEqual([]);
    expect(read({ html: "<<<<>>>> <a href='https://www.linkedin.com/comm/jobs/view/4312345601/' <b>Senior dev" }).jobs.length).toBeLessThanOrEqual(1);
    expect(read({ html: "<table><tr><td><a href=\"https://www.linkedin.com/comm/jobs/view/4312345601/\">Senior Python Developer</td></table>" }).jobs).toHaveLength(1);
    expect(read({ html: "<!-- unclosed comment <a href='https://www.linkedin.com/comm/jobs/view/4312345601/'>x</a>" }).jobs).toEqual([]);
    expect(read({ html: "<a href='https://www.linkedin.com/comm/jobs/view/4312345601/'>View job</a>" }).notes).toContain("job links were found but no job cards could be read");
    expect(read({ html: "<a href=\"https://www.linkedin.com/comm/jobs/view/4312345601/\" class='x><b>T</b></a></a></a><a href=>" }).jobs.length).toBeLessThanOrEqual(1);
    expect(read({ text: "View job: https://www.linkedin.com/comm/jobs/view/4312345601/\n\n---------\n\n\n", html: "</td></tr></table></body>" }).jobs).toEqual([]);
    expect(parseJobAlertEmail(null as unknown as AlertEmail)).toMatchObject({ platform: null, jobs: [] });
    expect(parseJobAlertEmail({ from: 42, subject: null, html: 7, text: {}, date: "x", messageId: null } as unknown as AlertEmail).jobs).toEqual([]);
    expect(parseJobAlertEmail({ from, subject: "x", html: 7, text: {}, date: new Date("nope"), messageId: null } as unknown as AlertEmail).jobs).toEqual([]);
  });

  it("survives deeply nested markup and ignores HTML over 1 MB (text part still used)", () => {
    const from = "jobalerts-noreply@linkedin.com";
    const deep = `${"<div>".repeat(5000)}<a class="font-bold" href="https://www.linkedin.com/comm/jobs/view/4312345601/">Senior Python Developer</a><p>Acme &middot; Pune</p>${"</div>".repeat(5000)}`;
    const nested = parse(from, { html: deep });
    expect(nested.jobs.map((j) => j.hints.title)).toEqual(["Senior Python Developer"]);
    const huge = `<p>${"x".repeat(1_100_000)}</p>${fixture("linkedin-digest.html")}`;
    const res = parse(from, { html: huge, text: fixture("linkedin-digest.txt") });
    expect(res.notes).toContain("HTML part over 1 MB was ignored");
    expect(res.jobs).toHaveLength(3);
  });

  it("caps a mail at 50 jobs and dedupes repeated job ids", () => {
    const card = (i: number) =>
      `<tr><td data-test-id="job-card"><a class="font-bold" href="https://www.linkedin.com/comm/jobs/view/${4300000000 + i}/?otpToken=X">Engineer ${i}</a><p>Company ${i} &middot; Pune, Maharashtra, India</p></td></tr>`;
    const html = `<table>${Array.from({ length: 60 }, (_, i) => card(i)).join("")}${card(3)}${card(3)}</table>`;
    const res = parse("jobalerts-noreply@linkedin.com", { html });
    expect(res.jobs).toHaveLength(50);
    expect(new Set(res.jobs.map((j) => j.externalId)).size).toBe(50);
    expect(res.notes).toContain("only the first 50 jobs were kept");
  });

  it("parses decoded quoted-printable .eml parts and a forwarded body with the original HTML", async () => {
    const eml = await simpleParser(fixture("linkedin-digest.eml"));
    const res = parseJobAlertEmail({ from: eml.from!.text, subject: eml.subject ?? "", html: eml.html || null, text: eml.text ?? null, date: eml.date ?? null, messageId: eml.messageId ?? null });
    expect(res.jobs.map((j) => j.externalId)).toEqual(["linkedin:4312345601", "linkedin:4312345602", "linkedin:4312345603"]);
    // A Gmail "Fwd:" body keeps the original HTML under a quoted header block (sender resolved upstream).
    const fwd = await simpleParser(fixture("naukri-forwarded.eml"));
    const jobs = parseJobAlertEmail({ from: "naukrialerts@naukri.com", subject: fwd.subject ?? "", html: fwd.html || null, text: fwd.text ?? null, date: fwd.date ?? null, messageId: null }).jobs;
    expect(jobs).toHaveLength(3);
    for (const j of jobs) expect(j.text).not.toMatch(/asha@example\.test|Forwarded message|Subject:/);
  });

  it("guesses the site of a pasted alert only from several job links", () => {
    expect(detectAlertPlatformFromLinks(fixture("naukri-recommended.html"), null)).toBe("NAUKRI");
    expect(detectAlertPlatformFromLinks(null, fixture("indeed-digest.txt"))).toBe("INDEED");
    expect(detectAlertPlatformFromLinks(fixture("naukri-recruiter.html"), null)).toBeNull(); // a single job
    expect(detectAlertPlatformFromLinks("<a href='https://example.test/jobs/1'>x</a>", "no links")).toBeNull();
  });
});

// ---------------------------------------------------------------- adversarial review

describe("hostile and tricky alerts", () => {
  const L = "jobalerts-noreply@linkedin.com";
  const lj = (i: number) => `https://www.linkedin.com/comm/jobs/view/${4300000000 + i}/?otpToken=FAKEOTP`;
  const under1mb = (unit: string, prefix = "", suffix = "") => prefix + unit.repeat(Math.floor((990_000 - prefix.length - suffix.length) / unit.length)) + suffix;
  /** Wall time of one parse; the budget is far above normal (<200 ms) and far below a backtracking blow-up. */
  const timed = <T>(fn: () => T): { res: T; ms: number } => {
    const t = performance.now();
    const res = fn();
    return { res, ms: performance.now() - t };
  };

  it("parses 1 MB pathological HTML and text parts in bounded time", () => {
    const card = `<div><a class="font-bold" href="${lj(1)}">Senior Engineer</a><p>Acme · Pune</p>`;
    const cases: [string, Parameters<typeof mail>[1], string?][] = [
      // "view details" also parses as "view" + "details": a run of them used to backtrack exponentially.
      ["button-word run in a card line", { html: under1mb("<p>x</p>", `${card}<p>${"View details ".repeat(30)}x</p>`, "</div>") }],
      ["button-word run in an Indeed text card", { text: `Python Developer\nAcme - Pune\n${"View details ".repeat(30)}x\nhttps://in.indeed.com/rc/clk?jk=3f2a9c1b7e5d4a60\n` }, '"Indeed" <donotreply@jobalert.indeed.com>'],
      ["300 nested job anchors around 900 KB of text", { html: `${Array.from({ length: 300 }, (_, i) => `<a href="${lj(i)}"><b>T${i}</b>`).join("")}${"word ".repeat(180_000)}` }],
      ["2000 job links over one big text block", { html: `<div>${Array.from({ length: 2000 }, (_, i) => `<a href="${lj(i)}">Engineer ${i}</a>`).join("")}${"x ".repeat(400_000)}</div>` }],
      ["unclosed quotes in every tag", { html: under1mb(`<a x=">`) }],
      ["attribute quote bomb", { html: under1mb('x="', `<a href="${lj(1)}" `, ">T</a>") }],
      ["open divs past the depth cap", { html: under1mb("<div>") }],
      ["stray < characters", { html: under1mb("<a ", "", ">") }],
      ["unclosed raw-text tags", { html: under1mb("<script>a") }],
      ["entity soup", { html: under1mb("&#99999999;&abcdefghijklmnopqrstuvwxyzabcdef", card, "</div>") }],
      ["text part of blank lines", { text: under1mb("\n", "x") }],
      ["text part of rules", { text: under1mb("--------\n") }],
      ["job URLs without line breaks", { text: under1mb("https://www.linkedin.com/comm/jobs/view/4300000001/ ") }],
    ];
    for (const [name, parts, from] of cases) {
      const { res, ms } = timed(() => parse(from ?? L, parts));
      expect(res.notes, name).not.toContain("the email could not be read");
      expect(ms, name).toBeLessThan(1500);
    }
    // Overlapping "fwd?|fw" prefixes in the application-status check used to backtrack on "Fw: Fw: ...".
    const { ms } = timed(() => parse(L, { html: card, subject: `${"Fw: ".repeat(30)}x` }));
    expect(ms).toBeLessThan(1500);
  });

  it("mixed-provider digest: only the mail's own site (plus Indeed/Glassdoor), and no text leaks between cards", () => {
    const html = fixture("mixed-digest.html");
    const { jobs } = parse('"Indeed" <donotreply@jobalert.indeed.com>', { html });
    // The Glassdoor listing of the Indeed job folds into the Indeed card (same title, company and city).
    expect(jobs.map((j) => j.provider)).toEqual(["INDEED", "GLASSDOOR"]);
    expect(jobs[0]).toMatchObject({ externalId: "indeed:3f2a9c1b7e5d4a60", attribution: "Indeed job alert (your email)" });
    expect(jobs[0]!.hints).toMatchObject({ title: "Python Developer", company: "Cobalt Byte Labs Pvt Ltd", location: ["Bengaluru"] });
    expect(jobs[1]!.externalId).toMatch(/^glassdoor:h-[0-9a-f]{16}$/);
    expect(jobs[1]!.hints).toMatchObject({ title: "Data Scientist", company: "Tidewater Analytics", location: ["Pune"] });
    for (const j of jobs) expect(j.text).not.toMatch(/Foreign Company|Only Role|Delhi|Mumbai|Asha|Easily/);

    // The same mail from LinkedIn or Naukri keeps only that site's card, still bounded by the others.
    const li = parse(L, { html }).jobs;
    expect(li.map((j) => j.externalId)).toEqual(["linkedin:4312345699"]);
    expect(li[0]!.hints).toMatchObject({ company: "Foreign Company One", location: ["Delhi"] });
    expect(li[0]!.text).not.toMatch(/Cobalt|Python Developer|Bengaluru/);
    const nk = parse("naukrialerts@naukri.com", { html }).jobs;
    expect(nk.map((j) => j.externalId)).toEqual(["naukri:220926509999"]);
    expect(nk[0]!.text).not.toMatch(/Tidewater|Data Scientist|Pune/);
  });

  it("text parts without blank lines pair every link with its own card", () => {
    const naukri = parse("naukrialerts@naukri.com", {
      text: [
        "Hi Asha,",
        "Python Developer",
        "Acme Corp",
        "3-6 Yrs | Pune",
        "View: https://www.naukri.com/job-listings-python-developer-acme-pune-3-to-6-years-220926500001?src=FAKE",
        "Data Engineer",
        "Beta Corp",
        "2-5 Yrs | Mumbai",
        "View: https://www.naukri.com/job-listings-data-engineer-beta-mumbai-2-to-5-years-220926500002?src=FAKE",
      ].join("\n"),
    }).jobs;
    expect(naukri.map((j) => [j.externalId, j.hints.title, j.hints.company, j.hints.location])).toEqual([
      ["naukri:220926500001", "Python Developer", "Acme Corp", ["Pune"]],
      ["naukri:220926500002", "Data Engineer", "Beta Corp", ["Mumbai"]],
    ]);
    // "Title: <url>" lines start their card; the separator does not stay in the title.
    const inline = parse("naukrialerts@naukri.com", {
      text: "Jobs for you\nPython Developer: https://www.naukri.com/job-listings-a-220926500001\nAcme Corp\nData Engineer: https://www.naukri.com/job-listings-b-220926500002\nBeta Corp\n",
    }).jobs;
    expect(inline.map((j) => [j.hints.title, j.hints.company])).toEqual([
      ["Python Developer", "Acme Corp"],
      ["Data Engineer", "Beta Corp"],
    ]);
    const indeed = parse('"Indeed" <donotreply@jobalert.indeed.com>', {
      text: "Python Developer\nCobalt Byte Labs - Bengaluru, Karnataka\nJust posted\nhttps://in.indeed.com/rc/clk?jk=3f2a9c1b7e5d4a60&tk=FAKETK1\nData Engineer\nMarigold Fintech - Pune\nhttps://in.indeed.com/rc/clk?jk=9b1e04c7a2d85f31&tk=FAKETK2\n",
    }).jobs;
    expect(indeed.map((j) => [j.externalId, j.hints.title, j.hints.company])).toEqual([
      ["indeed:3f2a9c1b7e5d4a60", "Python Developer", "Cobalt Byte Labs"],
      ["indeed:9b1e04c7a2d85f31", "Data Engineer", "Marigold Fintech"],
    ]);
    for (const j of [...naukri, ...inline, ...indeed]) expect(j.text).not.toMatch(/https?:|FAKETK|src=|Asha/);
  });

  it("never turns the greeting, the reader's name or a digest intro into job fields", () => {
    const linkedin = parse(L, {
      text: `Asha, 3 new jobs for python developer\nHand-picked from your saved search\n\nSenior Python Developer\nNorthwind Analytics\nBengaluru, Karnataka, India (Hybrid)\nView job: ${lj(1)}\n\n----------------\n\nThis email was intended for Asha Example (Engineer)\n`,
    }).jobs;
    expect(linkedin.map((j) => [j.hints.title, j.hints.company, j.hints.location])).toEqual([["Senior Python Developer", "Northwind Analytics", ["Bengaluru"]]]);
    const [wellfound] = parse("talent@wellfound.com", {
      html: `<div>Asha, a new job matches your preferences</div><div style="font-weight:700">Staff Data Engineer</div><span>Lumen Ledger</span><div>Remote · Full-time</div><a href="https://links.wellfound.com/s/c/FAKETOKEN01/1" style="background-color:#000">Learn more</a>`,
    }).jobs;
    expect(wellfound!.hints).toMatchObject({ title: "Staff Data Engineer", company: "Lumen Ledger", workMode: "remote" });
    const glassdoor = parse("noreply@glassdoor.com", {
      html: `<table><tr><td><p>Asha, jobs for Data Scientist in Bengaluru</p><a href="https://www.glassdoor.co.in/partner/jobListing.htm?jobListingId=1009876543210">Data Scientist</a><div>Bengaluru</div></td></tr></table><table><tr><td><div>Beta Labs</div><a href="https://www.glassdoor.co.in/partner/jobListing.htm?jobListingId=1009876543299">ML Engineer</a><div>Pune</div></td></tr></table>`,
    }).jobs;
    expect(glassdoor.map((j) => j.hints.company)).toEqual([undefined, "Beta Labs"]);
    // A greeting by role is not a name: the matching jobs are kept.
    const role = parse("naukrialerts@naukri.com", {
      html: `<p>Hello Python Developer,</p><table><tr><td><a href="https://www.naukri.com/job-listings-a-220926500001">Python Developer</a><p>Acme Corp</p></td></tr><tr><td><a href="https://www.naukri.com/job-listings-b-220926500002">Senior Python Developer</a><p>Beta Corp</p></td></tr></table>`,
    }).jobs;
    expect(titles(role)).toEqual(["Python Developer", "Senior Python Developer"]);
    for (const j of [...linkedin, wellfound!, ...glassdoor]) expect(JSON.stringify({ hints: j.hints, text: j.text })).not.toMatch(/Asha|new job|saved search|jobs for/i);
  });

  it("opaque click-through links need a job-shaped anchor, and a title alone never merges two jobs", () => {
    const opaque = (token: string, text: string, style = "") => `<a href="https://links.wellfound.com/s/c/${token}/1"${style ? ` style="${style}"` : ""}>${text}</a>`;
    const btn = "background-color:#000;color:#fff";
    const { jobs } = parse("team@hi.wellfound.com", {
      html: `<table><tr><td><div style="font-weight:700">Software Engineer</div>${opaque("TOKENAAAAAA", "Learn more", btn)}</td></tr></table>
<table><tr><td><div style="font-weight:700">Software Engineer</div>${opaque("TOKENBBBBBB", "Learn more", btn)}</td></tr></table>
<table><tr><td>${opaque("TOKENLOGO01", '<img alt="Wellfound" src="x">')}<p>Wellfound, 548 Market St, San Francisco</p>${opaque("TOKENPREF01", "Update preferences")} ${opaque("TOKENVIEW01", "View in browser")} ${opaque("TOKENREFER1", "Refer a friend")}</td></tr></table>`,
    });
    // Two different postings without a company stay two jobs; footer redirects are not jobs.
    expect(titles(jobs)).toEqual(["Software Engineer", "Software Engineer"]);
    expect(new Set(jobs.map((j) => j.externalId)).size).toBe(2);
    // Without a company, a Glassdoor listing keeps its own id instead of a title-only hash.
    const [gd] = parse("noreply@glassdoor.com", { html: `<a href="https://www.glassdoor.co.in/partner/jobListing.htm?jobListingId=1009876543210">Data Scientist</a>` }).jobs;
    expect(gd!.externalId).toBe("glassdoor:1009876543210");
  });

  it("keeps badges that end in a button word, and never copies visible URLs into job text", () => {
    const { jobs } = parse(L, {
      html: `<table><tr><td><a class="font-bold" href="${lj(1)}">Engineer One</a><p>Acme · Pune</p><p>Easy Apply</p><p>Copy this link: https://www.linkedin.com/comm/jobs/view/4300000001/?otpToken=SECRETOTP</p></td></tr>
<tr><td><a class="font-bold" href="${lj(2)}">Engineer Two</a><p><span>Beta</span><a href="${lj(2)}" class="btn">Apply</a></p><p>Mumbai</p></td></tr></table>`,
    });
    expect(jobs[0]!.text).toBe("Engineer One\nCompany: Acme\nLocation: Pune\nCopy this link:");
    // Inline links are separate words: "Beta" + "Apply" is not "BetaApply".
    expect(jobs[1]!.hints).toMatchObject({ company: "Beta", location: ["Mumbai"] });
  });
});

// ---------------------------------------------------------------- forwarded-email connector

describe("forwarded email connector with job-alert digests", () => {
  it("imports every job of a pasted/uploaded .eml digest", async () => {
    const raws = await CONNECTORS.email.importJobs({ payload: { raw: fixture("linkedin-digest.eml") } });
    expect(raws.map((r) => r.externalId)).toEqual(["linkedin:4312345601", "linkedin:4312345602", "linkedin:4312345603"]);
    for (const r of raws) {
      expect(r.importMethod).toBe("USER_FORWARDED_EMAIL");
      expect(r.attribution).toBe("LinkedIn job alert (forwarded)");
      expect(JSON.stringify(r.raw)).not.toMatch(/asha|python developer|Northwind Analytics - Senior/i);
    }
    const job = await CONNECTORS.email.normalize(raws[0]!);
    expect(job).toMatchObject({
      platform: "LINKEDIN",
      title: "Senior Python Developer",
      company: "Northwind Analytics",
      location: ["Bengaluru"],
      workMode: "hybrid",
      salaryMin: 1_800_000,
      importMethod: "USER_FORWARDED_EMAIL",
      sourceUrl: "https://www.linkedin.com/jobs/view/4312345601/",
      applyUrl: "https://www.linkedin.com/jobs/view/4312345601/",
      sourceExternalId: "linkedin:4312345601",
      applyMethod: "PLATFORM",
    });
  });

  it("reads the original sender of a hand-forwarded alert and never keeps the user's address", async () => {
    const raws = await CONNECTORS.email.importJobs({ payload: { raw: fixture("naukri-forwarded.eml") } });
    expect(raws.map((r) => r.externalId)).toEqual(["naukri:220926501234", "naukri:210926007788", "naukri:200926910045"]);
    expect(raws[0]!.provider).toBe("NAUKRI");
    for (const r of raws) expect(JSON.stringify(r)).not.toMatch(/asha@example\.test|jobs-fixture123/);
    const job = await CONNECTORS.email.normalize(raws[0]!);
    expect(job.experienceMinYears).toBe(3);
    expect(job.requiredSkills.map((s) => s.canonicalName)).toContain("Python");
  });

  it("imports alerts attached as .eml files (Forward as attachment)", async () => {
    const raws = await CONNECTORS.email.importJobs({ payload: { raw: fixture("alerts-attached.eml") } });
    expect(raws.filter((r) => r.provider === "INDEED")).toHaveLength(3);
    expect(raws.filter((r) => r.provider === "HIRIST")).toHaveLength(3);
  });

  it("imports a pasted digest without headers when its links clearly point at one site", async () => {
    const raws = await CONNECTORS.email.importJobs({ payload: { raw: fixture("indeed-digest.txt") } });
    expect(raws).toHaveLength(3);
    expect(raws[0]).toMatchObject({ provider: "INDEED", externalId: "indeed:3f2a9c1b7e5d4a60", importMethod: "USER_FORWARDED_EMAIL" });
  });

  it("keeps the single-job path for ordinary emails, without the subject in raw", async () => {
    const eml = readFileSync(join(here, "fixtures", "naukri-alert.eml"), "utf8");
    const raws = await CONNECTORS.email.importJobs({ payload: { raw: eml } });
    expect(raws).toHaveLength(1);
    expect(raws[0]!.raw).toMatchObject({ kind: "forwarded_email", fromDomain: "demo-naukri.example" });
    expect(JSON.stringify(raws[0]!.raw)).not.toMatch(/Frontend Engineer at Pixelwave|candidate@example\.test/);
    const hr = await CONNECTORS.email.importJobs({ payload: { raw: readFileSync(join(here, "fixtures", "hr-email.txt"), "utf8") } });
    expect(hr).toHaveLength(1);
    expect(hr[0]!.hints.title).toBe("Full-Stack Developer");
  });

  const eml = (headers: Record<string, string>, body: string, type = "text/html") =>
    [
      ...Object.entries({ To: "asha@example.test", "Message-ID": "<m1@example.test>", Date: "Thu, 24 Sep 2026 06:00:00 +0000", ...headers }).map(([k, v]) => `${k}: ${v}`),
      "MIME-Version: 1.0",
      `Content-Type: ${type}; charset=utf-8`,
      "",
      body,
      "",
    ].join("\r\n");
  const lj = (i: number) => `https://www.linkedin.com/comm/jobs/view/${4300000000 + i}/?otpToken=FAKEOTP`;
  const twoCards = `<table><tr><td><a class="font-bold" href="${lj(1)}">Engineer One</a><p>Acme · Pune</p></td></tr><tr><td><a class="font-bold" href="${lj(2)}">Engineer Two</a><p>Beta · Mumbai</p></td></tr></table>`;

  it("a job site's notification mail is never read as an alert, even with job links", async () => {
    const raws = await CONNECTORS.email.importJobs({ payload: { raw: eml({ From: "LinkedIn <messages-noreply@linkedin.com>", Subject: "Priya sent you a message" }, twoCards) } });
    // Old single-job path (the user pasted it), not two alert jobs guessed from the links.
    expect(raws).toHaveLength(1);
    expect(raws[0]!.raw).toMatchObject({ kind: "forwarded_email" });
  });

  it("reads the original sender like a header: a spoofed display name does not count, Outlook's [mailto:] does", async () => {
    const forward = (fromLine: string) =>
      eml(
        { From: "Asha Example <asha@example.test>", Subject: "Fwd: jobs" },
        `---------- Forwarded message ---------\r\nFrom: ${fromLine}\r\nSubject: jobs\r\n\r\nSenior Python Developer\r\nNorthwind Analytics\r\nPune, Maharashtra, India\r\nView job: ${lj(1)}\r\n`,
        "text/plain",
      );
    const spoofed = await CONNECTORS.email.importJobs({ payload: { raw: forward('"jobalerts-noreply@linkedin.com" <attacker@evil.test>') } });
    expect(spoofed.map((r) => r.raw.kind)).toEqual(["forwarded_email"]);
    expect(spoofed[0]!.attribution).not.toMatch(/LinkedIn/);
    const outlook = await CONNECTORS.email.importJobs({ payload: { raw: forward("LinkedIn Job Alerts [mailto:jobalerts-noreply@linkedin.com]") } });
    expect(outlook.map((r) => [r.externalId, r.attribution])).toEqual([["linkedin:4300000001", "LinkedIn job alert (forwarded)"]]);
    // HTML-only Gmail forward of a one-job alert (no text part; too few links to guess the site).
    const gmailHtml = eml(
      { From: "Asha Example <asha@example.test>", Subject: "Fwd: jobs" },
      `<div class="gmail_attr">---------- Forwarded message ---------<br>From: <strong class="gmail_sendername">LinkedIn Job Alerts</strong> <span>&lt;<a href="mailto:jobalerts-noreply@linkedin.com">jobalerts-noreply@linkedin.com</a>&gt;</span><br>Subject: jobs<br></div>
<table><tr><td><a class="font-bold" href="${lj(1)}">Senior Python Developer</a><p>Northwind Analytics · Pune, Maharashtra, India</p></td></tr></table>`,
    );
    const html = await CONNECTORS.email.importJobs({ payload: { raw: gmailHtml } });
    expect(html.map((r) => [r.externalId, r.hints.company])).toEqual([["linkedin:4300000001", "Northwind Analytics"]]);
    const spoofedHtml = gmailHtml
      .replace('<strong class="gmail_sendername">LinkedIn Job Alerts</strong>', '<strong class="gmail_sendername">jobalerts-noreply@linkedin.com</strong>')
      .replace(/mailto:jobalerts-noreply@linkedin\.com">jobalerts-noreply@linkedin\.com/, 'mailto:attacker@evil.test">attacker@evil.test');
    const fake = await CONNECTORS.email.importJobs({ payload: { raw: spoofedHtml } });
    expect(fake.map((r) => r.raw.kind)).toEqual(["forwarded_email"]);
  });

  it("does not take a job title from a subject that greets the reader", async () => {
    const raws = await CONNECTORS.email.importJobs({
      payload: { raw: eml({ From: "Careers <careers@acme.example>", Subject: "Asha, a new opening for you" }, "We are hiring a Backend Engineer in Pune. Apply here: https://acme.example/jobs/1", "text/plain") },
    });
    expect(raws).toHaveLength(1);
    expect(JSON.stringify(raws[0]!.hints)).not.toMatch(/Asha/);
  });

  it("stays fast on 1 MB of blank lines or broken markup", async () => {
    for (const raw of [`A job for you\n${"\n".repeat(990_000)}x`, `A job for you\n${" \n".repeat(490_000)}x`, `Hello there ${"<".repeat(990_000)}`]) {
      const t = performance.now();
      await CONNECTORS.email.importJobs({ payload: { raw } }).catch(() => []);
      expect(performance.now() - t).toBeLessThan(2000);
    }
  });
});
