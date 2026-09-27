import type { BoardAdapter, FeedContext } from "../types";
import { asArray, asString, htmlToText, httpJson, httpUrl, joinSections, mapEmploymentType, summarizePlaces, toIsoDate } from "../util";
import { cleanSlug, notFoundError, pathSegments, requireSlug, toBoardJob } from "./shared";
import { slugCandidatesFor } from "./slugs";

/**
 * Workable public careers widget API (no auth; www.workable.com/api/accounts/{sub} redirects here).
 * Dormant accounts return 200 with an empty job list, which does not confirm a board. Job links
 * like apply.workable.com/j/{shortcode} do not name the account and cannot be resolved.
 * Docs: https://help.workable.com/hc/en-us/articles/115012771647
 */

interface WorkableJob {
  title?: string;
  shortcode?: string;
  employment_type?: string;
  telecommuting?: boolean;
  url?: string;
  shortlink?: string;
  application_url?: string;
  published_on?: string;
  created_at?: string;
  country?: string;
  city?: string;
  state?: string;
  locations?: { country?: string; countryCode?: string; city?: string; region?: string | null; hidden?: boolean }[];
  description?: string;
  requirements?: string;
  benefits?: string;
}

interface WorkableAccount {
  name?: string;
  jobs?: WorkableJob[];
}

const API = "https://apply.workable.com/api/v1/widget/accounts";
const LABEL = "Workable";
const RESERVED_SUBDOMAINS = /^(www|apply|jobs|help|resources|api|app|id|blog|developers|status)$/i;
const RESERVED_PATHS = /^(j|api|careers|static|assets)$/i;

async function loadAccount(sub: string, ctx: FeedContext, details: boolean): Promise<WorkableAccount | null> {
  const url = `${API}/${encodeURIComponent(sub)}${details ? "?details=true" : ""}`;
  return httpJson<WorkableAccount>(url, ctx, { label: LABEL, allowNotFound: true });
}

export const workableBoardAdapter: BoardAdapter = {
  id: "workable",
  label: LABEL,

  slugFromUrl(url) {
    const host = url.hostname.toLowerCase();
    const segs = pathSegments(url);
    if (host === "apply.workable.com") {
      if (segs[0] === "api" && segs[1] === "v1" && segs[2] === "widget" && segs[3] === "accounts") return cleanSlug(segs[4]);
      if (!segs[0] || RESERVED_PATHS.test(segs[0])) return null; // /j/{shortcode} has no account
      return cleanSlug(segs[0]);
    }
    if (host === "www.workable.com" && segs[0] === "api" && segs[1] === "accounts") return cleanSlug(segs[2]);
    const sub = /^([a-z0-9-]+)\.workable\.com$/.exec(host)?.[1];
    if (sub && !RESERVED_SUBDOMAINS.test(sub)) return cleanSlug(sub);
    return null;
  },

  slugCandidates: (name) => slugCandidatesFor("workable", name),

  async probe(slug, ctx) {
    const sub = cleanSlug(slug);
    if (!sub) return null;
    const account = await loadAccount(sub, ctx, false);
    const jobs = asArray(account?.jobs);
    if (!account || jobs.length === 0) return null;
    return {
      provider: "workable",
      slug: sub,
      companyName: asString(account.name) ?? null,
      jobCount: jobs.length,
      boardUrl: `https://apply.workable.com/${encodeURIComponent(sub)}/`,
    };
  },

  async fetchJobs(slug, ctx) {
    const sub = requireSlug(slug, LABEL);
    const account = await loadAccount(sub, ctx, true);
    if (!account) throw notFoundError(LABEL, sub);
    const companyName = asString(account.name) ?? null;
    const jobs = asArray(account.jobs).flatMap((job) => {
      if (!job || typeof job !== "object") return [];
      const id = asString(job.shortcode);
      const title = asString(job.title);
      if (!id || !title) return [];
      const visible = asArray(job.locations).filter((l) => l && typeof l === "object" && !l.hidden);
      const raws = visible.length > 0 ? visible.map((l) => [l.city, l.region, l.country].filter(Boolean).join(", ")) : [
        [job.city, job.state, job.country].filter(Boolean).join(", "),
      ];
      const india = visible.some((l) => asString(l.countryCode)?.toUpperCase() === "IN") || /^india$/i.test(asString(job.country) ?? "");
      const country = asString(visible[0]?.countryCode) ?? asString(job.country);
      const places = summarizePlaces(raws, { india, country, remote: job.telecommuting === true, split: false });
      const text = joinSections(htmlToText(asString(job.description)), htmlToText(asString(job.requirements)), htmlToText(asString(job.benefits)));
      const page = httpUrl(job.url) ?? httpUrl(job.shortlink);
      return [
        toBoardJob({
          provider: "workable",
          platform: "WORKABLE",
          label: LABEL,
          slug: sub,
          id,
          company: companyName ?? sub,
          sourceUrl: page ?? null,
          text: text || title,
          descriptionLevel: text ? "FULL" : "SNIPPET",
          hints: {
            title,
            location: places.locations,
            workMode: places.workMode,
            employmentType: mapEmploymentType(job.employment_type),
            applyUrl: httpUrl(job.application_url) ?? page,
            postedAt: toIsoDate(job.published_on) ?? toIsoDate(job.created_at),
          },
        }),
      ];
    });
    return { companyName, jobs };
  },
};
