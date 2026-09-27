import { describe, expect, it, vi } from "vitest";
import { normalizeRawJob } from "../src/connectors/normalize";
import {
  BOARD_ADAPTERS,
  FIND_BOARDS_DEADLINE_MS,
  MAX_BOARD_PROBES,
  SUGGESTED_COMPANIES,
  boardNameMatches,
  buildProbePlan,
  detectBoardFromUrl,
  detectUnsupportedPortal,
  findCompanyBoards,
  getBoardAdapter,
  lookupSuggestedCompanies,
  slugCandidatesFor,
} from "../src/feeds/boards";
import { FeedProviderError, type BoardAdapter, type BoardProbe } from "../src/feeds/types";

// ---------------------------------------------------------------- helpers

type Handler = (url: URL) => Response | Promise<Response>;

/** Fetch mock: first matching route wins; unmatched URLs get a 404. Tracks calls and concurrency. */
function mockFetch(routes: [RegExp, Handler][]) {
  const calls: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await new Promise((r) => setTimeout(r, 1));
      for (const [re, handler] of routes) if (re.test(url)) return await handler(new URL(url));
      return new Response("Not Found", { status: 404 });
    } finally {
      inFlight--;
    }
  }) as typeof globalThis.fetch;
  return {
    fetch,
    calls,
    get maxInFlight() {
      return maxInFlight;
    },
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const adapter = (id: string): BoardAdapter => {
  const a = getBoardAdapter(id);
  if (!a) throw new Error(`missing adapter ${id}`);
  return a;
};

// ---------------------------------------------------------------- registry + directory

describe("board registry and seed directory", () => {
  it("lists the ATS adapters in probe order", () => {
    expect(BOARD_ADAPTERS.map((a) => a.id)).toEqual(["greenhouse", "lever", "ashby", "smartrecruiters", "workable", "recruitee"]);
    expect(getBoardAdapter("lever")?.label).toBe("Lever");
    expect(getBoardAdapter("workday")).toBeNull();
  });

  it("seeds the 31 live-verified India companies with exact slugs", () => {
    expect(SUGGESTED_COMPANIES).toHaveLength(31);
    const ids = new Set(BOARD_ADAPTERS.map((a) => a.id));
    for (const c of SUGGESTED_COMPANIES) {
      expect(ids.has(c.provider)).toBe(true);
      expect(c.indiaJobs).toBeGreaterThan(0);
    }
    expect(new Set(SUGGESTED_COMPANIES.map((c) => `${c.provider}:${c.slug.toLowerCase()}`)).size).toBe(31);
    expect(SUGGESTED_COMPANIES).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Razorpay", provider: "greenhouse", slug: "razorpaysoftwareprivatelimited", indiaJobs: 20 }),
        expect.objectContaining({ name: "Lionbridge", provider: "lever", slug: "lionbridge" }),
        expect.objectContaining({ name: "WisdomAI", provider: "ashby", slug: "Wisdom-AI" }),
        expect.objectContaining({ name: "Bosch Group", provider: "smartrecruiters", slug: "BoschGroup", indiaJobs: 502 }),
        expect.objectContaining({ name: "Mercari India", provider: "workable", slug: "mercari-india" }),
        expect.objectContaining({ name: "Fulfil.io", provider: "recruitee", slug: "fulfilio" }),
      ]),
    );
  });

  it("looks companies up by name or alias, ignoring case, spaces and legal suffixes", () => {
    expect(lookupSuggestedCompanies("razorpay").map((c) => c.slug)).toEqual(["razorpaysoftwareprivatelimited"]);
    expect(lookupSuggestedCompanies("  RAZORPAY Software Pvt. Ltd. ").map((c) => c.slug)).toEqual(["razorpaysoftwareprivatelimited"]);
    expect(lookupSuggestedCompanies("hevo").map((c) => c.slug)).toEqual(["hevodata"]);
    expect(lookupSuggestedCompanies("Hevo Data").map((c) => c.slug)).toEqual(["hevodata"]);
    expect(lookupSuggestedCompanies("sarvamai").map((c) => c.slug)).toEqual(["sarvam"]);
    expect(lookupSuggestedCompanies("Wisdom AI").map((c) => c.slug)).toEqual(["Wisdom-AI"]);
    expect(lookupSuggestedCompanies("pocketfm").map((c) => c.slug)).toEqual(["pocketfm"]);
    expect(lookupSuggestedCompanies("Anysphere").map((c) => c.slug)).toEqual(["cursor"]);
    expect(lookupSuggestedCompanies("Swiggy")).toEqual([]);
  });
});

// ---------------------------------------------------------------- URL detection

describe("detectBoardFromUrl", () => {
  it.each([
    ["https://boards.greenhouse.io/acme", "greenhouse", "acme"],
    ["https://job-boards.greenhouse.io/acme/jobs/4970739101", "greenhouse", "acme"],
    ["https://job-boards.eu.greenhouse.io/groww/jobs/4970739101", "greenhouse", "groww"],
    ["https://boards.greenhouse.io/embed/job_app?token=123&for=acme", "greenhouse", "acme"],
    ["https://boards.greenhouse.io/embed/job_board/js?for=razorpaysoftwareprivatelimited", "greenhouse", "razorpaysoftwareprivatelimited"],
    ["https://boards-api.greenhouse.io/v1/boards/inmobi/jobs?content=true", "greenhouse", "inmobi"],
    ["https://jobs.lever.co/acme/fa6c100a-0fe0-4892-a8a3-8d2169d5005e/apply", "lever", "acme"],
    ["https://jobs.lever.co/CRED", "lever", "cred"],
    ["https://jobs.eu.lever.co/lionbridge", "lever", "lionbridge"],
    ["https://api.lever.co/v0/postings/Paytm?mode=json", "lever", "paytm"],
    ["jobs.lever.co/meesho", "lever", "meesho"],
    ["https://jobs.ashbyhq.com/Wisdom-AI/7a0c2c52-4d1e-4b61-9a5a-0d3c9f1a2b3c", "ashby", "Wisdom-AI"],
    ["https://api.ashbyhq.com/posting-api/job-board/sarvam?includeCompensation=true", "ashby", "sarvam"],
    ["https://careers.smartrecruiters.com/Acme", "smartrecruiters", "Acme"],
    ["https://jobs.smartrecruiters.com/Freshworks/744000151905570-lead-program-management", "smartrecruiters", "Freshworks"],
    ["https://api.smartrecruiters.com/v1/companies/BoschGroup/postings", "smartrecruiters", "BoschGroup"],
    ["https://apply.workable.com/mercari-india/j/0A54F0628F/", "workable", "mercari-india"],
    ["https://apply.workable.com/api/v1/widget/accounts/blue-machines-ai?details=true", "workable", "blue-machines-ai"],
    ["https://www.workable.com/api/accounts/mercari-india?details=true", "workable", "mercari-india"],
    ["https://acme.workable.com/", "workable", "acme"],
    ["https://signode.recruitee.com/o/senior-accounts-executive", "recruitee", "signode"],
  ])("%s -> %s:%s", (url, provider, slug) => {
    expect(detectBoardFromUrl(url)).toEqual({ provider, slug });
  });

  it.each([
    // Workable job links don't name the account.
    "https://apply.workable.com/j/7E1007642A",
    // Greenhouse on a company domain: the board token is unknown.
    "https://www.rubrik.com/company/careers/departments/job.7820794?gh_jid=7820794",
    "https://www.linkedin.com/jobs/view/4012345678",
    "https://www.naukri.com/job-listings-react-developer-acme-bengaluru-3-to-6-years-250925000123",
    "https://boards.greenhouse.io/",
    "https://www.workable.com/",
    "https://app.recruitee.com/",
    "https://careers.smartrecruiters.com/oneclick-ui/company/Acme",
    "ftp://jobs.lever.co/acme",
    "jobs lever co",
    "",
  ])("%s -> null", (url) => {
    expect(detectBoardFromUrl(url)).toBeNull();
  });
});

