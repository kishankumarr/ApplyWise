import type { JobPlatform } from "@applywise/types";
import { normalizeRawJob } from "./normalize";
import {
  ConnectorInputError,
  ConnectorNotConfiguredError,
  type ImportInput,
  type JobSourceConnector,
  type RawImportedJob,
} from "./types";

/**
 * Integration stubs - DISABLED BY DEFAULT.
 *
 * These only talk to official, documented APIs or feeds that a partner has granted access
 * to. They must never be pointed at a website that is not an API (no scraping).
 */

type Env = Record<string, string | undefined>;
const env = (): Env => (typeof process !== "undefined" ? process.env : {});

interface FeedJob {
  id?: string | number;
  title?: string;
  company?: string;
  location?: string | string[];
  description?: string;
  apply_url?: string;
  url?: string;
  posted_at?: string;
}

function mapFeedJobs(jobs: FeedJob[], provider: JobPlatform, importMethod: "OFFICIAL_API" | "PARTNER_FEED", label: string): RawImportedJob[] {
  return jobs
    .filter((j) => j.title && j.description)
    .map((j) => ({
      provider,
      importMethod,
      externalId: j.id != null ? String(j.id) : null,
      sourceUrl: j.url ?? j.apply_url ?? null,
      attribution: label,
      raw: { kind: importMethod.toLowerCase(), item: j },
      text: String(j.description),
      hints: {
        title: j.title,
        company: j.company,
        location: j.location,
        applyUrl: j.apply_url ?? j.url,
        postedAt: j.posted_at,
      },
    }));
}

async function fetchJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const res = await fetch(url, { headers: { accept: "application/json", ...headers } });
  if (!res.ok) throw new Error(`Feed request failed with status ${res.status}`);
  return res.json();
}

/** Official partner API (e.g. a job board that granted API access). Requires PARTNER_API_URL + PARTNER_API_KEY. */
export const officialPartnerApiConnector: JobSourceConnector = {
  provider: "OTHER",
  importMethod: "OFFICIAL_API",
  integrationClass: "official_api",
  description: "Official partner job API. Requires a signed partnership and PARTNER_API_URL / PARTNER_API_KEY.",
  isConfigured: () => env().ENABLE_PARTNER_API === "true" && !!env().PARTNER_API_URL && !!env().PARTNER_API_KEY,
  async importJobs(_input: ImportInput): Promise<RawImportedJob[]> {
    if (!this.isConfigured()) throw new ConnectorNotConfiguredError("official_partner_api");
    const data = (await fetchJson(env().PARTNER_API_URL as string, { authorization: `Bearer ${env().PARTNER_API_KEY}` })) as { jobs?: FeedJob[] };
    return mapFeedJobs(data.jobs ?? [], "OTHER", "OFFICIAL_API", "Official partner API");
  },
  normalize: normalizeRawJob,
};

/** API-key based partner feed (JSON). Requires PARTNER_FEED_URL + PARTNER_FEED_KEY. */
export const apiKeyFeedConnector: JobSourceConnector = {
  provider: "OTHER",
  importMethod: "PARTNER_FEED",
  integrationClass: "partner_feed",
  description: "API-key based partner job feed. Requires PARTNER_FEED_URL / PARTNER_FEED_KEY.",
  isConfigured: () => env().ENABLE_PARTNER_FEED === "true" && !!env().PARTNER_FEED_URL && !!env().PARTNER_FEED_KEY,
  async importJobs(_input: ImportInput): Promise<RawImportedJob[]> {
    if (!this.isConfigured()) throw new ConnectorNotConfiguredError("api_key_feed");
    const data = (await fetchJson(env().PARTNER_FEED_URL as string, { "x-api-key": env().PARTNER_FEED_KEY as string })) as { jobs?: FeedJob[] };
    return mapFeedJobs(data.jobs ?? [], "OTHER", "PARTNER_FEED", "Partner job feed");
  },
  normalize: normalizeRawJob,
};

/**
 * Future ATS adapters: Greenhouse and Lever publish official public job-board APIs for the
 * companies that use them. Disabled unless ENABLE_ATS_BOARD_APIS=true and a board token is given.
 */
