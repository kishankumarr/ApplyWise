import type { BoardAdapter, FeedContext } from "../types";
import { annualSalary, asArray, asString, htmlToText, httpJson, httpUrl, joinSections, mapEmploymentType, summarizePlaces, toIsoDate } from "../util";
import { cleanSlug, notFoundError, requireSlug, toBoardJob } from "./shared";
import { slugCandidatesFor } from "./slugs";

/**
 * Recruitee careers-site API (public, no auth): https://{company}.recruitee.com/api/offers/.
 * Locations carry diacritics ("Telangāna"), published_at is "2026-08-27 07:29:25 UTC".
 * Docs: https://docs.recruitee.com/reference/intro-to-careers-site-api
 */

interface RecruiteeOffer {
  id?: number | string;
  title?: string;
  status?: string;
  company_name?: string;
  location?: string;
  city?: string;
  state_name?: string;
  country?: string;
  country_code?: string;
  locations?: { name?: string; city?: string; state?: string; country?: string; country_code?: string }[];
  remote?: boolean;
  hybrid?: boolean;
  on_site?: boolean;
  description?: string;
  requirements?: string;
  employment_type_code?: string;
  careers_url?: string;
  careers_apply_url?: string;
  published_at?: string;
  created_at?: string;
  salary?: { min?: string | number | null; max?: string | number | null; period?: string | null; currency?: string | null };
}

interface RecruiteeOffers {
  offers?: RecruiteeOffer[];
}

const LABEL = "Recruitee";
const RESERVED_SUBDOMAINS = /^(www|app|docs|api|blog|support|help|status|careers)$/i;

async function loadOffers(company: string, ctx: FeedContext): Promise<RecruiteeOffer[] | null> {
  // The company is a DNS label here, so it must be strictly [a-z0-9-].
  const url = `https://${company}.recruitee.com/api/offers/`;
  const data = await httpJson<RecruiteeOffers>(url, ctx, { label: LABEL, allowNotFound: true });
  if (!data) return null;
  return asArray(data.offers).filter((o) => o && typeof o === "object" && (!o.status || o.status === "published"));
}

function subdomain(value: string | null | undefined): string | null {
  const slug = cleanSlug(value)?.toLowerCase();
  return slug && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(slug) ? slug : null;
}

export const recruiteeBoardAdapter: BoardAdapter = {
  id: "recruitee",
  label: LABEL,

  slugFromUrl(url) {
    const sub = /^([a-z0-9-]+)\.recruitee\.com$/.exec(url.hostname.toLowerCase())?.[1];
    return sub && !RESERVED_SUBDOMAINS.test(sub) ? subdomain(sub) : null;
  },

  slugCandidates: (name) => slugCandidatesFor("recruitee", name),

  async probe(slug, ctx) {
    const company = subdomain(slug);
    if (!company) return null;
    const offers = await loadOffers(company, ctx);
    if (!offers || offers.length === 0) return null;
    return {
      provider: "recruitee",
      slug: company,
      companyName: asString(offers[0]?.company_name) ?? null,
      jobCount: offers.length,
      boardUrl: `https://${company}.recruitee.com/`,
    };
  },

  async fetchJobs(slug, ctx) {
    const company = subdomain(requireSlug(slug, LABEL));
    if (!company) throw notFoundError(LABEL, slug);
    const offers = await loadOffers(company, ctx);
    if (!offers) throw notFoundError(LABEL, company);
    const companyName = asString(offers[0]?.company_name) ?? null;
    const jobs = offers.flatMap((o) => {
      const id = asString(o.id);
      const title = asString(o.title);
      if (!id || !title) return [];
      const locs = asArray(o.locations).filter((l) => l && typeof l === "object");
      const raws = locs.length > 0
        ? locs.map((l) => [asString(l.city) ?? asString(l.name), asString(l.state), asString(l.country)].filter(Boolean).join(", "))
        : [asString(o.location)];
      const india = locs.some((l) => asString(l.country_code)?.toUpperCase() === "IN") || asString(o.country_code)?.toUpperCase() === "IN";
      const places = summarizePlaces(raws, {
        india,
        country: asString(locs[0]?.country_code) ?? asString(o.country_code),
        remote: o.remote === true,
        hybrid: o.hybrid === true,
        onsite: o.on_site === true,
        split: false,
      });
      const requirements = htmlToText(asString(o.requirements));
      const text = joinSections(htmlToText(asString(o.description)), requirements && `Requirements\n${requirements}`);
      const page = httpUrl(o.careers_url);
      return [
        toBoardJob({
          provider: "recruitee",
          platform: "RECRUITEE",
          label: LABEL,
          slug: company,
          id,
          company: asString(o.company_name) ?? companyName ?? company,
          sourceUrl: page ?? null,
          text: text || title,
          descriptionLevel: text ? "FULL" : "SNIPPET",
          hints: {
            title,
            location: places.locations,
            workMode: places.workMode,
            employmentType: mapEmploymentType(o.employment_type_code),
            applyUrl: httpUrl(o.careers_apply_url) ?? page,
            postedAt: toIsoDate(o.published_at) ?? toIsoDate(o.created_at),
            ...(o.salary ? annualSalary(o.salary.min, o.salary.max, o.salary.period, o.salary.currency) : {}),
          },
        }),
      ];
    });
    return { companyName, jobs };
  },
};