describe("detectUnsupportedPortal", () => {
  it.each([
    ["https://acme.keka.com/careers/jobdetails/12345", "Keka"],
    ["https://acme.darwinbox.in/ms/candidate/careers", "Darwinbox"],
    ["https://acme.freshteam.com/jobs", "Freshteam"],
    ["https://acme.wd3.myworkdayjobs.com/en-US/External/job/Bangalore/SDE_R-123", "Workday"],
    ["https://sportskeeda.zohorecruit.in/jobs/Careers", "Zoho Recruit"],
    ["https://www.linkedin.com/jobs/view/4012345678", "LinkedIn"],
    ["https://www.naukri.com/job-listings-react-developer-250925000123", "Naukri"],
    ["https://in.indeed.com/viewjob?jk=abc123", "Indeed"],
  ])("%s -> %s", (url, name) => {
    const result = detectUnsupportedPortal(url);
    expect(result?.name).toBe(name);
    expect(result?.advice).toMatch(/alert/i);
    expect(result?.advice).toMatch(/browser extension/i);
  });

  it("points job sites to alert emails and never suggests scraping", () => {
    const naukri = detectUnsupportedPortal("naukri.com/some-job");
    expect(naukri?.advice).toContain("Naukri job-alert emails");
    expect(naukri?.advice).toContain("never scrapes");
  });

  it("does not flag supported boards or ordinary sites", () => {
    expect(detectUnsupportedPortal("https://jobs.lever.co/acme")).toBeNull();
    expect(detectUnsupportedPortal("https://www.razorpay.com/jobs")).toBeNull();
    expect(detectUnsupportedPortal("not a url at all")).toBeNull();
  });
});

// ---------------------------------------------------------------- slug candidates

describe("slug candidates", () => {
  it("includes Indian legal-entity forms for Greenhouse (Razorpay's real token)", () => {
    const candidates = slugCandidatesFor("greenhouse", "Razorpay");
    expect(candidates.slice(0, 2)).toEqual(["razorpay", "razorpaysoftwareprivatelimited"]);
    expect(candidates).toContain("razorpaytechnologiesprivatelimited");
    expect(candidates.length).toBeLessThanOrEqual(8);
    expect(adapter("greenhouse").slugCandidates("Razorpay")).toEqual(candidates);
  });

  it("builds compact, hyphenated, brand and suffix variants", () => {
    expect(slugCandidatesFor("workable", "Blue Machines AI")).toEqual(
      expect.arrayContaining(["bluemachinesai", "blue-machines-ai", "blue-machines-india", "bluemachines"]),
    );
    expect(slugCandidatesFor("workable", "Mercari India").slice(0, 2)).toEqual(["mercariindia", "mercari-india"]);
    expect(slugCandidatesFor("ashby", "WisdomAI")).toEqual(expect.arrayContaining(["wisdomai", "wisdom-ai", "wisdom"]));
    expect(slugCandidatesFor("lever", "Hevo Data")).toEqual(expect.arrayContaining(["hevodata", "hevo-data", "hevodataindia", "hevodatahq"]));
    expect(slugCandidatesFor("greenhouse", "Zeta Technologies Pvt Ltd")).toEqual(
      expect.arrayContaining(["zetatechnologies", "zeta", "zetatechnologiesprivatelimited"]),
    );
    expect(slugCandidatesFor("recruitee", "Fulfil.io")[0]).toBe("fulfilio");
    expect(slugCandidatesFor("lever", "Café Coffee Day")[0]).toBe("cafecoffeeday");
    for (const style of ["greenhouse", "lever", "ashby", "smartrecruiters", "workable", "recruitee"] as const) {
      const list = slugCandidatesFor(style, "Some Very Long Company Name Technologies India");
      expect(list.length).toBeLessThanOrEqual(8);
      expect(new Set(list).size).toBe(list.length);
    }
    expect(slugCandidatesFor("greenhouse", "  ...  ")).toEqual([]);
  });

  it("plans at most MAX_BOARD_PROBES probes, best guess per provider first", () => {
    const plan = buildProbePlan(BOARD_ADAPTERS, "Acme Robotics");
    expect(plan.length).toBeLessThanOrEqual(MAX_BOARD_PROBES);
    expect(MAX_BOARD_PROBES).toBeLessThanOrEqual(24);
    expect(plan.slice(0, 6).map((p) => p.adapter.id)).toEqual(["greenhouse", "lever", "ashby", "smartrecruiters", "workable", "recruitee"]);
    expect(plan.slice(0, 6).every((p) => p.slug === "acmerobotics")).toBe(true);
  });

  it("matches board names to the company searched for", () => {
    expect(boardNameMatches("Razorpay", "Razorpay Software Private Limited")).toBe(true);
    expect(boardNameMatches("Mercari", "Mercari, Inc. (India)")).toBe(true);
    expect(boardNameMatches("Blue Machines", "Blue Machines AI")).toBe(true);
    expect(boardNameMatches("Acme Robotics", null)).toBe(true);
    expect(boardNameMatches("Acme Robotics", "Totally Different Inc")).toBe(false);
  });
});

// ---------------------------------------------------------------- Greenhouse

const GH_CONTENT =
  "&lt;div class=&quot;content-intro&quot;&gt;&lt;p&gt;Razorpay is one of India’s leading fintech companies.&lt;/p&gt;&lt;/div&gt;" +
  "&lt;h3&gt;Requirements&lt;/h3&gt;&lt;ul&gt;&lt;li&gt;3+ years of React &amp;amp; TypeScript&lt;/li&gt;" +
  "&lt;li&gt;Experience with Node.js&lt;/li&gt;&lt;/ul&gt;&lt;p&gt;Latency budget &amp;lt; 50ms&amp;nbsp;p99&lt;/p&gt;";

function ghJob(id: number, location: string, over: Record<string, unknown> = {}) {
  return {
    absolute_url: `https://job-boards.greenhouse.io/razorpaysoftwareprivatelimited/jobs/${id}`,
    data_compliance: [{ type: "gdpr", requires_consent: false, requires_processing_consent: false, requires_retention_consent: false, retention_period: null }],
    internal_job_id: 4453070005,
    location: { name: location },
    metadata: [{ id: 4731492005, name: "Job Location", value: ["Bengaluru"], value_type: "multi_select" }],
    id,
    updated_at: "2026-09-24T03:50:10-04:00",
    requisition_id: "14669",
    title: "Frontend Engineer",
    company_name: "Razorpay Software Private Limited",
    first_published: "2026-09-04T05:02:55-04:00",
    language: "en",
    application_deadline: null,
    content: GH_CONTENT,
    departments: [{ id: 4024745005, name: "Engineering", child_ids: [], parent_id: 4024744005 }],
    offices: [{ id: 4009557005, name: "RazorpayX", location: null, child_ids: [], parent_id: null }],
    ...over,
  };
}

