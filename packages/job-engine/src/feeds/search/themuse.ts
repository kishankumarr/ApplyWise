import type { RawImportedJob } from "../../connectors/types";
import { REMOTE_INDIA, isRemoteLocation, normalizeLocation } from "../../locations";
import { titleMatchesKeywords } from "../relevance";
import type { SearchProviderAdapter } from "../types";
import {
  asArray,
  asString,
  htmlToText,
  httpJson,
  httpUrl,
  isCountryWideIndia,
  isIndiaLocation,
  isWithinDays,
  normalizePlace,
  stripTags,
  toIsoDate,
} from "../util";
import { feedEnv, toSearchJob } from "./shared";

/**
 * The Muse public jobs API: multinational employers in Indian cities. There is no keyword
 * parameter, so results are fetched by Indian city (+ category) and titles are filtered locally.
 * Results are not date-sorted and include stale and US-remote jobs, which are dropped.
 * Optional THE_MUSE_API_KEY raises the limit from 500 to 3600 requests/hour.
 * Docs: https://www.themuse.com/developers/api/v2
 */

interface MuseJob {
  id?: number | string;
  name?: string;
  contents?: string;
  publication_date?: string;
  locations?: { name?: string }[];
  levels?: { name?: string }[];
  refs?: { landing_page?: string };
  company?: { name?: string };
}

interface MuseResponse {
  page?: number;
  page_count?: number;
  results?: MuseJob[];
}

const BASE_URL = "https://www.themuse.com/api/public/jobs";
/** Local filtering discards most of each page; scan a few pages per search. */
const MAX_PAGES = 5;

const NCR = ["New Delhi, India", "Gurgaon, India", "Noida, India", "Greater Noida, India"];
/** The Muse location names (note: "Bengaluru, India" does not work as a filter). */
const MUSE_CITIES: Record<string, string[]> = {
  Bengaluru: ["Bangalore, India"],
  Hyderabad: ["Hyderabad, India"],
  Pune: ["Pune, India"],
  Mumbai: ["Mumbai, India"],
  Chennai: ["Chennai, India"],
  Delhi: NCR,
  Gurgaon: NCR,
  Noida: NCR,
  Ahmedabad: ["Ahmedabad, India"],
  Jaipur: ["Jaipur, India"],
  Coimbatore: ["Coimbatore, India"],
  Indore: ["Indore, India"],
  Chandigarh: ["Chandigarh, India"],
  Thiruvananthapuram: ["Thiruvananthapuram, India"],
};
const DEFAULT_CITIES = [
  "Bangalore, India",
  "Hyderabad, India",
  "Pune, India",
  "Mumbai, India",
  "Chennai, India",
  "Gurgaon, India",
  "Noida, India",
  "New Delhi, India",
];

const CATEGORY_RULES: [RegExp, string[]][] = [
  [/data scien|machine learning|\bml\b|\bai\b|analytics|analyst/i, ["Data Science", "Data and Analytics"]],
  [/product manag|\bpm\b|product owner/i, ["Product Management", "Product"]],
  [/design|\bux\b/i, ["Design and UX", "UX", "Design"]],
  [/devops|\bsre\b|cloud|infrastructure|sysadmin|system admin|\bit\b/i, ["Computer and IT", "IT", "Software Engineering"]],
  [
    /engineer|developer|\bsde\b|software|front ?-?end|back ?-?end|full ?-?stack|mobile|android|ios|\bqa\b|sdet|test|programmer/i,
    ["Software Engineering", "Software Engineer"],
  ],
];

function categoriesFor(keywords: string): string[] {
  const out = new Set<string>();
  for (const [re, categories] of CATEGORY_RULES) if (re.test(keywords)) categories.forEach((c) => out.add(c));
  return [...out];
}

function mapJob(job: MuseJob): { raw: RawImportedJob; flexible: boolean } | null {
  const id = asString(job.id);
  const title = stripTags(job.name);
  const url = httpUrl(job.refs?.landing_page);
  if (!id || !title || !url) return null;
  const names = asArray(job.locations).map((l) => asString(l?.name) ?? "").filter(Boolean);
  const flexible = names.some((n) => /flexible|remote/i.test(n));
  const indian = names.filter((n) => !/flexible|remote/i.test(n) && isIndiaLocation(n));
  if (indian.length === 0) return null;
  const locations = [
    ...new Set([...indian.map((n) => normalizePlace(n).location ?? n), ...(flexible ? [REMOTE_INDIA] : [])]),
  ];
  const intern = asArray(job.levels).some((l) => /intern/i.test(asString(l?.name) ?? ""));
  return {
    flexible,
    raw: toSearchJob({
      provider: "themuse",
      id,
      attribution: "via The Muse",
      sourceUrl: url,
      text: htmlToText(job.contents) || title,
      descriptionLevel: "FULL",
      hints: {
        title,
        company: stripTags(job.company?.name) || undefined,
        location: locations,
        employmentType: intern ? "internship" : undefined,
        applyUrl: url,
        postedAt: toIsoDate(job.publication_date),
      },
    }),
  };
}

export const theMuseProvider: SearchProviderAdapter = {
  id: "themuse",
  label: "The Muse",
  attribution: { text: "via The Muse", url: "https://www.themuse.com" },
  requiredEnv: [],
  signupUrl: "https://www.themuse.com/developers/api/v2/apps",
  coverage: "india",
  descriptionLevel: "FULL",
  isAvailable: () => true,

  async search(query, ctx) {
    const now = ctx.now ?? new Date();
    const limit = Math.max(1, query.limit);
    const remoteOnly = query.remoteOnly || (!!query.location && isRemoteLocation(query.location));
    // "India" / "Pan India" means every Indian city, not an unknown one.
    const anyCity = !query.location || isRemoteLocation(query.location) || isCountryWideIndia(query.location);
    const cities = anyCity ? DEFAULT_CITIES : MUSE_CITIES[normalizeLocation(query.location!)];
    if (!cities) return []; // The Muse has no listings for that city.
    const apiKey = feedEnv(ctx).THE_MUSE_API_KEY?.trim();
    const categories = categoriesFor(query.keywords);
    const jobs: RawImportedJob[] = [];
    const seen = new Set<string>();

    for (let page = 0; page < MAX_PAGES && jobs.length < limit; page++) {
      const params = new URLSearchParams({ page: String(page) });
      for (const city of cities) params.append("location", city);
      for (const category of categories) params.append("category", category);
      if (apiKey) params.set("api_key", apiKey);
      const data = await httpJson<MuseResponse>(`${BASE_URL}?${params.toString()}`, ctx, { label: "The Muse", keyed: !!apiKey });
      const results = asArray(data?.results);
      for (const item of results) {
        const mapped = mapJob(item);
        if (!mapped?.raw.externalId || seen.has(mapped.raw.externalId)) continue;
        if (remoteOnly && !mapped.flexible) continue;
        if (!titleMatchesKeywords(mapped.raw.hints.title ?? "", query.keywords)) continue;
        if (!isWithinDays(mapped.raw.hints.postedAt, query.maxDaysOld, now)) continue;
        seen.add(mapped.raw.externalId);
        jobs.push(mapped.raw);
      }
      const pageCountTotal = typeof data?.page_count === "number" ? data.page_count : 0;
      if (results.length === 0 || page + 1 >= pageCountTotal) break;
    }
    return jobs.slice(0, limit);
  },
};
