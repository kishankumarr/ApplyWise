import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeRawJob } from "../src/connectors/normalize";
import { SEARCH_PROVIDERS, getSearchProvider } from "../src/feeds/search";
import { FeedProviderError, type FeedContext, type SearchQuery } from "../src/feeds/types";
import { decodeEntities, htmlToText, httpJson, httpUrl, isCountryWideIndia, normalizePlace, summarizePlaces, toIsoDate } from "../src/feeds/util";

// ---------------------------------------------------------------- helpers

type Handler = (url: URL, init?: RequestInit) => Response | Promise<Response>;

/** Fetch mock: first matching route wins; unmatched URLs get a 404. Records every URL. */
function mockFetch(routes: [RegExp, Handler][]) {
  const calls: string[] = [];
  const headers: Record<string, string>[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    headers.push(Object.fromEntries(new Headers(init?.headers).entries()));
    for (const [re, handler] of routes) if (re.test(url)) return handler(new URL(url), init);
    return new Response("Not Found", { status: 404 });
  }) as typeof globalThis.fetch;
  return { fetch, calls, headers };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A fetch that never answers until its signal aborts (to exercise timeouts/cancellation). */
const hangingFetch = ((_input: string | URL | Request, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
  })) as typeof globalThis.fetch;

const NOW = new Date("2026-09-26T06:00:00Z");
const query = (over: Partial<SearchQuery> = {}): SearchQuery => ({
  keywords: "react developer",
  location: "Bengaluru",
  remoteOnly: false,
  maxDaysOld: 7,
  limit: 20,
  ...over,
});
const provider = (id: string) => {
  const p = getSearchProvider(id);
  if (!p) throw new Error(`missing provider ${id}`);
  return p;
};

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------- registry

describe("search provider registry", () => {
  it("lists India coverage first and looks providers up by id", () => {
    expect(SEARCH_PROVIDERS.map((p) => p.id)).toEqual(["adzuna", "himalayas", "jobicy", "themuse"]);
    expect(getSearchProvider("himalayas")?.label).toBe("Himalayas");
    expect(getSearchProvider("remotive")).toBeNull();
  });

  it("describes keys, coverage, attribution and description depth", () => {
    const adzuna = provider("adzuna");
    expect(adzuna).toMatchObject({
      requiredEnv: ["ADZUNA_APP_ID", "ADZUNA_APP_KEY"],
      signupUrl: "https://developer.adzuna.com/signup",
      coverage: "india",
      descriptionLevel: "SNIPPET",
      attribution: { text: "Jobs by Adzuna", url: "https://www.adzuna.in" },
    });
    expect(provider("himalayas")).toMatchObject({ requiredEnv: [], coverage: "remote", descriptionLevel: "FULL" });
    expect(provider("himalayas").attribution).toEqual({ text: "via Himalayas", url: "https://himalayas.app" });
    expect(provider("jobicy").coverage).toBe("remote");
    expect(provider("themuse").coverage).toBe("india");
  });

  it("makes Adzuna available only when both operator keys are set", () => {
    const adzuna = provider("adzuna");
    expect(adzuna.isAvailable({})).toBe(false);
    expect(adzuna.isAvailable({ ADZUNA_APP_ID: "id" })).toBe(false);
    expect(adzuna.isAvailable({ ADZUNA_APP_ID: "id", ADZUNA_APP_KEY: "  " })).toBe(false);
    expect(adzuna.isAvailable({ ADZUNA_APP_ID: "id", ADZUNA_APP_KEY: "key" })).toBe(true);
    for (const id of ["himalayas", "jobicy", "themuse"]) expect(provider(id).isAvailable({})).toBe(true);
  });
});

// ---------------------------------------------------------------- shared helpers

describe("feed text helpers", () => {
  it("keeps paragraphs, headings and list items as lines with '- ' bullets", () => {
    const html =
      "<h2>About the role</h2><p>Build&nbsp;payments &amp; UPI flows.</p>\n<p><strong>Requirements</strong></p>" +
      "<ul>\n  <li>3+ years of <b>React</b></li><li><p>TypeScript</p></li></ul><p>Apply by 30&nbsp;Sep<br>Thanks</p>";
    expect(htmlToText(html)).toBe(
      ["About the role", "", "Build payments & UPI flows.", "", "Requirements", "", "- 3+ years of React", "- TypeScript", "", "Apply by 30 Sep", "Thanks"].join("\n"),
    );
  });

  it("decodes entities exactly once", () => {
    expect(decodeEntities("&amp;lt;div&amp;gt; &#8377; &#x20B9; &rsquo; &unknown;")).toBe("&lt;div&gt; ₹ ₹ ’ &unknown;");
  });

  it("normalises epoch seconds, epoch ms, Recruitee and date-only timestamps", () => {
    expect(toIsoDate(1790352562)).toBe("2026-09-25T16:09:22.000Z");
    expect(toIsoDate(1787543704191)).toBe(new Date(1787543704191).toISOString());
    expect(toIsoDate("2026-08-27 07:29:25 UTC")).toBe("2026-08-27T07:29:25.000Z");
    expect(toIsoDate("2025-07-28")).toBe("2025-07-28T00:00:00.000Z");
    expect(toIsoDate("2026-09-24T04:40:19+00:00")).toBe("2026-09-24T04:40:19.000Z");
    expect(toIsoDate("not a date")).toBeUndefined();
    expect(toIsoDate(null)).toBeUndefined();
  });
});

