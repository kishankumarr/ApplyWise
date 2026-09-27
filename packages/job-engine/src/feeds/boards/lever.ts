import type { BoardAdapter, FeedContext } from "../types";
import { annualSalary, asArray, asString, htmlToText, httpJson, httpUrl, joinSections, mapEmploymentType, summarizePlaces, toIsoDate } from "../util";
import { cleanSlug, directoryName, fallbackCompany, notFoundError, pathSegments, requireSlug, toBoardJob } from "./shared";
import { slugCandidatesFor } from "./slugs";

/**
 * Lever Postings API (public, no auth). Site names are case-sensitive (always lowercase); EU
 * accounts live on api.eu.lever.co and return 404 on the global host. No company name is returned.
 * Docs: https://github.com/lever/postings-api
 */

interface LeverPosting {
  id?: string;
  text?: string;
  hostedUrl?: string;
  applyUrl?: string;
  createdAt?: number;
  country?: string;
  workplaceType?: string;
  categories?: { commitment?: string; department?: string; location?: string; team?: string; allLocations?: string[] };
  description?: string;
  descriptionPlain?: string;
  lists?: { text?: string; content?: string }[];
  additional?: string;
  additionalPlain?: string;
  salaryRange?: { currency?: string; interval?: string; min?: number; max?: number };
}

const HOSTS = { global: "api.lever.co", eu: "api.eu.lever.co" } as const;
const LABEL = "Lever";
/** Sites known to be on the EU host (seeded from the directory, learned at runtime). */
const euSites = new Set<string>(["lionbridge"]);

async function listPostings(site: string, ctx: FeedContext): Promise<{ postings: LeverPosting[]; eu: boolean } | null> {
  const order = euSites.has(site) ? [true, false] : [false, true];
  for (const eu of order) {
    const url = `https://${eu ? HOSTS.eu : HOSTS.global}/v0/postings/${encodeURIComponent(site)}?mode=json`;
    const data = await httpJson<LeverPosting[]>(url, ctx, { label: LABEL, allowNotFound: true });
    if (data === null) continue;
    if (eu) euSites.add(site);
    else euSites.delete(site);
    return { postings: asArray(data).filter((p) => p && typeof p === "object"), eu };
  }
  return null;
}

function boardUrl(site: string, eu: boolean): string {
  return `https://jobs.${eu ? "eu." : ""}lever.co/${encodeURIComponent(site)}`;
}

function describe(p: LeverPosting): string {
  // Each list is a heading ("what you'll need:") directly above its bullets.
  const lists = asArray(p.lists).map((l) =>
    [asString(l?.text), htmlToText(`<ul>${asString(l?.content) ?? ""}</ul>`)].filter(Boolean).join("\n"),
  );
  const body = htmlToText(asString(p.description)) || (asString(p.descriptionPlain) ?? "");
  const additional = htmlToText(asString(p.additional)) || (asString(p.additionalPlain) ?? "");
  return joinSections(body, ...lists, additional);
}

function workplace(value: string | undefined): { remote?: boolean; hybrid?: boolean; onsite?: boolean } {
  const v = (value ?? "").toLowerCase();
  return { remote: v === "remote", hybrid: v === "hybrid", onsite: v === "onsite" || v === "on-site" };
}

export const leverBoardAdapter: BoardAdapter = {
  id: "lever",
  label: LABEL,

  slugFromUrl(url) {
    const host = url.hostname.toLowerCase();
    const segs = pathSegments(url);
    if (host === "jobs.lever.co" || host === "jobs.eu.lever.co") return cleanSlug(segs[0])?.toLowerCase() ?? null;
    if ((host === HOSTS.global || host === HOSTS.eu) && segs[0] === "v0" && segs[1] === "postings") {
      return cleanSlug(segs[2])?.toLowerCase() ?? null;
    }
    return null;
  },

  slugCandidates: (name) => slugCandidatesFor("lever", name),

  async probe(slug, ctx) {
    const site = cleanSlug(slug)?.toLowerCase();
    if (!site) return null;
    const result = await listPostings(site, ctx);
    if (!result || result.postings.length === 0) return null;
    return {
      provider: "lever",
      slug: site,
      companyName: directoryName("lever", site),
      jobCount: result.postings.length,
      boardUrl: boardUrl(site, result.eu),
    };
  },

  async fetchJobs(slug, ctx) {
    const site = requireSlug(slug, LABEL).toLowerCase();
    const result = await listPostings(site, ctx);
    if (!result) throw notFoundError(LABEL, site);
    const companyName = directoryName("lever", site);
    const company = fallbackCompany("lever", site);
    const jobs = result.postings.flatMap((p) => {
      const id = asString(p.id);
      const title = asString(p.text);
      if (!id || !title) return [];
      const cats = p.categories ?? {};
      const allLocations = asArray(cats.allLocations).length > 0 ? asArray(cats.allLocations).map(asString) : [asString(cats.location)];
      const places = summarizePlaces(allLocations, { country: asString(p.country), ...workplace(asString(p.workplaceType)) });
      const text = describe(p);
      const hosted = httpUrl(p.hostedUrl);
      const salary = p.salaryRange
        ? annualSalary(p.salaryRange.min, p.salaryRange.max, p.salaryRange.interval, p.salaryRange.currency)
        : {};
      return [
        toBoardJob({
          provider: "lever",
          platform: "LEVER",
          label: LABEL,
          slug: site,
          id,
          company,
          sourceUrl: hosted ?? null,
          text: text || title,
          descriptionLevel: text ? "FULL" : "SNIPPET",
          hints: {
            title,
            location: places.locations,
            workMode: places.workMode,
            employmentType: mapEmploymentType(cats.commitment),
            applyUrl: httpUrl(p.applyUrl) ?? hosted,
            postedAt: toIsoDate(p.createdAt),
            ...salary,
          },
        }),
      ];
    });
    return { companyName, jobs };
  },
};