describe("Greenhouse adapter", () => {
  it("decodes the entity-escaped content once and maps full jobs", async () => {
    const m = mockFetch([
      [
        /boards-api\.greenhouse\.io\/v1\/boards\/razorpaysoftwareprivatelimited\/jobs\?content=true$/,
        () =>
          json({
            jobs: [
              ghJob(4731043005, "Bengaluru, India; Mumbai, India"),
              ghJob(4731043006, "Remote - India"),
              ghJob(4731043007, "Hybrid in Bangalore, India"),
              ghJob(4731043008, "Singapore"),
              ghJob(4731043009, "Remote", { offices: [{ id: 1, name: "SF", location: "San Francisco, California, United States" }] }),
            ],
            meta: { total: 5 },
          }),
      ],
    ]);
    const { companyName, jobs } = await adapter("greenhouse").fetchJobs("razorpaysoftwareprivatelimited", { fetch: m.fetch });
    expect(companyName).toBe("Razorpay Software Private Limited");
    expect(jobs).toHaveLength(5);
    const [multi, remote, hybrid, abroad, usRemote] = jobs;
    expect(multi).toMatchObject({
      provider: "GREENHOUSE",
      importMethod: "OFFICIAL_API",
      externalId: "greenhouse:razorpaysoftwareprivatelimited:4731043005",
      sourceUrl: "https://job-boards.greenhouse.io/razorpaysoftwareprivatelimited/jobs/4731043005",
      attribution: "Razorpay careers (Greenhouse)",
      descriptionLevel: "FULL",
      raw: { kind: "ats_board_api", provider: "greenhouse", slug: "razorpaysoftwareprivatelimited", id: "4731043005" },
      hints: {
        title: "Frontend Engineer",
        company: "Razorpay Software Private Limited",
        location: ["Bengaluru", "Mumbai"],
        applyUrl: "https://job-boards.greenhouse.io/razorpaysoftwareprivatelimited/jobs/4731043005",
        postedAt: "2026-09-04T09:02:55.000Z",
      },
    });
    expect(multi?.text).toBe(
      [
        "Razorpay is one of India’s leading fintech companies.",
        "",
        "Requirements",
        "",
        "- 3+ years of React & TypeScript",
        "- Experience with Node.js",
        "",
        "Latency budget < 50ms p99",
      ].join("\n"),
    );
    expect(multi?.text).not.toMatch(/&lt;|&amp;|<div|<li/);
    expect(remote?.hints).toMatchObject({ location: ["Remote - India"], workMode: "remote" });
    expect(hybrid?.hints).toMatchObject({ location: ["Bengaluru"], workMode: "hybrid" });
    expect(abroad?.hints.location).toEqual(["Singapore"]);
    // A bare "Remote" at a US office is not an India-remote role.
    expect(usRemote?.hints).toMatchObject({ location: ["San Francisco, California, United States"], workMode: "remote" });

    // The plain-text description drives the JD parser's requirement sections.
    const normalized = await normalizeRawJob(multi!);
    expect(normalized.requiredSkills.map((s) => s.canonicalName)).toEqual(expect.arrayContaining(["React", "TypeScript", "Node.js"]));
    expect(normalized.platform).toBe("GREENHOUSE");
    expect(normalized.location).toEqual(["Bengaluru", "Mumbai"]);
  });

  it("probes without content, confirming only boards with jobs", async () => {
    const m = mockFetch([
      [/\/boards\/groww\/jobs$/, () => json({ jobs: [ghJob(1, "Bengaluru-VTP, India", { company_name: "Groww", absolute_url: "https://job-boards.eu.greenhouse.io/groww/jobs/4970739101" })], meta: { total: 1 } })],
      [/\/boards\/emptyco\/jobs$/, () => json({ jobs: [], meta: { total: 0 } })],
      [/\/boards\/phonepe\/jobs$/, () => json({ status: 404, error: "Job not found" }, 404)],
    ]);
    const gh = adapter("greenhouse");
    expect(await gh.probe("groww", { fetch: m.fetch })).toEqual({
      provider: "greenhouse",
      slug: "groww",
      companyName: "Groww",
      jobCount: 1,
      boardUrl: "https://job-boards.eu.greenhouse.io/groww",
    });
    expect(await gh.probe("emptyco", { fetch: m.fetch })).toBeNull();
    expect(await gh.probe("phonepe", { fetch: m.fetch })).toBeNull();
    const before = m.calls.length;
    expect(await gh.probe("../../etc", { fetch: m.fetch })).toBeNull();
    expect(await gh.probe("a/../../x", { fetch: m.fetch })).toBeNull();
    expect(m.calls.length).toBe(before); // invalid tokens are never requested
    expect(m.calls.every((u) => u.startsWith("https://boards-api.greenhouse.io/v1/boards/") && !u.includes("content=true"))).toBe(true);
    await expect(gh.fetchJobs("phonepe", { fetch: m.fetch })).rejects.toMatchObject({ name: "FeedProviderError", retryable: false, status: 404 });
  });

  it("maps server errors to retryable failures", async () => {
    const m = mockFetch([[/greenhouse/, () => new Response("upstream", { status: 502 })]]);
    await expect(adapter("greenhouse").fetchJobs("groww", { fetch: m.fetch })).rejects.toMatchObject({ retryable: true, status: 502 });
  });
});

// ---------------------------------------------------------------- Lever

function leverPosting(id: string, over: Record<string, unknown> = {}) {
  return {
    additional: "<div>We offer <b>ESOPs</b>.</div>",
    additionalPlain: "We offer ESOPs.",
    categories: { commitment: "full time", department: "Engineering", location: "bengaluru", team: "Platform", allLocations: ["bengaluru"] },
    createdAt: 1787543704191,
    descriptionPlain: "CRED is a members-only club.",
    description: "<div><div>CRED is a members-only club.</div></div>",
    id,
    lists: [
      { text: "what will you do:", content: "<li>build payment rails</li><li>own reliability</li>" },
      { text: "you should apply if you have:", content: "<li>4+ years with Go</li><li>Kubernetes</li>" },
    ],
    text: "backend engineer",
    country: "IN",
    workplaceType: "onsite",
    opening: "",
    openingPlain: "",
    descriptionBody: "<div><div>CRED is a members-only club.</div></div>",
    descriptionBodyPlain: "CRED is a members-only club.",
    hostedUrl: `https://jobs.lever.co/cred/${id}`,
    applyUrl: `https://jobs.lever.co/cred/${id}/apply`,
    ...over,
  };
}