// ---------------------------------------------------------------- Adzuna

const ADZUNA_ENV = { ADZUNA_APP_ID: "app-id-1", ADZUNA_APP_KEY: "secret-key-123" };

function adzunaAd(i: number, over: Record<string, unknown> = {}) {
  return {
    __CLASS__: "Adzuna::API::Response::Job",
    id: String(4871230000 + i),
    adref: "eyJhbGciOiJIUzI1NiJ9.eyJpIjoiNDg3MTIzIn0.x",
    title: `Senior <strong>React</strong> Developer ${i}`,
    description:
      "We are hiring a <strong>React</strong> developer to build merchant dashboards. Must have TypeScript and REST APIs &amp; 4+ years…",
    created: "2026-09-24T10:15:00Z",
    redirect_url: `https://www.adzuna.in/land/ad/${4871230000 + i}?se=abc&utm_medium=api&v=XYZ`,
    company: { __CLASS__: "Adzuna::API::Response::Company", display_name: "Acme Fintech Pvt Ltd" },
    location: { __CLASS__: "Adzuna::API::Response::Location", display_name: "Whitefield, Bangalore", area: ["India", "Karnataka", "Bangalore", "Whitefield"] },
    category: { __CLASS__: "Adzuna::API::Response::Category", tag: "it-jobs", label: "IT Jobs" },
    salary_min: 1800000,
    salary_max: 2400000,
    salary_is_predicted: "0",
    contract_time: "full_time",
    contract_type: "permanent",
    latitude: 12.97,
    longitude: 77.75,
    ...over,
  };
}