export const greenhouseBoardApiConnector: JobSourceConnector = {
  provider: "GREENHOUSE",
  importMethod: "OFFICIAL_API",
  integrationClass: "official_api",
  description: "Greenhouse Job Board API (official, per-company board token). Disabled by default.",
  isConfigured: () => env().ENABLE_ATS_BOARD_APIS === "true",
  async importJobs(input: ImportInput): Promise<RawImportedJob[]> {
    if (!this.isConfigured()) throw new ConnectorNotConfiguredError("greenhouse_board_api");
    const token = (input.payload as { boardToken?: string } | null)?.boardToken;
    if (!token || !/^[a-z0-9-]{2,64}$/i.test(token)) throw new ConnectorInputError("A valid Greenhouse board token is required.");
    const data = (await fetchJson(`https://boards-api.greenhouse.io/v1/boards/${token}/jobs?content=true`, {})) as {
      jobs?: { id: number; title: string; absolute_url: string; location?: { name?: string }; content?: string; updated_at?: string }[];
    };
    return (data.jobs ?? []).map((j) => ({
      provider: "GREENHOUSE" as const,
      importMethod: "OFFICIAL_API" as const,
      externalId: String(j.id),
      sourceUrl: j.absolute_url,
      attribution: `Greenhouse job board (${token})`,
      raw: { kind: "greenhouse_board_api", id: j.id, updated_at: j.updated_at },
      text: (j.content ?? "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/<[^>]+>/g, "\n"),
      hints: { title: j.title, company: token, location: j.location?.name, applyUrl: j.absolute_url, postedAt: j.updated_at },
    }));
  },
  normalize: normalizeRawJob,
};

export const leverPostingsApiConnector: JobSourceConnector = {
  provider: "LEVER",
  importMethod: "OFFICIAL_API",
  integrationClass: "official_api",
  description: "Lever Postings API (official, per-company site name). Disabled by default.",
  isConfigured: () => env().ENABLE_ATS_BOARD_APIS === "true",
  async importJobs(input: ImportInput): Promise<RawImportedJob[]> {
    if (!this.isConfigured()) throw new ConnectorNotConfiguredError("lever_postings_api");
    const site = (input.payload as { site?: string } | null)?.site;
    if (!site || !/^[a-z0-9-]{2,64}$/i.test(site)) throw new ConnectorInputError("A valid Lever site name is required.");
    const data = (await fetchJson(`https://api.lever.co/v0/postings/${site}?mode=json`, {})) as {
      id: string;
      text: string;
      hostedUrl: string;
      applyUrl?: string;
      categories?: { location?: string };
      descriptionPlain?: string;
      createdAt?: number;
    }[];
    return (Array.isArray(data) ? data : []).map((j) => ({
      provider: "LEVER" as const,
      importMethod: "OFFICIAL_API" as const,
      externalId: j.id,
      sourceUrl: j.hostedUrl,
      attribution: `Lever postings (${site})`,
      raw: { kind: "lever_postings_api", id: j.id, createdAt: j.createdAt ?? null },
      text: j.descriptionPlain ?? "",
      hints: {
        title: j.text,
        company: site,
        location: j.categories?.location,
        applyUrl: j.applyUrl ?? j.hostedUrl,
        postedAt: j.createdAt ? new Date(j.createdAt).toISOString() : undefined,
      },
    }));
  },
  normalize: normalizeRawJob,
};

/** Explicitly unsupported integrations and why. Shown on the integrations settings page. */
export const UNSUPPORTED_INTEGRATIONS: { platform: JobPlatform; reason: string; alternatives: string[] }[] = [
  {
    platform: "LINKEDIN",
    reason: "No public job-search API. Automated LinkedIn activity and scraping are prohibited.",
    alternatives: ["Forward LinkedIn job-alert emails", "Import a job page you are viewing with the extension", "Paste the job description"],
  },
  {
    platform: "NAUKRI",
    reason: "Requires an approved partnership/API agreement before any direct integration.",
    alternatives: ["Forward Naukri job-alert emails", "Use the extension on a job page you opened", "Paste the job description"],
  },
  {
    platform: "INDEED",
    reason: "Requires an approved publisher/partner agreement before any direct integration.",
    alternatives: ["Forward Indeed job-alert emails", "Use the extension on a job page you opened", "CSV import"],
  },
  {
    platform: "INSTAHYRE",
    reason: "No approved partner API configured.",
    alternatives: ["Forward Instahyre alert emails", "Paste the job description"],
  },
];