describe("Lever adapter", () => {
  it("lowercases the site, maps lists as bullets and uses the directory name", async () => {
    const m = mockFetch([
      [
        /^https:\/\/api\.lever\.co\/v0\/postings\/cred\?mode=json$/,
        () =>
          json([
            leverPosting("fa6c100a-0fe0-4892-a8a3-8d2169d5005e"),
            leverPosting("0b1c", {
              text: "Senior Backend Engineer",
              workplaceType: "remote",
              categories: { commitment: "Full-time", location: "Bengaluru", allLocations: ["Bengaluru", "Mumbai / Pune"] },
              salaryRange: { currency: "INR", interval: "per-year-salary", min: 4000000, max: 6000000 },
            }),
            leverPosting("0b1d", { salaryRange: { currency: "USD", interval: "per-hour-wage", min: 15, max: 23 } }),
          ]),
      ],
    ]);
    const { companyName, jobs } = await adapter("lever").fetchJobs("CRED", { fetch: m.fetch });
    expect(m.calls).toEqual(["https://api.lever.co/v0/postings/cred?mode=json"]);
    expect(companyName).toBe("CRED");
    const [onsite, remote, hourly] = jobs;
    expect(onsite).toMatchObject({
      provider: "LEVER",
      importMethod: "OFFICIAL_API",
      externalId: "lever:cred:fa6c100a-0fe0-4892-a8a3-8d2169d5005e",
      sourceUrl: "https://jobs.lever.co/cred/fa6c100a-0fe0-4892-a8a3-8d2169d5005e",
      attribution: "CRED careers (Lever)",
      descriptionLevel: "FULL",
      hints: {
        title: "backend engineer",
        company: "CRED",
        location: ["Bengaluru"],
        workMode: "onsite",
        employmentType: "full_time",
        applyUrl: "https://jobs.lever.co/cred/fa6c100a-0fe0-4892-a8a3-8d2169d5005e/apply",
        postedAt: new Date(1787543704191).toISOString(),
      },
    });
    expect(onsite?.text).toBe(
      [
        "CRED is a members-only club.",
        "",
        "what will you do:",
        "- build payment rails",
        "- own reliability",
        "",
        "you should apply if you have:",
        "- 4+ years with Go",
        "- Kubernetes",
        "",
        "We offer ESOPs.",
      ].join("\n"),
    );
    expect(remote?.hints).toMatchObject({
      location: ["Remote - India", "Bengaluru", "Mumbai", "Pune"],
      workMode: "remote",
      salaryMin: 4000000,
      salaryMax: 6000000,
      currency: "INR",
    });
    expect(hourly?.hints.salaryMin).toBeUndefined();
  });

  it("falls back to the EU host on a 404 and keeps foreign remote roles out of India", async () => {
    const m = mockFetch([
      [/^https:\/\/api\.lever\.co\/v0\/postings\/eurobrand/, () => json({ ok: false, error: "Document not found" }, 404)],
      [
        /^https:\/\/api\.eu\.lever\.co\/v0\/postings\/eurobrand/,
        () =>
          json([
            leverPosting("e1", { text: "Linguist", workplaceType: "remote", country: "EG", categories: { location: "Egypt", allLocations: ["Egypt"] } }),
            leverPosting("e2", { text: "Reviewer", workplaceType: "remote", country: "US", categories: { location: "Remote", allLocations: ["Remote"] } }),
            leverPosting("e3", { text: "QA Analyst", workplaceType: "remote", country: "IN", categories: { location: "Remote", allLocations: ["Remote"] } }),
          ]),
      ],
    ]);
    const lever = adapter("lever");
    const probe = await lever.probe("EuroBrand", { fetch: m.fetch });
    expect(m.calls.map((u) => new URL(u).host)).toEqual(["api.lever.co", "api.eu.lever.co"]);
    expect(probe).toEqual({ provider: "lever", slug: "eurobrand", companyName: null, jobCount: 3, boardUrl: "https://jobs.eu.lever.co/eurobrand" });

    const { jobs } = await lever.fetchJobs("eurobrand", { fetch: m.fetch });
    expect(jobs.map((j) => j.hints.location)).toEqual([["Egypt"], ["United States"], ["Remote - India"]]);
    expect(jobs.every((j) => j.hints.workMode === "remote")).toBe(true);
    expect(jobs[0]?.attribution).toBe("Eurobrand careers (Lever)");
  });

  it("returns null when neither host knows the site and throws on fetch", async () => {
    const m = mockFetch([[/lever\.co/, () => json({ ok: false, error: "Document not found" }, 404)]]);
    expect(await adapter("lever").probe("nosuchsite", { fetch: m.fetch })).toBeNull();
    expect(m.calls).toHaveLength(2);
    await expect(adapter("lever").fetchJobs("nosuchsite", { fetch: m.fetch })).rejects.toBeInstanceOf(FeedProviderError);
    const empty = mockFetch([[/api\.lever\.co/, () => json([])]]);
    expect(await adapter("lever").probe("quietco", { fetch: empty.fetch })).toBeNull();
  });
});

// ---------------------------------------------------------------- Ashby

function ashbyJob(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    title: "Solution Specialist",
    department: "Sales/GTM",
    team: "Sales/GTM",
    employmentType: "FullTime",
    location: "Bengaluru",
    shouldDisplayCompensationOnJobPostings: false,
    secondaryLocations: [],
    publishedAt: "2026-05-20T08:44:45.357+00:00",
    isListed: true,
    isRemote: false,
    workplaceType: "OnSite",
    address: { postalAddress: { addressRegion: "Karnataka", addressCountry: "India", addressLocality: "Bengaluru" } },
    jobUrl: `https://jobs.ashbyhq.com/sarvam/${id}`,
    applyUrl: `https://jobs.ashbyhq.com/sarvam/${id}/application`,
    descriptionHtml: "<h2>About Sarvam</h2><p>Sarvam is building the bedrock of Sovereign AI.</p><h2>What you'll need</h2><ul><li>Python</li></ul>",
    descriptionPlain: "ABOUT SARVAM\n\nSarvam is building the bedrock of Sovereign AI.",
    compensation: { compensationTierSummary: null, scrapeableCompensationSalarySummary: null, compensationTiers: [], summaryComponents: [] },
    ...over,
  };
}