describe("Adzuna adapter", () => {
  it("queries the India index with date sort, radius and freshness, and maps snippets", async () => {
    const m = mockFetch([
      [
        /api\.adzuna\.com\/v1\/api\/jobs\/in\/search\/1\?/,
        () =>
          json({
            __CLASS__: "Adzuna::API::Response::JobSearchResults",
            count: 2,
            mean: 2100000,
            results: [adzunaAd(1), adzunaAd(2, { salary_is_predicted: "1", salary_min: 900000, salary_max: 900000, contract_type: "contract" })],
          }),
      ],
    ]);
    const jobs = await provider("adzuna").search(query({ keywords: "react developer", maxDaysOld: 3, limit: 20 }), {
      fetch: m.fetch,
      env: ADZUNA_ENV,
      now: NOW,
    });

    expect(m.calls).toHaveLength(1);
    const url = new URL(m.calls[0]!);
    expect(url.pathname).toBe("/v1/api/jobs/in/search/1");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      app_id: "app-id-1",
      app_key: "secret-key-123",
      what: "react developer",
      where: "Bangalore",
      distance: "25",
      max_days_old: "3",
      sort_by: "date",
      results_per_page: "20",
      "content-type": "application/json",
    });
    expect(m.headers[0]?.["user-agent"]).toBe("ApplyWise/0.1 (job-search copilot)");

    expect(jobs).toHaveLength(2);
    const [first, second] = jobs;
    expect(first).toMatchObject({
      provider: "JOB_SEARCH_API",
      importMethod: "JOB_SEARCH_API",
      externalId: "adzuna:4871230001",
      sourceUrl: "https://www.adzuna.in/land/ad/4871230001?se=abc&utm_medium=api&v=XYZ",
      attribution: "Jobs by Adzuna",
      raw: { kind: "job_search_api", provider: "adzuna", id: "4871230001" },
      descriptionLevel: "SNIPPET",
      hints: {
        title: "Senior React Developer 1",
        company: "Acme Fintech Pvt Ltd",
        location: ["Bengaluru"],
        applyUrl: "https://www.adzuna.in/land/ad/4871230001?se=abc&utm_medium=api&v=XYZ",
        postedAt: "2026-09-24T10:15:00.000Z",
        employmentType: "full_time",
        salaryMin: 1800000,
        salaryMax: 2400000,
        currency: "INR",
      },
    });
    expect(first?.text).toBe(
      "We are hiring a React developer to build merchant dashboards. Must have TypeScript and REST APIs & 4+ years…",
    );
    expect(Object.keys(first!.raw)).toEqual(["kind", "provider", "id"]);
    // Predicted salaries are estimates, not advertised pay.
    expect(second?.hints.salaryMin).toBeUndefined();
    expect(second?.hints.currency).toBeUndefined();
    expect(second?.hints.employmentType).toBe("contract");
  });

  it("pages up to the limit with at most 50 per page and stops on a short page", async () => {
    const pages: number[] = [];
    const m = mockFetch([
      [
        /adzuna\.com/,
        (url) => {
          const page = Number(url.pathname.split("/").pop());
          pages.push(page);
          const per = Number(url.searchParams.get("results_per_page"));
          return json({ count: 500, results: Array.from({ length: per }, (_, i) => adzunaAd(page * 100 + i)) });
        },
      ],
    ]);
    const jobs = await provider("adzuna").search(query({ limit: 120 }), { fetch: m.fetch, env: ADZUNA_ENV });
    expect(pages).toEqual([1, 2, 3]);
    expect(new URL(m.calls[0]!).searchParams.get("results_per_page")).toBe("50");
    expect(jobs).toHaveLength(120);
    expect(new Set(jobs.map((j) => j.externalId)).size).toBe(120);

    const short = mockFetch([[/adzuna\.com/, () => json({ count: 7, results: [adzunaAd(1), adzunaAd(2)] })]]);
    const few = await provider("adzuna").search(query({ limit: 200 }), { fetch: short.fetch, env: ADZUNA_ENV });
    expect(short.calls).toHaveLength(1);
    expect(few).toHaveLength(2);
  });

  it("asks for remote wording without a city for remote-only searches and keeps remote ads only", async () => {
    const m = mockFetch([
      [
        /adzuna\.com/,
        () =>
          json({
            count: 2,
            results: [
              adzunaAd(1, { title: "React Developer (Remote)" }),
              adzunaAd(2, { title: "React Developer", description: "Work from office in Pune." }),
            ],
          }),
      ],
    ]);
    const jobs = await provider("adzuna").search(query({ remoteOnly: true }), { fetch: m.fetch, env: ADZUNA_ENV });
    const params = new URL(m.calls[0]!).searchParams;
    expect(params.get("where")).toBeNull();
    expect(params.get("what_or")).toBe("remote wfh");
    expect(jobs.map((j) => j.hints.title)).toEqual(["React Developer (Remote)"]);
    expect(jobs[0]?.hints).toMatchObject({ workMode: "remote", location: ["Remote - India"] });
  });

  it("refuses to run without operator keys", async () => {
    const m = mockFetch([]);
    const err = await provider("adzuna")
      .search(query(), { fetch: m.fetch, env: {} })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FeedProviderError);
    expect(err).toMatchObject({ retryable: false });
    expect(m.calls).toHaveLength(0);
  });

  it.each([
    [401, false, "Adzuna rejected the API key"],
    [403, false, "Adzuna rejected the API key"],
    [429, true, "rate limit"],
    [500, true, "temporarily unavailable"],
    [503, true, "temporarily unavailable"],
    [400, false, "rejected the request"],
  ])("maps HTTP %i to retryable=%s without leaking the key", async (status, retryable, text) => {
    const m = mockFetch([
      [/adzuna\.com/, () => json({ display: "Authorisation failed", exception: "AUTH_FAIL", doc: "https://api.adzuna.com/v1/doc" }, status)],
    ]);
    const err = (await provider("adzuna")
      .search(query(), { fetch: m.fetch, env: ADZUNA_ENV })
      .catch((e: unknown) => e)) as FeedProviderError;
    expect(err).toBeInstanceOf(FeedProviderError);
    expect(err.retryable).toBe(retryable);
    expect(err.status).toBe(status);
    expect(err.message).toContain(text);
    expect(err.message).not.toContain("secret-key-123");
    expect(err.message).not.toContain("app_key");
    expect(err.message).not.toContain("adzuna.com");
  });

  it("treats network failures as retryable without echoing the request", async () => {
    const failing = (async () => {
      throw new TypeError("fetch failed: getaddrinfo ENOTFOUND api.adzuna.com?app_key=secret-key-123");
    }) as typeof globalThis.fetch;
    const err = (await provider("adzuna")
      .search(query(), { fetch: failing, env: ADZUNA_ENV })
      .catch((e: unknown) => e)) as FeedProviderError;
    expect(err).toBeInstanceOf(FeedProviderError);
    expect(err.retryable).toBe(true);
    expect(err.message).toBe("Could not reach Adzuna. Try again later.");
  });

  it("gives up after 15 seconds with a retryable timeout", async () => {
    vi.useFakeTimers();
    const pending = provider("adzuna").search(query(), { fetch: hangingFetch, env: ADZUNA_ENV });
    const assertion = expect(pending).rejects.toMatchObject({ name: "FeedProviderError", retryable: true, message: expect.stringContaining("15 seconds") });
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
  });

  it("honours the caller's abort signal", async () => {
    const controller = new AbortController();
    const pending = provider("adzuna").search(query(), { fetch: hangingFetch, env: ADZUNA_ENV, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ retryable: true, message: expect.stringContaining("cancelled") });
  });
});

// ---------------------------------------------------------------- Himalayas

