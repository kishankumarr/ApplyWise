import type { RawImportedJob } from "../../connectors/types";
import { REMOTE_GLOBAL, REMOTE_INDIA } from "../../locations";
import type { SearchProviderAdapter } from "../types";
import { annualSalary, asArray, asString, htmlToText, httpJson, httpUrl, isWithinDays, mapEmploymentType, stripTags, toIsoDate } from "../util";
import { pageCount, toSearchJob } from "./shared";

/**
 * Himalayas remote-jobs search API (keyless). country=IN returns jobs open to India plus
 * worldwide jobs. Terms: link back to the Himalayas job page and credit Himalayas.
 * Docs: https://himalayas.app/api (OpenAPI: https://himalayas.app/docs/openapi.json)
 */

type Restriction = string | { alpha2?: string; name?: string; slug?: string } | null;

interface HimalayasJob {
  title?: string;
  excerpt?: string;
  companyName?: string;
  employmentType?: string;
  minSalary?: number | null;
  maxSalary?: number | null;
  salaryPeriod?: string | null;
  currency?: string | null;
  locationRestrictions?: Restriction[] | null;
  description?: string;
  pubDate?: number | string;
  expiryDate?: number | string;
  applicationLink?: string;
  guid?: string;
}

interface HimalayasResponse {
  offset?: number;
  limit?: number;
  totalCount?: number;
  jobs?: HimalayasJob[];
}

const BASE_URL = "https://himalayas.app/jobs/api/search";
const PER_PAGE = 20;
const MAX_PAGES = 3;

/** "Remote - India" / "Remote - Global", or null when the job is restricted to other countries. */
function remoteLocation(restrictions: HimalayasJob["locationRestrictions"]): string | null {
  // The spec documents objects {alpha2,name,slug}; live responses send plain strings.
  const names = asArray(restrictions)
    .map((r) => (typeof r === "string" ? r : (asString(r?.name) ?? asString(r?.alpha2) ?? asString(r?.slug) ?? "")))
    .map((n) => n.trim())
    .filter(Boolean);
  if (names.length === 0) return REMOTE_GLOBAL;
  return names.some((n) => /^(india|in)$/i.test(n)) ? REMOTE_INDIA : null;
}

function mapJob(job: HimalayasJob): RawImportedJob | null {
  const title = stripTags(job.title);
  const link = httpUrl(job.applicationLink) ?? httpUrl(job.guid);
  const id = asString(job.guid) ?? link;
  const location = remoteLocation(job.locationRestrictions);
  if (!title || !link || !id || !location) return null;
  const description = htmlToText(job.description);
  return toSearchJob({
    provider: "himalayas",
    id,
    attribution: "via Himalayas",
    sourceUrl: link,
    text: description || stripTags(job.excerpt) || title,
    descriptionLevel: description ? "FULL" : "SNIPPET",
    hints: {
      title,
      company: stripTags(job.companyName) || undefined,
      location: [location],
      workMode: "remote",
      employmentType: mapEmploymentType(job.employmentType),
      applyUrl: link,
      postedAt: toIsoDate(job.pubDate),
      expiresAt: toIsoDate(job.expiryDate),
      ...annualSalary(job.minSalary, job.maxSalary, job.salaryPeriod, job.currency),
    },
  });
}

export const himalayasProvider: SearchProviderAdapter = {
  id: "himalayas",
  label: "Himalayas",
  attribution: { text: "via Himalayas", url: "https://himalayas.app" },
  requiredEnv: [],
  signupUrl: null,
  coverage: "remote",
  descriptionLevel: "FULL",
  isAvailable: () => true,

  async search(query, ctx) {
    const now = ctx.now ?? new Date();
    const limit = Math.max(1, query.limit);
    const pages = pageCount(limit, PER_PAGE, MAX_PAGES);
    const jobs: RawImportedJob[] = [];
    const seen = new Set<string>();

    for (let page = 1; page <= pages && jobs.length < limit; page++) {
      const params = new URLSearchParams({ country: "IN", sort: "recent", page: String(page) });
      if (query.keywords.trim()) params.set("q", query.keywords.trim());
      const data = await httpJson<HimalayasResponse>(`${BASE_URL}?${params.toString()}`, ctx, { label: "Himalayas" });
      const results = Array.isArray(data?.jobs) ? data.jobs : [];
      let recent = 0;
      for (const item of results) {
        if (!isWithinDays(toIsoDate(item.pubDate), query.maxDaysOld, now)) continue;
        recent++;
        const job = mapJob(item);
        if (!job?.externalId || seen.has(job.externalId)) continue;
        seen.add(job.externalId);
        jobs.push(job);
      }
      const total = typeof data?.totalCount === "number" ? data.totalCount : Infinity;
      // sort=recent is only roughly ordered: stop on a page with no recent jobs, not at the first old one.
      if (results.length === 0 || recent === 0 || page * PER_PAGE >= total) break;
    }
    return jobs.slice(0, limit);
  },
};