describe("Ashby adapter", () => {
  it("skips unlisted jobs and maps remote flags and structured addresses", async () => {
    const m = mockFetch([
      [
        /api\.ashbyhq\.com\/posting-api\/job-board\/sarvam/,
        () =>
          json({
            apiVersion: "1",
            jobs: [
              ashbyJob("f3376204-1c2d-42a8-bf4a-1a0eec2fbc3c"),
              ashbyJob("hidden-1", { isListed: false, title: "Confidential role" }),
              ashbyJob("remote-in", { location: "India", isRemote: true, workplaceType: "Remote", secondaryLocations: [{ location: "United Kingdom" }] }),
              ashbyJob("remote-us", { location: "California", isRemote: true, workplaceType: "Remote", address: { postalAddress: { addressCountry: "United States" } } }),
              ashbyJob("hybrid", {
                location: "Delhi",
                workplaceType: "Hybrid",
                isRemote: null,
                compensation: {
                  compensationTierSummary: "₹30L – ₹45L",
                  summaryComponents: [{ compensationType: "Salary", interval: "1 YEAR", currencyCode: "INR", minValue: 3000000, maxValue: 4500000 }],
                },
              }),
            ],
          }),
      ],
    ]);
    const ashby = adapter("ashby");
    const probe = await ashby.probe("sarvam", { fetch: m.fetch });
    expect(probe).toEqual({ provider: "ashby", slug: "sarvam", companyName: "Sarvam AI", jobCount: 4, boardUrl: "https://jobs.ashbyhq.com/sarvam" });

    const { companyName, jobs } = await ashby.fetchJobs("sarvam", { fetch: m.fetch });
    expect(new URL(m.calls[1]!).searchParams.get("includeCompensation")).toBe("true");
    expect(companyName).toBe("Sarvam AI");
    expect(jobs.map((j) => j.externalId)).toEqual([
      "ashby:sarvam:f3376204-1c2d-42a8-bf4a-1a0eec2fbc3c",
      "ashby:sarvam:remote-in",
      "ashby:sarvam:remote-us",
      "ashby:sarvam:hybrid",
    ]);
    const [onsite, remoteIn, remoteUs, hybrid] = jobs;
    expect(onsite).toMatchObject({
      provider: "ASHBY",
      attribution: "Sarvam AI careers (Ashby)",
      sourceUrl: "https://jobs.ashbyhq.com/sarvam/f3376204-1c2d-42a8-bf4a-1a0eec2fbc3c",
      hints: {
        company: "Sarvam AI",
        location: ["Bengaluru"],
        workMode: "onsite",
        employmentType: "full_time",
        applyUrl: "https://jobs.ashbyhq.com/sarvam/f3376204-1c2d-42a8-bf4a-1a0eec2fbc3c/application",
        postedAt: "2026-05-20T08:44:45.357Z",
      },
    });
    expect(onsite?.text).toBe("About Sarvam\n\nSarvam is building the bedrock of Sovereign AI.\n\nWhat you'll need\n\n- Python");
    expect(remoteIn?.hints).toMatchObject({ location: ["Remote - India"], workMode: "remote" });
    expect(remoteUs?.hints).toMatchObject({ location: ["California"], workMode: "remote" });
    expect(hybrid?.hints).toMatchObject({ location: ["Delhi"], workMode: "hybrid", salaryMin: 3000000, salaryMax: 4500000, currency: "INR" });
  });

  it("does not confirm 200 responses with no listed jobs, or 404s", async () => {
    const m = mockFetch([
      [/job-board\/deel/, () => json({ apiVersion: "1", jobs: [] })],
      [/job-board\/stealth/, () => json({ apiVersion: "1", jobs: [ashbyJob("x", { isListed: false })] })],
      [/job-board\/zepto/, () => new Response("Not Found", { status: 404, headers: { "content-type": "text/plain" } })],
    ]);
    const ashby = adapter("ashby");
    expect(await ashby.probe("deel", { fetch: m.fetch })).toBeNull();
    expect(await ashby.probe("stealth", { fetch: m.fetch })).toBeNull();
    expect(await ashby.probe("zepto", { fetch: m.fetch })).toBeNull();
  });
});

// ---------------------------------------------------------------- SmartRecruiters

function srPosting(i: number, over: Record<string, unknown> = {}) {
  const day = String(1 + (i % 28)).padStart(2, "0");
  return {
    id: String(744000151772990 + i),
    name: `Lead Software Engineer ${i}`,
    uuid: `9709d0cf-9ab7-45b1-b913-${String(i).padStart(12, "0")}`,
    jobAdId: "28a49ff9-fcd0-4ffb-b7dc-ee17ac0a1ebe",
    defaultJobAd: true,
    refNumber: `P1005${i}`,
    company: { identifier: "Freshworks", name: "Freshworks" },
    releasedDate: `2026-${i < 20 ? "09" : "08"}-${day}T07:15:59.566Z`,
    location: { city: "Hyderabad", region: "TS", country: "in", remote: false, hybrid: false, latitude: "17.4", longitude: "78.4", fullLocation: "Hyderabad, TS, India" },
    industry: { id: "computer_software", label: "Computer Software" },
    department: {},
    function: { id: "engineering", label: "Engineering" },
    typeOfEmployment: { id: "permanent", label: "Full-time" },
    experienceLevel: { id: "mid_senior_level", label: "Mid-Senior Level" },
    customField: [],
    visibility: "PUBLIC",
    ref: `https://api.smartrecruiters.com/v1/companies/Freshworks/postings/${744000151772990 + i}`,
    language: { code: "en", label: "English" },
    ...over,
  };
}

describe("SmartRecruiters adapter", () => {
  it("treats an empty 200 as not found and confirms companies with postings", async () => {
    const m = mockFetch([
      [/companies\/nonexistentcompanyxyz123\/postings/, () => json({ offset: 0, limit: 1, totalFound: 0, content: [] })],
      [/companies\/Freshworks\/postings\?limit=1$/, () => json({ offset: 0, limit: 1, totalFound: 125, content: [srPosting(1)] })],
    ]);
    const sr = adapter("smartrecruiters");
    expect(await sr.probe("nonexistentcompanyxyz123", { fetch: m.fetch })).toBeNull();
    expect(await sr.probe("Freshworks", { fetch: m.fetch })).toEqual({
      provider: "smartrecruiters",
      slug: "Freshworks",
      companyName: "Freshworks",
      jobCount: 125,
      boardUrl: "https://careers.smartrecruiters.com/Freshworks",
    });
  });

  it("lists India postings and fetches details for at most the 40 newest", async () => {
    const postings = Array.from({ length: 45 }, (_, i) => srPosting(i, i === 3 ? { location: { city: "Bengaluru", country: "in", remote: true, fullLocation: "Bengaluru, KA, India" } } : {}));
    const detailIds: string[] = [];
    const m = mockFetch([
      [
        /companies\/Freshworks\/postings\?/,
        (url) => {
          expect(url.searchParams.get("country")).toBe("in");
          const offset = Number(url.searchParams.get("offset"));
          return json({ offset, limit: 100, totalFound: postings.length, content: postings.slice(offset, offset + 100) });
        },
      ],
      [
        /companies\/Freshworks\/postings\/(\d+)$/,
        (url) => {
          const id = url.pathname.split("/").pop()!;
          detailIds.push(id);
          return json({
            ...postings.find((p) => p.id === id),
            postingUrl: `https://jobs.smartrecruiters.com/Freshworks/${id}-lead-software-engineer`,
            applyUrl: `https://jobs.smartrecruiters.com/Freshworks/${id}-lead-software-engineer?oga=true`,
            jobAd: {
              sections: {
                companyDescription: { title: "Company Description", text: "<p>Freshworks makes it fast and easy.</p>" },
                jobDescription: { title: "Job Description", text: "<ul><li>Own the SRE roadmap</li></ul>" },
                qualifications: { title: "Qualifications", text: "<ul><li>Kubernetes</li><li>Terraform</li></ul>" },
                additionalInformation: { title: "Additional Information", text: "" },
              },
            },
            compensation: { min: 0, max: 0, currency: "USD", period: "YEARLY" },
            active: true,
          });
        },
      ],
    ]);
    const { companyName, jobs } = await adapter("smartrecruiters").fetchJobs("Freshworks", { fetch: m.fetch });
    expect(companyName).toBe("Freshworks");
    expect(jobs).toHaveLength(45);
    expect(detailIds).toHaveLength(40);
    expect(m.maxInFlight).toBeLessThanOrEqual(3);

    // The 40 newest (by releasedDate) are the ones with full descriptions.
    const newest = [...postings].sort((a, b) => b.releasedDate.localeCompare(a.releasedDate)).slice(0, 40).map((p) => p.id);
    expect(new Set(detailIds)).toEqual(new Set(newest));
    const full = jobs.filter((j) => j.descriptionLevel === "FULL");
    expect(full).toHaveLength(40);
    const withDetail = full[0]!;
    expect(withDetail).toMatchObject({
      provider: "SMARTRECRUITERS",
      importMethod: "OFFICIAL_API",
      attribution: "Freshworks careers (SmartRecruiters)",
      hints: { company: "Freshworks", location: ["Hyderabad"], employmentType: "full_time" },
    });
    expect(withDetail.externalId).toMatch(/^smartrecruiters:freshworks:\d+$/);
    expect(withDetail.hints.applyUrl).toMatch(/\?oga=true$/);
    expect(withDetail.hints.salaryMin).toBeUndefined();
    expect(withDetail.text).toContain("Qualifications\n\n- Kubernetes\n- Terraform");
    const remote = jobs.find((j) => j.externalId?.endsWith(":744000151772993"));
    expect(remote?.hints).toMatchObject({ location: ["Remote - India", "Bengaluru"], workMode: "remote" });
    const snippet = jobs.find((j) => j.descriptionLevel === "SNIPPET")!;
    expect(snippet.text).toContain("Location: Hyderabad, TS, India");
    expect(snippet.hints.applyUrl).toMatch(/^https:\/\/jobs\.smartrecruiters\.com\/Freshworks\/\d+$/);
  });
});