function himalayasJob(i: number, over: Record<string, unknown> = {}) {
  const slug = `software-engineer-frontend-${i}`;
  return {
    title: `Software Engineer- Frontend ${i}`,
    excerpt: "Build the WebEngage dashboard in React.",
    companyName: "WebEngage",
    companySlug: "webengage",
    companyLogo: "https://cdn-images.himalayas.app/webengage.png",
    employmentType: "Full Time",
    minSalary: null,
    maxSalary: null,
    salaryPeriod: "annual",
    seniority: ["Mid-level"],
    currency: null,
    locationRestrictions: ["India"],
    timezoneRestrictions: [5.5],
    categories: ["Frontend-Developer"],
    parentCategories: ["Software Engineering"],
    description:
      "<p>WebEngage is a customer data platform.</p><p><strong>Requirements</strong></p><ul><li>3+ years with React</li><li>TypeScript</li></ul>",
    pubDate: 1790166053 - i * 3600, // unix seconds, as the live API sends them
    expiryDate: 1795350053,
    applicationLink: `https://himalayas.app/companies/webengage/jobs/${slug}`,
    guid: `https://himalayas.app/companies/webengage/jobs/${slug}`,
    ...over,
  };
}

const himalayasPage = (jobs: unknown[], totalCount = 410, page = 1) => ({
  comments: "Himalayas remote jobs API",
  updatedAt: 1790352000,
  offset: (page - 1) * 20,
  limit: 20,
  totalCount,
  jobs,
});

describe("Himalayas adapter", () => {
  it("searches jobs open to India, sorted by date, and maps full descriptions", async () => {
    const m = mockFetch([
      [
        /himalayas\.app\/jobs\/api\/search/,
        () =>
          json(
            himalayasPage(
              [
                himalayasJob(1),
                himalayasJob(2, { locationRestrictions: [] }),
                himalayasJob(3, { locationRestrictions: [{ alpha2: "IN", name: "India", slug: "india" }], minSalary: 1000, maxSalary: 2000, salaryPeriod: "monthly", currency: "USD" }),
                himalayasJob(4, { locationRestrictions: ["United States", "Canada"] }),
                himalayasJob(5, { pubDate: 1790166053000 }), // milliseconds, as the spec documents
              ],
              5,
            ),
          ),
      ],
    ]);
    const jobs = await provider("himalayas").search(query({ keywords: "react", maxDaysOld: 30 }), { fetch: m.fetch, now: NOW });

    const url = new URL(m.calls[0]!);
    expect(Object.fromEntries(url.searchParams)).toEqual({ q: "react", country: "IN", sort: "recent", page: "1" });
    // US/Canada-only jobs are not open to Indian candidates.
    expect(jobs.map((j) => j.hints.title)).toEqual([
      "Software Engineer- Frontend 1",
      "Software Engineer- Frontend 2",
      "Software Engineer- Frontend 3",
      "Software Engineer- Frontend 5",
    ]);
    const [india, global, withSalary, msDate] = jobs;
    expect(india).toMatchObject({
      provider: "JOB_SEARCH_API",
      importMethod: "JOB_SEARCH_API",
      externalId: "himalayas:https://himalayas.app/companies/webengage/jobs/software-engineer-frontend-1",
      sourceUrl: "https://himalayas.app/companies/webengage/jobs/software-engineer-frontend-1",
      attribution: "via Himalayas",
      descriptionLevel: "FULL",
      raw: { kind: "job_search_api", provider: "himalayas", id: "https://himalayas.app/companies/webengage/jobs/software-engineer-frontend-1" },
      hints: {
        company: "WebEngage",
        location: ["Remote - India"],
        workMode: "remote",
        employmentType: "full_time",
        applyUrl: "https://himalayas.app/companies/webengage/jobs/software-engineer-frontend-1",
        postedAt: new Date((1790166053 - 3600) * 1000).toISOString(),
      },
    });
    expect(india?.text).toBe("WebEngage is a customer data platform.\n\nRequirements\n\n- 3+ years with React\n- TypeScript");
    expect(india?.hints.salaryMin).toBeUndefined();
    expect(global?.hints.location).toEqual(["Remote - Global"]);
    expect(withSalary?.hints).toMatchObject({ location: ["Remote - India"], salaryMin: 12000, salaryMax: 24000, currency: "USD" });
    expect(msDate?.hints.postedAt).toBe(new Date(1790166053000).toISOString());
  });

  it("the full description feeds the JD parser's requirement sections", async () => {
    const m = mockFetch([[/himalayas/, () => json(himalayasPage([himalayasJob(1)], 1))]]);
    const [raw] = await provider("himalayas").search(query({ maxDaysOld: 0 }), { fetch: m.fetch, now: NOW });
    const job = await normalizeRawJob(raw!);
    expect(job.requiredSkills.map((s) => s.canonicalName)).toEqual(expect.arrayContaining(["React", "TypeScript"]));
    expect(job.location).toEqual(["Remote - India"]);
    expect(job.workMode).toBe("remote");
    expect(job.platform).toBe("JOB_SEARCH_API");
  });

  it("fetches at most three pages of 20 and only as many as the limit needs", async () => {
    const seen: string[] = [];
    const m = mockFetch([
      [
        /himalayas/,
        (url) => {
          const page = Number(url.searchParams.get("page"));
          seen.push(String(page));
          return json(himalayasPage(Array.from({ length: 20 }, (_, i) => himalayasJob(page * 100 + i, { pubDate: 1790160000 })), 410, page));
        },
      ],
    ]);
    const many = await provider("himalayas").search(query({ limit: 500 }), { fetch: m.fetch, now: NOW });
    expect(seen).toEqual(["1", "2", "3"]);
    expect(many).toHaveLength(60);

    seen.length = 0;
    const some = await provider("himalayas").search(query({ limit: 25 }), { fetch: m.fetch, now: NOW });
    expect(seen).toEqual(["1", "2"]);
    expect(some).toHaveLength(25);
  });

  it("keeps paging past short pages but stops once a page has nothing recent", async () => {
    const seen: number[] = [];
    const m = mockFetch([
      [
        /himalayas/,
        (url) => {
          const page = Number(url.searchParams.get("page"));
          seen.push(page);
          // Page 1 is short (17 jobs, as observed live) but more exist; page 2 is all older than maxDaysOld.
          const pubDate = page === 1 ? 1790160000 : 1780000000;
          return json(himalayasPage(Array.from({ length: page === 1 ? 17 : 20 }, (_, i) => himalayasJob(page * 100 + i, { pubDate })), 410, page));
        },
      ],
    ]);
    const jobs = await provider("himalayas").search(query({ limit: 60, maxDaysOld: 7 }), { fetch: m.fetch, now: NOW });
    expect(seen).toEqual([1, 2]);
    expect(jobs).toHaveLength(17);
  });

  it("maps 429 and a keyless 403 (bot block: nothing for the user to fix) to retryable errors", async () => {
    const limited = mockFetch([[/himalayas/, () => json({ ok: false, errors: "Too many requests, please try again later." }, 429)]]);
    await expect(provider("himalayas").search(query(), { fetch: limited.fetch })).rejects.toMatchObject({ retryable: true, status: 429 });
    const blocked = mockFetch([[/himalayas/, () => new Response("<html>denied</html>", { status: 403 })]]);
    await expect(provider("himalayas").search(query(), { fetch: blocked.fetch })).rejects.toMatchObject({
      retryable: true,
      status: 403,
      message: "Himalayas refused the request (HTTP 403). It will be retried later.",
    });
    const badRequest = mockFetch([[/himalayas/, () => json({ ok: false }, 400)]]);
    await expect(provider("himalayas").search(query(), { fetch: badRequest.fetch })).rejects.toMatchObject({ retryable: false, status: 400 });
    const invalid = mockFetch([[/himalayas/, () => new Response("<html>oops</html>", { status: 200 })]]);
    await expect(provider("himalayas").search(query(), { fetch: invalid.fetch })).rejects.toMatchObject({ retryable: true });
  });
});

