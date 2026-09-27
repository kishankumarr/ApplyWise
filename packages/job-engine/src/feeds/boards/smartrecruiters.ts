import type { RawImportedJob } from "../../connectors/types";
import type { BoardAdapter } from "../types";
import {
  annualSalary,
  asArray,
  asString,
  htmlToText,
  httpJson,
  httpUrl,
  joinSections,
  mapEmploymentType,
  mapLimit,
  summarizePlaces,
  toIsoDate,
} from "../util";
import { cleanSlug, notFoundError, pathSegments, requireSlug, toBoardJob } from "./shared";
import { slugCandidatesFor } from "./slugs";

/**
 * SmartRecruiters Posting API (public). Unknown companies return 200 with totalFound 0, so an
 * empty list never confirms a board. Descriptions need one detail call per posting: each sync
 * lists the company's India postings and fetches details for the 40 newest only.
 * Docs: https://developers.smartrecruiters.com/docs/posting-api
 */

interface SrPosting {
  id?: string;
  name?: string;
  company?: { identifier?: string; name?: string };
  releasedDate?: string;
  location?: { city?: string; region?: string; country?: string; remote?: boolean; hybrid?: boolean; fullLocation?: string };
  department?: { label?: string };
  function?: { label?: string };
  typeOfEmployment?: { id?: string; label?: string };
  experienceLevel?: { label?: string };
}

interface SrDetail extends SrPosting {
  postingUrl?: string;
  applyUrl?: string;
  jobAd?: { sections?: Record<string, { title?: string; text?: string } | undefined> };
  compensation?: { min?: number; max?: number; currency?: string; period?: string };
}

interface SrList {
  offset?: number;
  limit?: number;
  totalFound?: number;
  content?: SrPosting[];
}

const API = "https://api.smartrecruiters.com/v1/companies";
const LABEL = "SmartRecruiters";
const PAGE_SIZE = 100; // the API silently caps limit at 100
const MAX_LIST_PAGES = 10;
const MAX_DETAILS = 40;
const SECTION_ORDER = ["companyDescription", "jobDescription", "qualifications", "additionalInformation"];

function postingPage(company: string, id: string): string {
  return `https://jobs.smartrecruiters.com/${encodeURIComponent(company)}/${encodeURIComponent(id)}`;
}

function describe(detail: SrDetail | null): string {
  const sections = detail?.jobAd?.sections ?? {};
  const keys = [...SECTION_ORDER, ...Object.keys(sections).filter((k) => !SECTION_ORDER.includes(k))];
  return joinSections(
    ...keys.map((k) => {
      const s = sections[k];
      const body = htmlToText(asString(s?.text));
      return body ? joinSections(asString(s?.title), body) : "";
    }),
  );
}