// ---------------------------------------------------------------- Workable

function workableJob(shortcode: string, over: Record<string, unknown> = {}) {
  return {
    title: "Engineering Manager - Backend",
    shortcode,
    code: "",
    employment_type: "Full-time",
    telecommuting: false,
    department: null,
    url: `https://apply.workable.com/j/${shortcode}`,
    shortlink: `https://apply.workable.com/j/${shortcode}`,
    application_url: `https://apply.workable.com/j/${shortcode}/apply`,
    published_on: "2025-07-28",
    created_at: "2025-07-28",
    country: "India",
    city: "Bengaluru",
    state: "",
    education: null,
    experience: "Mid-Senior level",
    function: "Management",
    industry: "Internet",
    locations: [{ country: "India", countryCode: "IN", city: "Bengaluru", region: null, hidden: false }],
    description: '<p><img src="https://workablehr.s3.amazonaws.com/uploads/photos/1.jpg"></p><p><strong>About Us</strong></p><p>Mercari is a C2C marketplace.</p>',
    ...over,
  };
}

describe("Workable adapter", () => {
  it("maps the widget API with details and keeps US remote roles as US", async () => {
    const m = mockFetch([
      [
        /apply\.workable\.com\/api\/v1\/widget\/accounts\/mercari-india\?details=true$/,
        () =>
          json({
            name: "Mercari, Inc. (India)",
            description: null,
            jobs: [
              workableJob("7E1007642A"),
              workableJob("8304968991", {
                title: "Solutions Engineer",
                telecommuting: true,
                country: "United States",
                city: "San Francisco",
                locations: [{ country: "United States", countryCode: "US", city: "San Francisco", region: "California", hidden: false }],
              }),
            ],
          }),
      ],
    ]);
    const { companyName, jobs } = await adapter("workable").fetchJobs("mercari-india", { fetch: m.fetch });
    expect(companyName).toBe("Mercari, Inc. (India)");
    expect(jobs[0]).toMatchObject({
      provider: "WORKABLE",
      importMethod: "OFFICIAL_API",
      externalId: "workable:mercari-india:7E1007642A",
      sourceUrl: "https://apply.workable.com/j/7E1007642A",
      attribution: "Mercari India careers (Workable)",
      descriptionLevel: "FULL",
      hints: {
        company: "Mercari, Inc. (India)",
        location: ["Bengaluru"],
        employmentType: "full_time",
        applyUrl: "https://apply.workable.com/j/7E1007642A/apply",
        postedAt: "2025-07-28T00:00:00.000Z",
      },
    });
    expect(jobs[0]?.text).toBe("About Us\n\nMercari is a C2C marketplace.");
    expect(jobs[1]?.hints).toMatchObject({ location: ["San Francisco, California, United States"], workMode: "remote" });
  });

  it("does not confirm dormant accounts (200 with no jobs) or unknown ones", async () => {
    const m = mockFetch([
      [/accounts\/whatfix/, () => json({ name: "Whatfix", description: null, jobs: [] })],
      [/accounts\/blue-machines-ai$/, () => json({ name: "Blue Machines AI", description: null, jobs: [workableJob("C6DFC634AE"), workableJob("EEB0D754E6")] })],
    ]);
    const wk = adapter("workable");
    expect(await wk.probe("whatfix", { fetch: m.fetch })).toBeNull();
    expect(await wk.probe("hasura", { fetch: m.fetch })).toBeNull();
    expect(await wk.probe("blue-machines-ai", { fetch: m.fetch })).toEqual({
      provider: "workable",
      slug: "blue-machines-ai",
      companyName: "Blue Machines AI",
      jobCount: 2,
      boardUrl: "https://apply.workable.com/blue-machines-ai/",
    });
  });
});

// ---------------------------------------------------------------- Recruitee

function recruiteeOffer(id: number, over: Record<string, unknown> = {}) {
  return {
    id,
    guid: "w6rcr",
    slug: "senior-accounts-executive",
    title: "Senior Accounts Executive",
    status: "published",
    company_name: "Signode",
    location: "Hyderabad, Telangāna, India",
    city: "Hyderabad",
    state_name: "Telangāna",
    state_code: "TG",
    country: "India",
    country_code: "IN",
    locations: [{ id: 83440, name: "Hyderabad", state: "Telangāna", country: "India", city: "Hyderabad", country_code: "IN", state_code: "TG" }],
    remote: false,
    hybrid: false,
    on_site: true,
    description: "<p>Signode is a leading provider of transit packaging.</p>",
    requirements: "<ul><li>CA Inter</li><li>Tally and SAP</li></ul>",
    employment_type_code: "fulltime_permanent",
    careers_url: "https://signode.recruitee.com/o/senior-accounts-executive",
    careers_apply_url: "https://signode.recruitee.com/o/senior-accounts-executive/c/new",
    published_at: "2026-08-27 07:29:25 UTC",
    created_at: "2026-08-20 11:00:00 UTC",
    salary: { min: "1800000", max: "2400000", period: "year", currency: "INR" },
    mailbox_email: "job.w6rcr@signode.recruitee.com",
    ...over,
  };
}