// ---------------------------------------------------------------- Jobicy

function jobicyJob(id: number, over: Record<string, unknown> = {}) {
  return {
    id,
    url: `https://jobicy.com/jobs/${id}-frontend-developer`,
    jobSlug: `${id}-frontend-developer`,
    jobTitle: "Frontend Developer (React &amp; TypeScript)",
    companyName: "Remote First Co",
    companyLogo: "https://jobicy.com/data/server-nyc0409/galaxy/mercury/2024/logo.png",
    jobIndustry: ["Engineering"],
    jobType: ["Full-Time"],
    jobGeo: "Anywhere",
    jobLevel: "Senior",
    jobExcerpt: "Join our distributed team building design systems.",
    jobDescription: "<p>Join our distributed team.</p><h3>What you'll need</h3><ul><li>React</li><li>TypeScript</li></ul>",
    pubDate: "2026-09-24T04:40:19+00:00",
    ...over,
  };
}

const jobicyFeed = (jobs: unknown[]) => ({
  apiVersion: "2.2.16",
  documentationUrl: "https://jobi.cy/apidocs",
  friendlyNotice: "Please ensure Jobicy is clearly credited with a direct link to the source.",
  jobCount: jobs.length,
  lastUpdate: "2026-09-25T18:05:26+00:00",
  appliedFilters: { count: 100, geo: "apac" },
  jobs,
  statusCode: 200,
  success: true,
});

