import type { NormalizedJob } from "@applywise/types";
import { parseJobDescription } from "../jd-parser";
import type { RawImportedJob } from "./types";

/** Shared normalisation used by every connector: explicit hints win, then text extraction. */
export async function normalizeRawJob(raw: RawImportedJob): Promise<NormalizedJob> {
  const h = raw.hints;
  const job = parseJobDescription(raw.text, {
    importMethod: raw.importMethod,
    platform: h.platform ?? raw.provider,
    title: h.title ?? null,
    company: h.company ?? null,
    companyWebsite: h.companyWebsite ?? null,
    location: h.location ?? null,
    workMode: h.workMode ?? null,
    employmentType: h.employmentType ?? null,
    requiredSkills: h.requiredSkillNames ?? null,
    preferredSkills: h.preferredSkillNames ?? null,
    experienceMinYears: h.experienceMinYears ?? null,
    experienceMaxYears: h.experienceMaxYears ?? null,
    salaryMin: h.salaryMin ?? null,
    salaryMax: h.salaryMax ?? null,
    currency: h.currency ?? null,
    postedAt: h.postedAt ?? null,
    expiresAt: h.expiresAt ?? null,
    applyUrl: h.applyUrl ?? null,
    hrEmail: h.hrEmail ?? null,
    applicationInstructions: h.applicationInstructions ?? null,
    sourceUrl: raw.sourceUrl,
    sourceExternalId: raw.externalId,
    isDemo: h.isDemo ?? false,
  });
  if (h.domains && h.domains.length > 0) job.domains = [...new Set([...h.domains, ...job.domains])];
  if (h.responsibilities && h.responsibilities.length > 0) job.responsibilities = h.responsibilities;
  if (h.applyMethod) job.applyMethod = h.applyMethod;
  return job;
}
