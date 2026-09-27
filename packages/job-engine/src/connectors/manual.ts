import type { JobPlatform, JobWorkMode } from "@applywise/types";
import { detectPlatformFromUrl } from "../jd-parser";
import { normalizeRawJob } from "./normalize";
import { ConnectorInputError, type ImportInput, type JobSourceConnector, type RawImportedJob } from "./types";

export interface ManualJobPayload {
  title?: string;
  company?: string;
  location?: string[];
  workMode?: JobWorkMode;
  platform?: JobPlatform;
  description: string;
  requiredSkills?: string[];
  preferredSkills?: string[];
  experienceMinYears?: number | null;
  experienceMaxYears?: number | null;
  applyUrl?: string | null;
  hrEmail?: string | null;
  sourceUrl?: string | null;
}

function assertPayload(payload: unknown): ManualJobPayload {
  const p = payload as ManualJobPayload | null;
  if (!p || typeof p.description !== "string" || p.description.trim().length < 20) {
    throw new ConnectorInputError("A job description of at least 20 characters is required.");
  }
  return p;
}

/** 1. Structured manual job entry by the user. */
export const manualEntryConnector: JobSourceConnector = {
  provider: "OTHER",
  importMethod: "MANUAL_ENTRY",
  integrationClass: "user_manual_entry",
  description: "Enter a job yourself with structured fields.",
  isConfigured: () => true,
  async importJobs(input: ImportInput): Promise<RawImportedJob[]> {
    const p = assertPayload(input.payload);
    const provider = p.platform ?? detectPlatformFromUrl(p.sourceUrl ?? p.applyUrl) ?? "OTHER";
    return [
      {
        provider,
        importMethod: "MANUAL_ENTRY",
        externalId: null,
        sourceUrl: p.sourceUrl ?? null,
        attribution: "Entered manually by you",
        raw: { kind: "manual_entry", fields: Object.keys(p) },
        text: p.description,
        hints: {
          title: p.title || undefined,
          company: p.company || undefined,
          location: p.location && p.location.length ? p.location : undefined,
          workMode: p.workMode,
          requiredSkillNames: p.requiredSkills,
          preferredSkillNames: p.preferredSkills,
          experienceMinYears: p.experienceMinYears ?? undefined,
          experienceMaxYears: p.experienceMaxYears ?? undefined,
          applyUrl: p.applyUrl ?? undefined,
          hrEmail: p.hrEmail ?? undefined,
        },
      },
    ];
  },
  normalize: normalizeRawJob,
};

/** 2. Paste a raw job description - everything is extracted from the text. */
export const pastedDescriptionConnector: JobSourceConnector = {
  provider: "OTHER",
  importMethod: "MANUAL_ENTRY",
  integrationClass: "user_manual_entry",
  description: "Paste a raw job description; fields are extracted without guessing.",
  isConfigured: () => true,
  async importJobs(input: ImportInput): Promise<RawImportedJob[]> {
    const p = assertPayload(input.payload);
    const provider = p.platform ?? detectPlatformFromUrl(p.sourceUrl ?? p.applyUrl) ?? "OTHER";
    return [
      {
        provider,
        importMethod: "MANUAL_ENTRY",
        externalId: null,
        sourceUrl: p.sourceUrl ?? null,
        attribution: "Pasted job description",
        raw: { kind: "pasted_description", length: p.description.length },
        text: p.description,
        hints: {
          title: p.title || undefined,
          company: p.company || undefined,
          applyUrl: p.applyUrl ?? undefined,
          hrEmail: p.hrEmail ?? undefined,
        },
      },
    ];
  },
  normalize: normalizeRawJob,
};

/**
 * 5. Career-page URL manual import. Saves the official URL plus the description the user
 * pasted. The page is NOT fetched or scraped.
 */
export const careerPageUrlConnector: JobSourceConnector = {
  provider: "COMPANY_CAREER_PAGE",
  importMethod: "CAREER_PAGE_URL",
  integrationClass: "career_page_url",
  description: "Save an official career-page URL with the description you paste. We never fetch the page.",
  isConfigured: () => true,
  async importJobs(input: ImportInput): Promise<RawImportedJob[]> {
    const p = assertPayload(input.payload);
    const url = p.sourceUrl ?? p.applyUrl;
    if (!url) throw new ConnectorInputError("An official career-page URL is required.");
    const provider = detectPlatformFromUrl(url) ?? "COMPANY_CAREER_PAGE";
    return [
      {
        provider,
        importMethod: "CAREER_PAGE_URL",
        externalId: null,
        sourceUrl: url,
        attribution: `Career page URL saved by you (${new URL(url).hostname})`,
        raw: { kind: "career_page_url", url, fetched: false },
        text: p.description,
        hints: {
          title: p.title || undefined,
          company: p.company || undefined,
          location: p.location && p.location.length ? p.location : undefined,
          workMode: p.workMode,
          applyUrl: p.applyUrl ?? url,
          hrEmail: p.hrEmail ?? undefined,
          requiredSkillNames: p.requiredSkills,
          preferredSkillNames: p.preferredSkills,
        },
      },
    ];
  },
  normalize: normalizeRawJob,
};