describe("Jobicy adapter", () => {
  it("pulls the APAC feed once per hour and filters keywords and geography locally", async () => {
    const m = mockFetch([
      [
        /jobicy\.com\/api\/v2\/remote-jobs/,
        () =>
          json(
            jobicyFeed([
              jobicyJob(151496),
              jobicyJob(151545, { jobGeo: "APAC,  EMEA,  LATAM,  Canada,  USA", jobTitle: "React Engineer", salaryMin: 90000, salaryMax: 120000, salaryCurrency: "USD", salaryPeriod: "yearly" }),
              jobicyJob(154055, { jobGeo: "Philippines", jobTitle: "React Developer" }),
              jobicyJob(154068, { jobGeo: "Australia", jobTitle: "Frontend Developer" }),
              jobicyJob(149638, { jobGeo: "APAC", jobTitle: "Customer Success Manager" }),
              jobicyJob(140000, { jobTitle: "React Native Developer", pubDate: "2026-06-01T00:00:00+00:00" }),
            ]),
          ),
      ],
    ]);
    const ctx: FeedContext = { fetch: m.fetch, now: NOW };
    const jobs = await provider("jobicy").search(query({ keywords: "react frontend", maxDaysOld: 14 }), ctx);

    expect(new URL(m.calls[0]!).searchParams.get("geo")).toBe("apac");
    expect(jobs.map((j) => j.externalId)).toEqual(["jobicy:151496", "jobicy:151545"]);
    expect(jobs[0]).toMatchObject({
      sourceUrl: "https://jobicy.com/jobs/151496-frontend-developer",
      attribution: "via Jobicy",
      descriptionLevel: "FULL",
      hints: {
        title: "Frontend Developer (React & TypeScript)",
        location: ["Remote - Global"],
        workMode: "remote",
        employmentType: "full_time",
        applyUrl: "https://jobicy.com/jobs/151496-frontend-developer",
        postedAt: "2026-09-24T04:40:19.000Z",
      },
    });
    expect(jobs[1]?.hints).toMatchObject({ location: ["Remote - India"], salaryMin: 90000, salaryMax: 120000, currency: "USD" });

    // A second search within the hour reuses the pull (Jobicy asks for at most hourly checks).
    const again = await provider("jobicy").search(query({ keywords: "customer success", maxDaysOld: 14 }), ctx);
    expect(m.calls).toHaveLength(1);
    expect(again.map((j) => j.externalId)).toEqual(["jobicy:149638"]);
  });

  it("does not cache failures", async () => {
    let calls = 0;
    const flaky = (async () => {
      calls++;
      return calls === 1 ? new Response("busy", { status: 502 }) : json(jobicyFeed([jobicyJob(1)]));
    }) as typeof globalThis.fetch;
    await expect(provider("jobicy").search(query(), { fetch: flaky, now: NOW })).rejects.toMatchObject({ retryable: true, status: 502 });
    const jobs = await provider("jobicy").search(query({ keywords: "" }), { fetch: flaky, now: NOW });
    expect(jobs).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- The Muse

function museJob(id: number, name: string, locations: string[], over: Record<string, unknown> = {}) {
  return {
    contents: "<p><b>Who We Are</b><br><br>At Kyndryl, we design and build.</p><p><b>Required Skills</b></p><ul><li>React</li><li>Node.js</li></ul>",
    name,
    type: "external",
    publication_date: "2026-09-19T18:36:32Z",
    short_name: `job-${id}`,
    model_type: "jobs",
    id,
    locations: locations.map((n) => ({ name: n })),
    categories: [{ name: "Software Engineering" }],
    levels: [{ name: "Mid Level", short_name: "mid" }],
    tags: [],
    refs: { landing_page: `https://www.themuse.com/jobs/acme/job-${id}` },
    company: { id: 15000490, short_name: "acme", name: "Acme Global" },
    ...over,
  };
}

describe("The Muse adapter", () => {
  it("queries Indian city names by category and keeps recent Indian jobs whose titles match", async () => {
    const m = mockFetch([
      [
        /themuse\.com\/api\/public\/jobs/,
        () =>
          json({
            page: 0,
            page_count: 1,
            items_per_page: 20,
            took: 10,
            timed_out: false,
            total: 5,
            results: [
              museJob(1, "Senior Frontend Engineer", ["Bangalore, India", "Flexible / Remote"]),
              museJob(2, "Frontend Engineer", ["Flexible / Remote", "Mountain View, CA"]),
              museJob(3, "Frontend Developer", ["Bangalore, India"], { publication_date: "2024-12-05T00:00:00Z" }),
              museJob(4, "Delivery Manager - Java/.Net", ["Bangalore, India"]),
              museJob(5, "Frontend Engineer Intern", ["Hyderabad, India"], { levels: [{ name: "Internship", short_name: "internship" }] }),
            ],
          }),
      ],
    ]);
    const jobs = await provider("themuse").search(query({ keywords: "frontend engineer", location: "Bengaluru", maxDaysOld: 30 }), {
      fetch: m.fetch,
      env: {},
      now: NOW,
    });

    const url = new URL(m.calls[0]!);
    expect(url.searchParams.get("page")).toBe("0");
    expect(url.searchParams.getAll("location")).toEqual(["Bangalore, India"]);
    expect(url.searchParams.getAll("category")).toContain("Software Engineering");
    expect(url.searchParams.get("api_key")).toBeNull();

    expect(jobs.map((j) => j.externalId)).toEqual(["themuse:1", "themuse:5"]);
    expect(jobs[0]).toMatchObject({
      sourceUrl: "https://www.themuse.com/jobs/acme/job-1",
      attribution: "via The Muse",
      descriptionLevel: "FULL",
      hints: {
        title: "Senior Frontend Engineer",
        company: "Acme Global",
        location: ["Bengaluru", "Remote - India"],
        applyUrl: "https://www.themuse.com/jobs/acme/job-1",
        postedAt: "2026-09-19T18:36:32.000Z",
      },
    });
    expect(jobs[0]?.text).toContain("Required Skills\n\n- React\n- Node.js");
    expect(jobs[1]?.hints).toMatchObject({ location: ["Hyderabad"], employmentType: "internship" });
  });

  it("sends the optional API key and reports a rejected key", async () => {
    const m = mockFetch([[/themuse\.com/, () => json({ error: "Invalid API key" }, 403)]]);
    const err = (await provider("themuse")
      .search(query(), { fetch: m.fetch, env: { THE_MUSE_API_KEY: "muse-secret" }, now: NOW })
      .catch((e: unknown) => e)) as FeedProviderError;
    expect(new URL(m.calls[0]!).searchParams.get("api_key")).toBe("muse-secret");
    expect(err.message).toContain("The Muse rejected the API key");
    expect(err.message).not.toContain("muse-secret");
    expect(err.retryable).toBe(false);
  });

  it("returns nothing for cities The Muse does not list, without calling the API", async () => {
    const m = mockFetch([]);
    expect(await provider("themuse").search(query({ location: "Mysuru" }), { fetch: m.fetch, now: NOW })).toEqual([]);
    expect(m.calls).toHaveLength(0);
  });

  it("treats 'India' / 'Pan India' as every Indian city instead of an unknown city", async () => {
    for (const location of ["India", "Pan India", "Anywhere in India"]) {
      const m = mockFetch([[/themuse\.com/, () => json({ page: 0, page_count: 1, results: [museJob(7, "Frontend Engineer", ["Pune, India"])] })]]);
      const jobs = await provider("themuse").search(query({ keywords: "frontend engineer", location, maxDaysOld: 30 }), { fetch: m.fetch, env: {}, now: NOW });
      expect(m.calls).toHaveLength(1);
      expect(new URL(m.calls[0]!).searchParams.getAll("location")).toEqual(expect.arrayContaining(["Bangalore, India", "Pune, India", "New Delhi, India"]));
      expect(jobs.map((j) => j.externalId)).toEqual(["themuse:7"]);
    }
  });

  it("drops listings whose landing page is not an http(s) link", async () => {
    const m = mockFetch([
      [
        /themuse\.com/,
        () =>
          json({
            page: 0,
            page_count: 1,
            results: [
              museJob(1, "Frontend Engineer", ["Pune, India"], { refs: { landing_page: "javascript:alert(document.cookie)" } }),
              museJob(2, "Frontend Engineer", ["Pune, India"], { locations: "Pune, India" }), // malformed: not an array
              museJob(3, "Frontend Engineer", ["Pune, India"]),
            ],
          }),
      ],
    ]);
    const jobs = await provider("themuse").search(query({ keywords: "frontend engineer", location: null, maxDaysOld: 30 }), { fetch: m.fetch, env: {}, now: NOW });
    expect(jobs.map((j) => j.externalId)).toEqual(["themuse:3"]);
  });
});

// ---------------------------------------------------------------- review fixes: HTTP safety and places

describe("httpJson redirects and status mapping", () => {
  const ctxFor = (fetch: typeof globalThis.fetch): FeedContext => ({ fetch });

  it("follows redirects within the provider's site, never letting fetch follow them itself", async () => {
    const inits: RequestInit[] = [];
    const calls: string[] = [];
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push(String(input));
      inits.push(init ?? {});
      if (String(input).startsWith("https://www.workable.com/")) {
        return new Response(null, { status: 302, headers: { location: "https://apply.workable.com/api/v1/widget/accounts/acme" } });
      }
      return json({ name: "Acme", jobs: [] });
    }) as typeof globalThis.fetch;
    const data = await httpJson<{ name: string }>("https://www.workable.com/api/accounts/acme", ctxFor(fetch), { label: "Workable" });
    expect(data).toEqual({ name: "Acme", jobs: [] });
    expect(calls).toEqual(["https://www.workable.com/api/accounts/acme", "https://apply.workable.com/api/v1/widget/accounts/acme"]);
    expect(inits.every((i) => i.redirect === "manual")).toBe(true);
  });

  it.each([
    ["another site", "https://careers.acme-corp.example/api/offers/"],
    ["an internal address", "http://169.254.169.254/latest/meta-data/"],
    ["plain http on the same site", "http://signode.recruitee.com/api/offers/"],
    ["a non-http scheme", "file:///etc/passwd"],
  ])("refuses a redirect to %s without following it", async (_name, location) => {
    const calls: string[] = [];
    const fetch = (async (input: string | URL | Request) => {
      calls.push(String(input));
      return new Response(null, { status: 301, headers: { location } });
    }) as typeof globalThis.fetch;
    const err = (await httpJson("https://signode.recruitee.com/api/offers/", ctxFor(fetch), { label: "Recruitee" }).catch((e: unknown) => e)) as FeedProviderError;
    expect(err).toBeInstanceOf(FeedProviderError);
    expect(err).toMatchObject({ retryable: false, status: 301 });
    expect(err.message).toBe("Recruitee redirected the request elsewhere, so it was not followed.");
    expect(err.message).not.toContain(new URL(location).host || "file");
    expect(calls).toEqual(["https://signode.recruitee.com/api/offers/"]);
  });

  it("stops after three same-site redirects", async () => {
    let n = 0;
    const fetch = (async () => new Response(null, { status: 302, headers: { location: `https://api.lever.co/v0/postings/loop${++n}` } })) as typeof globalThis.fetch;
    await expect(httpJson("https://api.lever.co/v0/postings/loop0", ctxFor(fetch), { label: "Lever" })).rejects.toMatchObject({ retryable: false });
    expect(n).toBe(4);
  });

  it("maps 408 to retryable, keyless 401 to retryable and keyed 401 to needs-attention", async () => {
    const status = (s: number) => (async () => new Response("x", { status: s })) as typeof globalThis.fetch;
    await expect(httpJson("https://himalayas.app/jobs/api", ctxFor(status(408)), { label: "Himalayas" })).rejects.toMatchObject({ retryable: true, status: 408 });
    await expect(httpJson("https://himalayas.app/jobs/api", ctxFor(status(401)), { label: "Himalayas" })).rejects.toMatchObject({ retryable: true, status: 401 });
    await expect(httpJson("https://api.adzuna.com/v1/api/jobs/in/search/1", ctxFor(status(401)), { label: "Adzuna", keyed: true })).rejects.toMatchObject({
      retryable: false,
      status: 401,
      message: expect.stringContaining("rejected the API key"),
    });
  });
});

describe("links and India-wide places", () => {
  it("accepts only http(s) links and keeps them unchanged", () => {
    expect(httpUrl("https://jobs.lever.co/cred/abc?lever-source=x")).toBe("https://jobs.lever.co/cred/abc?lever-source=x");
    expect(httpUrl("  http://example.com/a  ")).toBe("http://example.com/a");
    for (const bad of ["javascript:alert(1)", "data:text/html,<script>x</script>", "/relative/path", "mailto:hr@acme.in", "", null, 42, {}]) {
      expect(httpUrl(bad)).toBeUndefined();
    }
  });

  it("recognises country-wide India listings", () => {
    for (const v of ["India", "Pan India", "PAN-India", "All over India", "Anywhere in India", "across india"]) expect(isCountryWideIndia(v)).toBe(true);
    for (const v of ["Bengaluru, India", "Indiana", "Remote - India", "", null]) expect(isCountryWideIndia(v)).toBe(false);
  });

  it("maps 'Pan India' / 'Anywhere in India' to India and 'Remote - IN' to Remote - India", () => {
    expect(normalizePlace("Pan India")).toMatchObject({ location: "India", india: true, remote: false });
    expect(normalizePlace("Anywhere in India")).toMatchObject({ location: "India", india: true, remote: false });
    expect(summarizePlaces(["Remote - IN"])).toMatchObject({ locations: ["Remote - India"], workMode: "remote", india: true });
    expect(summarizePlaces(["Remote - Anywhere in India"])).toMatchObject({ locations: ["Remote - India"], india: true });
  });
});

describe("search adapters: review fixes", () => {
  it("Adzuna searches the whole India index for 'India' / 'Pan India' instead of a 25 km radius", async () => {
    for (const location of ["India", "Pan India"]) {
      const m = mockFetch([[/adzuna\.com/, () => json({ count: 1, results: [adzunaAd(1)] })]]);
      await provider("adzuna").search(query({ location }), { fetch: m.fetch, env: ADZUNA_ENV });
      const params = new URL(m.calls[0]!).searchParams;
      expect(params.get("where")).toBeNull();
      expect(params.get("distance")).toBeNull();
    }
  });

  it("Adzuna drops non-http redirect links and survives malformed location data", async () => {
    const m = mockFetch([
      [
        /adzuna\.com/,
        () =>
          json({
            count: 3,
            results: [
              adzunaAd(1, { redirect_url: "javascript:alert(1)" }),
              adzunaAd(2, { location: { display_name: "Pune", area: "India > Maharashtra" } }),
              adzunaAd(3),
            ],
          }),
      ],
    ]);
    const jobs = await provider("adzuna").search(query(), { fetch: m.fetch, env: ADZUNA_ENV });
    expect(jobs.map((j) => j.externalId)).toEqual(["adzuna:4871230002", "adzuna:4871230003"]);
    expect(jobs[0]?.hints.location).toEqual(["Pune"]);
  });

  it("Himalayas falls back to the https guid when applicationLink is not a web link", async () => {
    const m = mockFetch([
      [/himalayas/, () => json(himalayasPage([himalayasJob(1, { applicationLink: "javascript:void(0)" }), himalayasJob(2, { applicationLink: null, guid: "urn:x" })], 2))],
    ]);
    const jobs = await provider("himalayas").search(query({ maxDaysOld: 0 }), { fetch: m.fetch, now: NOW });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      sourceUrl: "https://himalayas.app/companies/webengage/jobs/software-engineer-frontend-1",
      hints: { applyUrl: "https://himalayas.app/companies/webengage/jobs/software-engineer-frontend-1" },
    });
  });
});