/** List-only summary used when the detail call is skipped (beyond the 40 newest) or fails. */
function summary(p: SrPosting): string {
  return [
    p.name,
    p.location?.fullLocation && `Location: ${p.location.fullLocation}`,
    p.department?.label && `Department: ${p.department.label}`,
    p.function?.label && `Function: ${p.function.label}`,
    p.typeOfEmployment?.label && `Employment type: ${p.typeOfEmployment.label}`,
    p.experienceLevel?.label && `Experience level: ${p.experienceLevel.label}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export const smartRecruitersBoardAdapter: BoardAdapter = {
  id: "smartrecruiters",
  label: LABEL,

  slugFromUrl(url) {
    const host = url.hostname.toLowerCase();
    const segs = pathSegments(url);
    if (host === "careers.smartrecruiters.com" || host === "jobs.smartrecruiters.com") {
      if (!segs[0] || /^(oneclick-ui|external-referrals|sr-jobs)$/i.test(segs[0])) return null;
      return cleanSlug(segs[0]);
    }
    if (host === "api.smartrecruiters.com" && segs[0] === "v1" && segs[1] === "companies") return cleanSlug(segs[2]);
    return null;
  },

  slugCandidates: (name) => slugCandidatesFor("smartrecruiters", name),

  async probe(slug, ctx) {
    const company = cleanSlug(slug);
    if (!company) return null;
    const data = await httpJson<SrList>(`${API}/${encodeURIComponent(company)}/postings?limit=1`, ctx, {
      label: LABEL,
      allowNotFound: true,
    });
    const total = typeof data?.totalFound === "number" ? data.totalFound : 0;
    if (!data || total === 0) return null;
    return {
      provider: "smartrecruiters",
      slug: company,
      companyName: asString(data.content?.[0]?.company?.name) ?? null,
      jobCount: total,
      boardUrl: `https://careers.smartrecruiters.com/${encodeURIComponent(company)}`,
    };
  },

  async fetchJobs(slug, ctx) {
    const company = requireSlug(slug, LABEL);
    const postings: SrPosting[] = [];
    // Enterprise boards list thousands of global postings; only India postings are synced.
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(page * PAGE_SIZE), country: "in" });
      const data = await httpJson<SrList>(`${API}/${encodeURIComponent(company)}/postings?${params.toString()}`, ctx, {
        label: LABEL,
        allowNotFound: true,
      });
      if (!data) throw notFoundError(LABEL, company);
      const content = asArray(data.content);
      postings.push(...content);
      const total = typeof data.totalFound === "number" ? data.totalFound : 0;
      if (content.length < PAGE_SIZE || postings.length >= total) break;
    }
    // Offset paging can repeat a posting when the list shifts between pages: keep each id once.
    const ids = new Set<string>();
    const valid = postings.filter((p) => {
      const id = p && typeof p === "object" ? asString(p.id) : undefined;
      if (!id || !asString(p.name) || ids.has(id)) return false;
      ids.add(id);
      return true;
    });
    valid.sort((a, b) => (toIsoDate(b.releasedDate) ?? "").localeCompare(toIsoDate(a.releasedDate) ?? ""));
    const companyName = asString(valid[0]?.company?.name) ?? null;

    const details = await mapLimit(valid.slice(0, MAX_DETAILS), 3, async (p) => {
      try {
        return await httpJson<SrDetail>(`${API}/${encodeURIComponent(company)}/postings/${encodeURIComponent(p.id!)}`, ctx, {
          label: LABEL,
          allowNotFound: true,
        });
      } catch {
        return null; // keep the listing with its summary; the next sync retries the detail
      }
    });

    const jobs: RawImportedJob[] = valid.map((p, i) => {
      const detail = details[i] ?? null;
      const id = p.id!;
      const loc = detail?.location ?? p.location ?? {};
      const places = summarizePlaces([loc.fullLocation ?? [loc.city, loc.region].filter(Boolean).join(", ")], {
        country: loc.country,
        remote: loc.remote === true,
        hybrid: loc.hybrid === true,
        split: false,
      });
      const text = describe(detail);
      const page = httpUrl(detail?.postingUrl) ?? postingPage(company, id);
      const comp = detail?.compensation;
      return toBoardJob({
        provider: "smartrecruiters",
        platform: "SMARTRECRUITERS",
        label: LABEL,
        slug: company,
        id,
        company: asString(detail?.company?.name) ?? asString(p.company?.name) ?? companyName ?? company,
        sourceUrl: page,
        text: text || summary(p),
        descriptionLevel: text ? "FULL" : "SNIPPET",
        hints: {
          title: asString(p.name),
          location: places.locations,
          workMode: places.workMode,
          employmentType: mapEmploymentType(p.typeOfEmployment?.label ?? p.typeOfEmployment?.id),
          applyUrl: httpUrl(detail?.applyUrl) ?? page,
          postedAt: toIsoDate(p.releasedDate),
          ...(comp ? annualSalary(comp.min, comp.max, comp.period, comp.currency) : {}),
        },
      });
    });
    return { companyName, jobs };
  },
};
