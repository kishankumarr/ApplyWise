import type { BoardAdapter, FeedContext } from "../types";
import { asArray, asString, decodeEntities, htmlToText, httpJson, httpUrl, summarizePlaces, toIsoDate } from "../util";
import { cleanSlug, directoryName, fallbackCompany, notFoundError, pathSegments, requireSlug, toBoardJob } from "./shared";
import { slugCandidatesFor } from "./slugs";

/**
 * Greenhouse Job Board API (public GET endpoints, no auth). Board tokens are case-insensitive and
 * EU-instance boards are served by the same API host.
 * Docs: https://docs.greenhouse.io/job-board.html
 */

interface GreenhouseJob {
  id?: number | string;
  title?: string;
  company_name?: string;
  absolute_url?: string;
  location?: { name?: string };
  offices?: { name?: string; location?: string | null }[];
  content?: string;
  first_published?: string;
  updated_at?: string;
}

interface GreenhouseJobs {
  jobs?: GreenhouseJob[];
  meta?: { total?: number };
}

const API = "https://boards-api.greenhouse.io/v1/boards";
const LABEL = "Greenhouse";
const BOARD_HOST_RE = /^(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io$/;

/** Public board page; EU boards live on job-boards.eu.greenhouse.io (seen in absolute_url). */
function boardUrl(slug: string, jobs: GreenhouseJob[]): string {
  const host = jobs
    .map((j) => asString(j.absolute_url))
    .map((u) => (u ? /^https:\/\/(job-boards(?:\.eu)?\.greenhouse\.io)\//.exec(u)?.[1] : undefined))
    .find(Boolean);
  return `https://${host ?? "job-boards.greenhouse.io"}/${encodeURIComponent(slug)}`;
}

async function listJobs(slug: string, ctx: FeedContext, content: boolean): Promise<GreenhouseJob[] | null> {
  const url = `${API}/${encodeURIComponent(slug)}/jobs${content ? "?content=true" : ""}`;
  const data = await httpJson<GreenhouseJobs>(url, ctx, { label: LABEL, allowNotFound: true });
  if (!data) return null;
  return asArray(data.jobs).filter((j) => j && typeof j === "object");
}

export const greenhouseBoardAdapter: BoardAdapter = {
  id: "greenhouse",
  label: LABEL,

  slugFromUrl(url) {
    const host = url.hostname.toLowerCase();
    const segs = pathSegments(url);
    if (BOARD_HOST_RE.test(host)) {
      // Embeds: /embed/job_board?for=acme, /embed/job_app?for=acme&token=123
      if (segs[0] === "embed") return cleanSlug(url.searchParams.get("for"));
      return cleanSlug(segs[0]);
    }
    if (host === "boards-api.greenhouse.io" && segs[0] === "v1" && segs[1] === "boards") return cleanSlug(segs[2]);
    return null;
  },

  slugCandidates: (name) => slugCandidatesFor("greenhouse", name),

  async probe(slug, ctx) {
    const token = cleanSlug(slug);
    if (!token) return null;
    const jobs = await listJobs(token, ctx, false);
    // An empty board (200 with no jobs) does not confirm the company.
    if (!jobs || jobs.length === 0) return null;
    return {
      provider: "greenhouse",
      slug: token,
      companyName: asString(jobs[0]?.company_name) ?? directoryName("greenhouse", token),
      jobCount: jobs.length,
      boardUrl: boardUrl(token, jobs),
    };
  },

  async fetchJobs(slug, ctx) {
    const token = requireSlug(slug, LABEL);
    const jobs = await listJobs(token, ctx, true);
    if (!jobs) throw notFoundError(LABEL, token);
    const companyName = asString(jobs[0]?.company_name) ?? directoryName("greenhouse", token);
    const mapped = jobs.flatMap((job) => {
      const id = asString(job.id);
      const title = asString(job.title);
      const url = httpUrl(job.absolute_url);
      if (!id || !title) return [];
      const company = asString(job.company_name) ?? companyName ?? fallbackCompany("greenhouse", token);
      // Office names are often business units ("RazorpayX"), so only their location strings count.
      const offices = asArray(job.offices).map((o) => asString(o?.location));
      const places = summarizePlaces([asString(job.location?.name), ...offices]);
      // `content` is HTML escaped once (&lt;div&gt;): decode once, then convert to text.
      const text = htmlToText(decodeEntities(asString(job.content) ?? ""));
      return [
        toBoardJob({
          provider: "greenhouse",
          platform: "GREENHOUSE",
          label: LABEL,
          slug: token,
          id,
          company,
          sourceUrl: url ?? null,
          text: text || title,
          descriptionLevel: text ? "FULL" : "SNIPPET",
          hints: {
            title,
            location: places.locations,
            workMode: places.workMode,
            applyUrl: url,
            postedAt: toIsoDate(job.first_published) ?? toIsoDate(job.updated_at),
          },
        }),
      ];
    });
    return { companyName, jobs: mapped };
  },
};
