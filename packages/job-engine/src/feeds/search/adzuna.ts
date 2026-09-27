import type { RawImportedJob } from "../../connectors/types";
import { REMOTE_INDIA, isRemoteLocation, normalizeLocation } from "../../locations";
import { FeedProviderError, type SearchProviderAdapter, type SearchQuery } from "../types";
import {
  INDIA_CITIES,
  asArray,
  asNumber,
  asString,
  htmlToText,
  httpJson,
  httpUrl,
  isCountryWideIndia,
  mapEmploymentType,
  normalizePlace,
  stripTags,
  toIsoDate,
} from "../util";
import { feedEnv, pageCount, toSearchJob } from "./shared";

/**
 * Adzuna job-search API, India index (country "in"). Operator keys only (ADZUNA_APP_ID/KEY).
 * Descriptions are 500-character snippets; redirect_url must be used for applying (terms).
 * Docs: https://developer.adzuna.com/docs/search
 */

interface AdzunaAd {
  id?: string | number;
  title?: string;
  description?: string;
  created?: string;
  redirect_url?: string;
  company?: { display_name?: string };
  location?: { display_name?: string; area?: string[] };
  salary_min?: number | string;
  salary_max?: number | string;
  salary_is_predicted?: string | number | boolean;
  contract_type?: string;
  contract_time?: string;
}

interface AdzunaResults {
  count?: number;
  results?: AdzunaAd[];
}

const BASE_URL = "https://api.adzuna.com/v1/api/jobs/in/search";
const PER_PAGE = 50;
/** 250 calls/day on the default plan: keep each sync to a few pages. */
const MAX_PAGES = 3;
const LABEL = "Adzuna";
const REMOTE_RE = /\bremote\b|work from home|\bwfh\b/i;

/** Adzuna's India index uses older city names for `where`. */
const ADZUNA_PLACE_NAMES: Record<string, string> = {
  Bengaluru: "Bangalore",
  Gurgaon: "Gurgaon",
  Thiruvananthapuram: "Trivandrum",
};

function isPredicted(value: AdzunaAd["salary_is_predicted"]): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

/** City from display_name ("Whitefield, Bangalore") or area[] (country > state > city > locality). */
function placeOf(ad: AdzunaAd): { location: string | null; remote: boolean } {
  const display = stripTags(ad.location?.display_name);
  const area = asArray(ad.location?.area).filter((a): a is string => typeof a === "string");
  const main = normalizePlace(display || area[area.length - 1] || "");
  for (const value of [display, ...[...area].reverse()]) {
    const city = value ? normalizePlace(value).location : null;
    if (city && INDIA_CITIES.has(city)) return { location: city, remote: main.remote };
  }
  return { location: main.location, remote: main.remote };
}

function mapAd(ad: AdzunaAd): RawImportedJob | null {
  const id = asString(ad.id);
  const title = stripTags(ad.title);
  const url = httpUrl(ad.redirect_url);
  if (!id || !title || !url) return null;
  const description = htmlToText(ad.description);
  const place = placeOf(ad);
  const remote = REMOTE_RE.test(title) || place.remote;
  const salaryMin = asNumber(ad.salary_min);
  const salaryMax = asNumber(ad.salary_max);
  // Adzuna estimates salaries for many ads; only show amounts the advertiser actually stated.
  const salary =
    !isPredicted(ad.salary_is_predicted) && ((salaryMin ?? 0) > 0 || (salaryMax ?? 0) > 0)
      ? { salaryMin: salaryMin || salaryMax, salaryMax: salaryMax || salaryMin, currency: "INR" }
      : {};
  return toSearchJob({
    provider: "adzuna",
    id,
    attribution: "Jobs by Adzuna",
    sourceUrl: url,
    text: description || title,
    descriptionLevel: "SNIPPET",
    hints: {
      title,
      company: stripTags(ad.company?.display_name) || undefined,
      location: remote ? [REMOTE_INDIA] : place.location ? [place.location] : undefined,
      workMode: remote ? "remote" : undefined,
      employmentType: ad.contract_type === "contract" ? "contract" : mapEmploymentType(ad.contract_time),
      applyUrl: url,
      postedAt: toIsoDate(ad.created),
      ...salary,
    },
  });
}

function whereFor(query: SearchQuery): string | null {
  // "India" / "Pan India" would be geocoded to one point with a 25 km radius: search the whole index instead.
  if (!query.location || isRemoteLocation(query.location) || isCountryWideIndia(query.location)) return null;
  const city = normalizeLocation(query.location);
  return ADZUNA_PLACE_NAMES[city] ?? city;
}

export const adzunaProvider: SearchProviderAdapter = {
  id: "adzuna",
  label: "Adzuna",
  attribution: { text: "Jobs by Adzuna", url: "https://www.adzuna.in" },
  requiredEnv: ["ADZUNA_APP_ID", "ADZUNA_APP_KEY"],
  signupUrl: "https://developer.adzuna.com/signup",
  coverage: "india",
  descriptionLevel: "SNIPPET",
  isAvailable: (env) => !!env.ADZUNA_APP_ID?.trim() && !!env.ADZUNA_APP_KEY?.trim(),

  async search(query, ctx) {
    const env = feedEnv(ctx);
    const appId = env.ADZUNA_APP_ID?.trim();
    const appKey = env.ADZUNA_APP_KEY?.trim();
    if (!appId || !appKey) {
      throw new FeedProviderError("Adzuna is not configured. Set ADZUNA_APP_ID and ADZUNA_APP_KEY.", false);
    }
    const limit = Math.max(1, query.limit);
    const perPage = Math.min(PER_PAGE, limit);
    const pages = pageCount(limit, perPage, MAX_PAGES);
    const remoteOnly = query.remoteOnly || (!!query.location && isRemoteLocation(query.location));
    const where = remoteOnly ? null : whereFor(query);
    const jobs: RawImportedJob[] = [];
    const seen = new Set<string>();

    for (let page = 1; page <= pages && jobs.length < limit; page++) {
      const params = new URLSearchParams({
        app_id: appId,
        app_key: appKey,
        results_per_page: String(perPage),
        sort_by: "date",
        "content-type": "application/json",
      });
      if (query.keywords.trim()) params.set("what", query.keywords.trim());
      if (query.maxDaysOld > 0) params.set("max_days_old", String(Math.ceil(query.maxDaysOld)));
      if (where) {
        params.set("where", where);
        params.set("distance", "25");
      }
      // No remote filter in the API: ask for remote wording, then verify locally.
      if (remoteOnly) params.set("what_or", "remote wfh");
      const data = await httpJson<AdzunaResults>(`${BASE_URL}/${page}?${params.toString()}`, ctx, { label: LABEL, keyed: true });
      const results = Array.isArray(data?.results) ? data.results : [];
      for (const ad of results) {
        const job = mapAd(ad);
        if (!job?.externalId || seen.has(job.externalId)) continue;
        if (remoteOnly && !(job.hints.workMode === "remote" || (REMOTE_RE.test(job.text) && !/\b(no|not) remote\b/i.test(job.text)))) {
          continue;
        }
        if (remoteOnly) {
          job.hints.workMode = "remote";
          job.hints.location = [REMOTE_INDIA];
        }
        seen.add(job.externalId);
        jobs.push(job);
      }
      if (results.length < perPage || (typeof data?.count === "number" && data.count <= page * perPage)) break;
    }
    return jobs.slice(0, limit);
  },
};