describe("Recruitee adapter", () => {
  it("strips diacritics, parses non-ISO dates and appends requirements", async () => {
    const m = mockFetch([
      [
        /^https:\/\/signode\.recruitee\.com\/api\/offers\/$/,
        () =>
          json({
            offers: [
              recruiteeOffer(2498337),
              recruiteeOffer(2498338, { title: "Draft role", status: "draft" }),
              recruiteeOffer(2498339, {
                title: "Plant Controller",
                location: "Hilden, Nordrhein-Westfalen, Germany",
                country_code: "DE",
                locations: [{ city: "Hilden", state: "Nordrhein-Westfalen", country: "Germany", country_code: "DE" }],
                salary: { min: null, max: null, period: null, currency: null },
              }),
            ],
          }),
      ],
    ]);
    const rc = adapter("recruitee");
    const { companyName, jobs } = await rc.fetchJobs("signode", { fetch: m.fetch });
    expect(companyName).toBe("Signode");
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({
      provider: "RECRUITEE",
      importMethod: "OFFICIAL_API",
      externalId: "recruitee:signode:2498337",
      attribution: "Signode careers (Recruitee)",
      sourceUrl: "https://signode.recruitee.com/o/senior-accounts-executive",
      hints: {
        location: ["Hyderabad"],
        workMode: "onsite",
        employmentType: "full_time",
        applyUrl: "https://signode.recruitee.com/o/senior-accounts-executive/c/new",
        postedAt: "2026-08-27T07:29:25.000Z",
        salaryMin: 1800000,
        salaryMax: 2400000,
        currency: "INR",
      },
    });
    expect(jobs[0]?.text).toBe("Signode is a leading provider of transit packaging.\n\nRequirements\n- CA Inter\n- Tally and SAP");
    expect(jobs[0]?.raw).not.toHaveProperty("mailbox_email");
    expect(jobs[1]?.hints.location).toEqual(["Hilden, Nordrhein-Westfalen, Germany"]);
    expect(jobs[1]?.hints.salaryMin).toBeUndefined();

    expect(await rc.probe("signode", { fetch: m.fetch })).toMatchObject({ companyName: "Signode", jobCount: 2, boardUrl: "https://signode.recruitee.com/" });
    // Board names are DNS labels: anything else never becomes a hostname (and is never requested).
    const before = m.calls.length;
    for (const evil of ["evil.example.com/x", "evil.example.com#", "a.b", "user@evil.example", "evil.example.com:443", "-bad", "x".repeat(64)]) {
      expect(await rc.probe(evil, { fetch: m.fetch })).toBeNull();
      await expect(rc.fetchJobs(evil, { fetch: m.fetch })).rejects.toMatchObject({ retryable: false });
    }
    expect(m.calls.length).toBe(before);
    expect(await rc.probe("nonexistentcompanyxyz123", { fetch: m.fetch })).toBeNull();
    expect(m.calls.every((u) => /^https:\/\/[a-z0-9-]+\.recruitee\.com\/api\/offers\/$/.test(u))).toBe(true);
  });
});

// ---------------------------------------------------------------- findCompanyBoards

describe("findCompanyBoards", () => {
  const ghBoard = (slug: string, companyName: string, count: number) =>
    json({ jobs: Array.from({ length: count }, (_, i) => ghJob(i + 1, "Bengaluru", { company_name: companyName, absolute_url: `https://job-boards.greenhouse.io/${slug}/jobs/${i + 1}` })), meta: { total: count } });

  it("finds Razorpay's legal-entity board through the directory with one request", async () => {
    const m = mockFetch([[/boards\/razorpaysoftwareprivatelimited\/jobs$/, () => ghBoard("razorpaysoftwareprivatelimited", "Razorpay Software Private Limited", 25)]]);
    const boards = await findCompanyBoards("razorpay", { fetch: m.fetch });
    expect(m.calls).toEqual(["https://boards-api.greenhouse.io/v1/boards/razorpaysoftwareprivatelimited/jobs"]);
    expect(boards).toEqual([
      {
        provider: "greenhouse",
        slug: "razorpaysoftwareprivatelimited",
        companyName: "Razorpay Software Private Limited",
        jobCount: 25,
        boardUrl: "https://job-boards.greenhouse.io/razorpaysoftwareprivatelimited",
      },
    ]);
  });

  it("falls back to the directory snapshot when a known board is temporarily unreachable", async () => {
    const m = mockFetch([[/lever\.co/, () => new Response("unavailable", { status: 503 })]]);
    const boards = await findCompanyBoards("Meesho", { fetch: m.fetch });
    expect(boards).toEqual([{ provider: "lever", slug: "meesho", companyName: "Meesho", jobCount: 54, boardUrl: "https://jobs.lever.co/meesho" }]);
  });

  it("guesses slugs across providers, confirms boards with jobs and sorts by job count", async () => {
    const m = mockFetch([
      [/api\.lever\.co\/v0\/postings\/acmerobotics\?/, () => json([leverPosting("a"), leverPosting("b"), leverPosting("c")])],
      [/api\.ashbyhq\.com\/posting-api\/job-board\/acmerobotics$/, () => json({ apiVersion: "1", jobs: [] })],
      [/api\.ashbyhq\.com\/posting-api\/job-board\/acme-robotics$/, () => json({ apiVersion: "1", jobs: ["1", "2", "3", "4", "5"].map((id) => ashbyJob(id)) })],
      [/api\.smartrecruiters\.com/, () => json({ offset: 0, limit: 1, totalFound: 0, content: [] })],
      [/accounts\/acmerobotics$/, () => json({ name: "Acme Robotics", description: null, jobs: [] })],
      // A namesake on Greenhouse: its own name doesn't match, so it is not offered.
      [/boards\/acmeroboticsindia\/jobs$/, () => ghBoard("acmeroboticsindia", "Totally Different Inc", 9)],
    ]);
    const boards = await findCompanyBoards("Acme Robotics", { fetch: m.fetch });
    expect(boards.map((b) => [b.provider, b.slug, b.jobCount])).toEqual([
      ["ashby", "acme-robotics", 5],
      ["lever", "acmerobotics", 3],
    ]);
    expect(m.calls.length).toBeLessThanOrEqual(MAX_BOARD_PROBES + 6); // Lever may try its EU host too
    expect(m.maxInFlight).toBeLessThanOrEqual(3);
  });

  it("returns an empty list when nothing matches, and a retryable error when providers are down", async () => {
    const none = mockFetch([]);
    expect(await findCompanyBoards("Zzyzx Unknown Labs", { fetch: none.fetch })).toEqual([]);
    expect(await findCompanyBoards("   ", { fetch: none.fetch })).toEqual([]);

    const down = mockFetch([[/./, () => new Response("busy", { status: 503 })]]);
    const err = await findCompanyBoards("Zzyzx Unknown Labs", { fetch: down.fetch }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FeedProviderError);
    expect(err).toMatchObject({ retryable: true });
  });

  it("dedupes and ranks boards from several directory entries", async () => {
    // "Mercari" is an alias of the Workable directory entry; probe it live.
    const m = mockFetch([
      [/accounts\/mercari-india$/, () => json({ name: "Mercari, Inc. (India)", jobs: [workableJob("A"), workableJob("B")] })],
    ]);
    const boards: BoardProbe[] = await findCompanyBoards("mercari", { fetch: m.fetch });
    expect(boards).toEqual([
      { provider: "workable", slug: "mercari-india", companyName: "Mercari, Inc. (India)", jobCount: 2, boardUrl: "https://apply.workable.com/mercari-india/" },
    ]);
  });
});

// ---------------------------------------------------------------- review fixes

/** Never answers; rejects once the request is aborted (timeout or deadline). */
const hang = (init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
  });

