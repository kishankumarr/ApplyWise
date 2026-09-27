import type { BoardAdapter, FeedContext } from "../types";
import { asArray, asNumber, asString, htmlToText, httpJson, httpUrl, mapEmploymentType, summarizePlaces, toIsoDate } from "../util";
import { cleanSlug, directoryName, fallbackCompany, notFoundError, pathSegments, requireSlug, toBoardJob } from "./shared";
import { slugCandidatesFor } from "./slugs";

/**
 * Ashby public job-posting API (no auth). Board names are case-insensitive; unknown boards 404
 * but some names return 200 with no jobs, which does not confirm a board. Jobs with
 * isListed === false are only meant to be reachable by direct link and are skipped.
 * Docs: https://developers.ashbyhq.com/docs/public-job-posting-api
 */

interface AshbyJob {
  id?: string;
  title?: string;
  employmentType?: string;
  location?: string;
  secondaryLocations?: { location?: string }[];
  publishedAt?: string;
  isListed?: boolean;
  isRemote?: boolean | null;
  workplaceType?: string | null;
  address?: { postalAddress?: { addressLocality?: string; addressRegion?: string; addressCountry?: string } };
  jobUrl?: string;
  applyUrl?: string;
  descriptionHtml?: string;
  descriptionPlain?: string;
  compensation?: {
    summaryComponents?: { compensationType?: string; interval?: string; currencyCode?: string; minValue?: number; maxValue?: number }[];
  };
}

interface AshbyBoard {
  jobs?: AshbyJob[];
}

const API = "https://api.ashbyhq.com/posting-api/job-board";
const LABEL = "Ashby";

async function listJobs(org: string, ctx: FeedContext, compensation: boolean): Promise<AshbyJob[] | null> {
  const url = `${API}/${encodeURIComponent(org)}${compensation ? "?includeCompensation=true" : ""}`;
  const data = await httpJson<AshbyBoard>(url, ctx, { label: LABEL, allowNotFound: true });
  if (!data) return null;
  return asArray(data.jobs).filter((j) => j && typeof j === "object" && j.isListed !== false);
}

function salaryOf(job: AshbyJob): { salaryMin?: number; salaryMax?: number; currency?: string } {
  const salary = asArray(job.compensation?.summaryComponents).find(
    (c) => /salary/i.test(c.compensationType ?? "") && /year/i.test(c.interval ?? ""),
  );
  const min = asNumber(salary?.minValue);
  const max = asNumber(salary?.maxValue);
  const currency = asString(salary?.currencyCode);
  if (!salary || !currency || (min === undefined && max === undefined)) return {};
  return { salaryMin: min ?? max, salaryMax: max ?? min, currency };
}

export const ashbyBoardAdapter: BoardAdapter = {
  id: "ashby",
  label: LABEL,

  slugFromUrl(url) {
    const host = url.hostname.toLowerCase();
    const segs = pathSegments(url);
    if (host === "jobs.ashbyhq.com") return cleanSlug(segs[0]);
    if (host === "api.ashbyhq.com" && segs[0] === "posting-api" && segs[1] === "job-board") return cleanSlug(segs[2]);
    return null;
  },

  slugCandidates: (name) => slugCandidatesFor("ashby", name),

  async probe(slug, ctx) {
    const org = cleanSlug(slug);
    if (!org) return null;
    const jobs = await listJobs(org, ctx, false);
    if (!jobs || jobs.length === 0) return null;
    return {
      provider: "ashby",
      slug: org,
      companyName: directoryName("ashby", org),
      jobCount: jobs.length,
      boardUrl: `https://jobs.ashbyhq.com/${encodeURIComponent(org)}`,
    };
  },

  async fetchJobs(slug, ctx) {
    const org = requireSlug(slug, LABEL);
    const list = await listJobs(org, ctx, true);
    if (!list) throw notFoundError(LABEL, org);
    const companyName = directoryName("ashby", org);
    const company = fallbackCompany("ashby", org);
    const jobs = list.flatMap((job) => {
      const id = asString(job.id);
      const title = asString(job.title);
      if (!id || !title) return [];
      const addr = job.address?.postalAddress;
      const mode = (asString(job.workplaceType) ?? "").toLowerCase();
      const places = summarizePlaces(
        [asString(job.location), ...asArray(job.secondaryLocations).map((s) => asString(s?.location))],
        {
          country: asString(addr?.addressCountry),
          remote: job.isRemote === true || mode === "remote",
          hybrid: mode === "hybrid",
          onsite: mode === "onsite",
        },
      );
      const text = htmlToText(asString(job.descriptionHtml)) || (asString(job.descriptionPlain) ?? "");
      const jobUrl = httpUrl(job.jobUrl);
      return [
        toBoardJob({
          provider: "ashby",
          platform: "ASHBY",
          label: LABEL,
          slug: org,
          id,
          company,
          sourceUrl: jobUrl ?? null,
          text: text || title,
          descriptionLevel: text ? "FULL" : "SNIPPET",
          hints: {
            title,
            location: places.locations,
            workMode: places.workMode,
            employmentType: mapEmploymentType(job.employmentType),
            applyUrl: httpUrl(job.applyUrl) ?? jobUrl,
            postedAt: toIsoDate(job.publishedAt),
            ...salaryOf(job),
          },
        }),
      ];
    });
    return { companyName, jobs };
  },
};
