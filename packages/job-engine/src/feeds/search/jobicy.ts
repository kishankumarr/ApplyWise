import type { RawImportedJob } from "../../connectors/types";
import { REMOTE_GLOBAL, REMOTE_INDIA } from "../../locations";
import { titleMatchesKeywords } from "../relevance";
import type { FeedContext, SearchProviderAdapter } from "../types";
import { annualSalary, asArray, asString, htmlToText, httpJson, httpUrl, isWithinDays, mapEmploymentType, stripTags, toIsoDate } from "../util";
import { toSearchJob } from "./shared";

/**
 * Jobicy remote-jobs API (keyless). There is no India geo slug: geo=apac returns APAC and
 * "Anywhere" jobs. Automated checks must not run more than once per hour, so one feed pull is
 * cached and shared by every search; keywords are matched locally.
 * Docs: https://jobi.cy/apidocs
 */

interface JobicyJob {
  id?: number | string;
  url?: string;
  jobTitle?: string;
  companyName?: string;
  jobIndustry?: string[];
  jobType?: string[];
  jobGeo?: string;
  jobLevel?: string;
  jobExcerpt?: string;
  jobDescription?: string;
  pubDate?: string;
  salaryMin?: number | string;
  salaryMax?: number | string;
  salaryCurrency?: string;
  salaryPeriod?: string;
}

interface JobicyResponse {
  jobCount?: number;
  jobs?: JobicyJob[];
}

const FEED_URL = "https://jobicy.com/api/v2/remote-jobs?count=100&geo=apac";
const FEED_TTL_MS = 60 * 60 * 1000;

/** One cached pull per fetch implementation (tests inject their own fetch, so they never share). */
const feedCache = new WeakMap<object, { at: number; data: Promise<JobicyResponse | null> }>();

function loadFeed(ctx: FeedContext): Promise<JobicyResponse | null> {
  const key = ctx.fetch ?? globalThis.fetch;
  const cached = feedCache.get(key);
  if (cached && Date.now() - cached.at < FEED_TTL_MS) return cached.data;
  const data = httpJson<JobicyResponse>(FEED_URL, ctx, { label: "Jobicy" });
  feedCache.set(key, { at: Date.now(), data });
  data.catch(() => {
    if (feedCache.get(key)?.data === data) feedCache.delete(key);
  });
  return data;
}

/** Jobs open to India: explicit India, APAC/Asia (-> "Remote - India") or Anywhere (-> "Remote - Global"). */
function remoteLocation(geo: string | undefined): string | null {
  const parts = (typeof geo === "string" ? geo : "")
    .split(",")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  if (parts.length === 0) return REMOTE_GLOBAL;
  if (parts.some((p) => p === "india" || p === "apac" || p === "asia" || p === "asia pacific")) return REMOTE_INDIA;
  if (parts.some((p) => p === "anywhere" || p === "worldwide")) return REMOTE_GLOBAL;
  return null;
}

function mapJob(job: JobicyJob): RawImportedJob | null {
  const id = asString(job.id);
  const title = stripTags(job.jobTitle);
  const url = httpUrl(job.url);
  const location = remoteLocation(job.jobGeo);
  if (!id || !title || !url || !location) return null;
  const description = htmlToText(job.jobDescription);
  return toSearchJob({
    provider: "jobicy",
    id,
    attribution: "via Jobicy",
    sourceUrl: url,
    text: description || stripTags(job.jobExcerpt) || title,
    descriptionLevel: description ? "FULL" : "SNIPPET",
    hints: {
      title,
      company: stripTags(job.companyName) || undefined,
      location: [location],
      workMode: "remote",
      employmentType: mapEmploymentType(asArray(job.jobType)[0]),
      applyUrl: url,
      postedAt: toIsoDate(job.pubDate),
      ...annualSalary(job.salaryMin, job.salaryMax, job.salaryPeriod, job.salaryCurrency),
    },
  });
}

export const jobicyProvider: SearchProviderAdapter = {
  id: "jobicy",
  label: "Jobicy",
  attribution: { text: "via Jobicy", url: "https://jobicy.com" },
  requiredEnv: [],
  signupUrl: null,
  coverage: "remote",
  descriptionLevel: "FULL",
  isAvailable: () => true,

  async search(query, ctx) {
    const now = ctx.now ?? new Date();
    const data = await loadFeed(ctx);
    const jobs: RawImportedJob[] = [];
    for (const item of asArray(data?.jobs)) {
      const job = mapJob(item);
      if (!job) continue;
      if (!titleMatchesKeywords(job.hints.title ?? "", query.keywords)) continue;
      if (!isWithinDays(job.hints.postedAt, query.maxDaysOld, now)) continue;
      jobs.push(job);
    }
    jobs.sort((a, b) => (b.hints.postedAt ?? "").localeCompare(a.hints.postedAt ?? ""));
    return jobs.slice(0, Math.max(1, query.limit));
  },
};