describe("findCompanyBoards deadline", () => {
  it("gives up after the deadline with a retryable error when every provider hangs", async () => {
    vi.useFakeTimers();
    try {
      const calls: string[] = [];
      const fetch = ((input: string | URL | Request, init?: RequestInit) => {
        calls.push(String(input));
        return hang(init);
      }) as typeof globalThis.fetch;
      const pending = findCompanyBoards("Zzyzx Unknown Labs", { fetch });
      const assertion = expect(pending).rejects.toMatchObject({ name: "FeedProviderError", retryable: true, message: expect.stringContaining("could not be checked") });
      await vi.advanceTimersByTimeAsync(FIND_BOARDS_DEADLINE_MS);
      await assertion;
      // Two rounds of 3 probes (15 s timeout each) fit in the 25 s budget; the rest are never sent.
      expect(calls.length).toBeLessThanOrEqual(6);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns the boards confirmed before the deadline", async () => {
    vi.useFakeTimers();
    try {
      const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (/api\.lever\.co\/v0\/postings\/acmerobotics\?/.test(url)) return json([leverPosting("a"), leverPosting("b")]);
        return hang(init);
      }) as typeof globalThis.fetch;
      const pending = findCompanyBoards("Acme Robotics", { fetch });
      await vi.advanceTimersByTimeAsync(FIND_BOARDS_DEADLINE_MS);
      expect((await pending).map((b) => [b.provider, b.slug, b.jobCount])).toEqual([["lever", "acmerobotics", 2]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("honours the caller's abort signal", async () => {
    const controller = new AbortController();
    const fetch = ((_input: string | URL | Request, init?: RequestInit) => hang(init)) as typeof globalThis.fetch;
    const pending = findCompanyBoards("Zzyzx Unknown Labs", { fetch, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ retryable: true });
  });
});

describe("board adapters: review fixes", () => {
  it("SmartRecruiters keeps each posting once when offset pages overlap", async () => {
    const postings = Array.from({ length: 150 }, (_, i) => srPosting(i));
    const detailIds: string[] = [];
    const m = mockFetch([
      [
        /companies\/Freshworks\/postings\?/,
        (url) => {
          const offset = Number(url.searchParams.get("offset"));
          // A new posting shifted the list: page 2 starts with the last item of page 1 again.
          const start = offset === 0 ? 0 : offset - 1;
          return json({ offset, limit: 100, totalFound: postings.length, content: postings.slice(start, start + 100) });
        },
      ],
      [
        /companies\/Freshworks\/postings\/\d+$/,
        (url) => {
          detailIds.push(url.pathname.split("/").pop()!);
          return json({ status: 404 }, 404);
        },
      ],
    ]);
    const { jobs } = await adapter("smartrecruiters").fetchJobs("Freshworks", { fetch: m.fetch });
    expect(jobs).toHaveLength(150);
    expect(new Set(jobs.map((j) => j.externalId)).size).toBe(150);
    expect(detailIds).toHaveLength(40);
    expect(new Set(detailIds).size).toBe(40);
  });

  it("drops non-http job links from every board", async () => {
    const bad = "javascript:alert(document.cookie)";
    const gh = mockFetch([[/greenhouse/, () => json({ jobs: [ghJob(1, "Bengaluru", { absolute_url: bad })] })]]);
    const [ghOut] = (await adapter("greenhouse").fetchJobs("acme", { fetch: gh.fetch })).jobs;
    expect(ghOut?.sourceUrl).toBeNull();
    expect(ghOut?.hints.applyUrl).toBeUndefined();

    const lv = mockFetch([[/api\.lever\.co/, () => json([leverPosting("x", { hostedUrl: bad, applyUrl: "data:text/html,hi" })])]]);
    const [lvOut] = (await adapter("lever").fetchJobs("acme", { fetch: lv.fetch })).jobs;
    expect(lvOut?.sourceUrl).toBeNull();
    expect(lvOut?.hints.applyUrl).toBeUndefined();

    const as = mockFetch([[/ashbyhq/, () => json({ jobs: [ashbyJob("y", { jobUrl: bad, applyUrl: "https://jobs.ashbyhq.com/acme/y/application" })] })]]);
    const [asOut] = (await adapter("ashby").fetchJobs("acme", { fetch: as.fetch })).jobs;
    expect(asOut?.sourceUrl).toBeNull();
    expect(asOut?.hints.applyUrl).toBe("https://jobs.ashbyhq.com/acme/y/application");

    const wk = mockFetch([[/workable/, () => json({ name: "Acme", jobs: [workableJob("Z", { url: bad, shortlink: bad, application_url: bad })] })]]);
    const [wkOut] = (await adapter("workable").fetchJobs("acme", { fetch: wk.fetch })).jobs;
    expect(wkOut?.sourceUrl).toBeNull();
    expect(wkOut?.hints.applyUrl).toBeUndefined();

    const rc = mockFetch([[/recruitee/, () => json({ offers: [recruiteeOffer(1, { careers_url: bad, careers_apply_url: bad })] })]]);
    const [rcOut] = (await adapter("recruitee").fetchJobs("acme", { fetch: rc.fetch })).jobs;
    expect(rcOut?.sourceUrl).toBeNull();
    expect(rcOut?.hints.applyUrl).toBeUndefined();

    const sr = mockFetch([
      [/postings\?/, () => json({ offset: 0, limit: 100, totalFound: 1, content: [srPosting(1)] })],
      [/postings\/\d+$/, () => json({ ...srPosting(1), postingUrl: bad, applyUrl: bad })],
    ]);
    const [srOut] = (await adapter("smartrecruiters").fetchJobs("Freshworks", { fetch: sr.fetch })).jobs;
    // Falls back to the public posting page built from the identifier.
    expect(srOut?.sourceUrl).toBe("https://jobs.smartrecruiters.com/Freshworks/744000151772991");
    expect(srOut?.hints.applyUrl).toBe("https://jobs.smartrecruiters.com/Freshworks/744000151772991");
  });

  it("keeps a board syncing when one posting has malformed fields", async () => {
    const gh = mockFetch([[/greenhouse/, () => json({ jobs: [ghJob(1, "Bengaluru", { offices: { id: 1 }, location: null, content: { html: "x" } }), null, "junk"] })]]);
    const ghJobs = (await adapter("greenhouse").fetchJobs("acme", { fetch: gh.fetch })).jobs;
    expect(ghJobs).toHaveLength(1);
    expect(ghJobs[0]?.text).toBe("Frontend Engineer");

    const lv = mockFetch([
      [/api\.lever\.co/, () => json([leverPosting("x", { lists: "oops", categories: { allLocations: "Pune", location: "Pune" }, descriptionPlain: 7, description: null })])],
    ]);
    const lvJobs = (await adapter("lever").fetchJobs("acme", { fetch: lv.fetch })).jobs;
    expect(lvJobs[0]?.hints.location).toEqual(["Pune"]);

    const as = mockFetch([[/ashbyhq/, () => json({ jobs: [ashbyJob("y", { secondaryLocations: null, compensation: { summaryComponents: {} } })] })]]);
    expect((await adapter("ashby").fetchJobs("acme", { fetch: as.fetch })).jobs).toHaveLength(1);

    const wk = mockFetch([[/workable/, () => json({ name: "Acme", jobs: [workableJob("Z", { locations: "India" }), 5] })]]);
    const wkJobs = (await adapter("workable").fetchJobs("acme", { fetch: wk.fetch })).jobs;
    expect(wkJobs).toHaveLength(1);
    expect(wkJobs[0]?.hints.location).toEqual(["Bengaluru"]);

    const rc = mockFetch([[/recruitee/, () => json({ offers: [recruiteeOffer(1, { locations: { name: "x" } }), false] })]]);
    const rcJobs = (await adapter("recruitee").fetchJobs("acme", { fetch: rc.fetch })).jobs;
    expect(rcJobs).toHaveLength(1);
    expect(rcJobs[0]?.hints.location).toEqual(["Hyderabad"]);
  });

  it("does not follow a board's redirect to another site (tenant custom domains)", async () => {
    const m = mockFetch([[/signode\.recruitee\.com/, () => new Response(null, { status: 301, headers: { location: "https://careers.signode.example/api/offers/" } })]]);
    await expect(adapter("recruitee").fetchJobs("signode", { fetch: m.fetch })).rejects.toMatchObject({ name: "FeedProviderError", retryable: false });
    expect(m.calls).toEqual(["https://signode.recruitee.com/api/offers/"]);
  });
});
