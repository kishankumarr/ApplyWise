import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { MATCH_ENGINE_VERSION, normalizeLocation, type RawImportedJob } from "@applywise/job-engine";
import { IMPORT_METHOD_INTEGRATION_CLASS, type NormalizedJob } from "@applywise/types";

type Db = PrismaClient | Prisma.TransactionClient;

export function jobDedupeKey(job: Pick<NormalizedJob, "title" | "company" | "sourceUrl" | "applyUrl" | "description" | "sourceExternalId">): string {
  const basis = [
    job.title.trim().toLowerCase(),
    job.company.trim().toLowerCase(),
    job.sourceExternalId ?? job.sourceUrl ?? job.applyUrl ?? job.description.slice(0, 300).toLowerCase(),
  ].join("|");
  return createHash("sha256").update(basis).digest("hex").slice(0, 40);
}

const COMPANY_SUFFIXES = /\b(private|pvt|limited|ltd|llp|inc|incorporated|corp|corporation|co|company|technologies|technology|tech|solutions|software|labs|india|global)\b/g;

function normPart(value: string): string {
  return value.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Cross-source identity of a job: the same role at the same company in the same city, found via
 * an alert email, a search API and the browser extension, is merged into one job.
 * Returns null when title or company is unknown (nothing safe to merge on).
 */
export function jobMatchKey(job: Pick<NormalizedJob, "title" | "company" | "location">): string | null {
  const title = normPart(job.title).replace(/\b(urgent|hiring|immediate joiner|wfh|remote)\b/g, " ").replace(/\s+/g, " ").trim();
  const company = normPart(job.company).replace(COMPANY_SUFFIXES, " ").replace(/\s+/g, " ").trim();
  if (!title || !company || company === "unknown company" || company === "unknown") return null;
  const city = job.location[0] ? normPart(normalizeLocation(job.location[0])) : "";
  return createHash("sha256").update(`${title}|${company}|${city}`).digest("hex").slice(0, 40);
}

const toDate = (v: string | null) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

export function jobCreateData(job: NormalizedJob, ownerUserId: string | null): Prisma.JobUncheckedCreateInput {
  return {
    ownerUserId,
    platform: job.platform,
    title: job.title,
    company: job.company,
    companyWebsite: job.companyWebsite,
    locations: job.location,
    workMode: job.workMode,
    employmentType: job.employmentType,
    seniority: job.seniority,
    description: job.description,
    responsibilities: job.responsibilities,
    domains: job.domains,
    otherRequirements: job.otherRequirements as unknown as Prisma.InputJsonValue,
    screeningQuestions: job.screeningQuestions,
    experienceMinYears: job.experienceMinYears,
    experienceMaxYears: job.experienceMaxYears,
    salaryMin: job.salaryMin != null ? Math.round(job.salaryMin) : null,
    salaryMax: job.salaryMax != null ? Math.round(job.salaryMax) : null,
    currency: job.currency,
    postedAt: toDate(job.postedAt),
    expiresAt: toDate(job.expiresAt),
    applyUrl: job.applyUrl,
    hrEmail: job.hrEmail,
    applicationInstructions: job.applicationInstructions,
    applyMethod: job.applyMethod,
    importMethod: job.importMethod,
    sourceUrl: job.sourceUrl,
    sourceExternalId: job.sourceExternalId,
    isDemo: job.isDemo ?? false,
    normalizerVersion: `${MATCH_ENGINE_VERSION}`,
    dedupeKey: jobDedupeKey(job),
    matchKey: jobMatchKey(job),
  };
}

/** How long a job stays eligible for cross-source merging. */
const MERGE_WINDOW_MS = 60 * 24 * 60 * 60 * 1000;

type ExistingJob = { id: string; descriptionLevel: "FULL" | "SNIPPET"; description: string };

/**
 * A job first seen as a short summary (alert email / search snippet) is upgraded in place when the
 * full description arrives later (e.g. via the extension), so the match score becomes accurate.
 */
async function upgradeDescription(db: Db, existing: ExistingJob, job: NormalizedJob, level: "FULL" | "SNIPPET"): Promise<boolean> {
  // A "full" import must also be substantially longer than the summary it replaces.
  const longer = job.description.length >= Math.max(200, existing.description.length * 1.2);
  const better = existing.descriptionLevel === "SNIPPET" && longer && (level === "FULL" || job.description.length > existing.description.length * 1.5);
  if (!better) return false;
  await db.jobSkillRequirement.deleteMany({ where: { jobId: existing.id } });
  await db.jobRequirement.deleteMany({ where: { jobId: existing.id } });
  await db.job.update({
    where: { id: existing.id },
    data: {
      description: job.description,
      descriptionLevel: level,
      responsibilities: job.responsibilities,
      domains: job.domains,
      otherRequirements: job.otherRequirements as unknown as Prisma.InputJsonValue,
      screeningQuestions: job.screeningQuestions,
      ...(job.experienceMinYears != null ? { experienceMinYears: job.experienceMinYears } : {}),
      ...(job.experienceMaxYears != null ? { experienceMaxYears: job.experienceMaxYears } : {}),
      ...(job.salaryMin != null ? { salaryMin: Math.round(job.salaryMin) } : {}),
      ...(job.salaryMax != null ? { salaryMax: Math.round(job.salaryMax) } : {}),
      ...(job.workMode !== "unknown" ? { workMode: job.workMode } : {}),
      ...(job.employmentType !== "unknown" ? { employmentType: job.employmentType } : {}),
      ...(job.seniority !== "unknown" ? { seniority: job.seniority } : {}),
      normalizerVersion: `${MATCH_ENGINE_VERSION}`,
      skillRequirements: {
        create: [
          ...job.requiredSkills.map((sk) => ({ name: sk.name, canonicalName: sk.canonicalName, required: true, mandatory: sk.mandatory })),
          ...job.preferredSkills.map((sk) => ({ name: sk.name, canonicalName: sk.canonicalName, required: false, mandatory: false })),
        ],
      },
      requirements: { create: job.otherRequirements.map((r) => ({ text: r.text, mandatory: r.mandatory })) },
    },
  });
  return true;
}

/**
 * Persist a normalised job with its source attribution, skill requirements, contacts and
 * an import event. Duplicate imports (same owner + dedupe key) are recorded, not re-created.
 */
export async function persistNormalizedJob(
  db: Db,
  input: {
    job: NormalizedJob;
    raw: RawImportedJob;
    ownerUserId: string | null;
    importedByUserId: string | null;
    connector: string;
    id?: string;
    /** Automatic source (JobFeed) that found the job. */
    feedId?: string | null;
    /** Record an import event for already-known jobs (off for automatic syncs, which see the same jobs repeatedly). */
    recordDuplicates?: boolean;
  },
): Promise<{ jobId: string; duplicate: boolean; merged: boolean; upgraded: boolean }> {
  const data = jobCreateData(input.job, input.ownerUserId);
  const level = input.raw.descriptionLevel ?? "FULL";
  const select = { id: true, descriptionLevel: true, description: true } as const;
  const recordDuplicates = input.recordDuplicates ?? true;
  const duplicateEvent = async (jobId: string, merged: boolean) => {
    if (!recordDuplicates) return;
    await db.jobImportEvent.create({
      data: {
        userId: input.importedByUserId,
        jobId,
        connector: input.connector,
        importMethod: input.raw.importMethod,
        status: "DUPLICATE",
        rawPayload: { ...(input.raw.raw as Record<string, unknown>), ...(merged ? { mergedBy: "matchKey" } : {}) } as Prisma.InputJsonValue,
      },
    });
  };

  const exact = await db.job.findFirst({ where: { ownerUserId: input.ownerUserId, dedupeKey: data.dedupeKey }, select });
  if (exact) {
    const upgraded = await upgradeDescription(db, exact, input.job, level);
    await duplicateEvent(exact.id, false);
    return { jobId: exact.id, duplicate: true, merged: false, upgraded };
  }
  // Same role found via another source (only for private jobs; the shared catalogue is curated).
  if (input.ownerUserId && data.matchKey) {
    const same = await db.job.findFirst({
      where: { ownerUserId: input.ownerUserId, matchKey: data.matchKey, createdAt: { gte: new Date(Date.now() - MERGE_WINDOW_MS) } },
      select,
      orderBy: { createdAt: "desc" },
    });
    if (same) {
      const upgraded = await upgradeDescription(db, same, input.job, level);
      // Each source is attached once, however often it is synced.
      const knownSource = await db.jobSource.findFirst({
        where: { jobId: same.id, OR: [...(input.raw.externalId ? [{ externalId: input.raw.externalId }] : []), ...(input.raw.sourceUrl ? [{ sourceUrl: input.raw.sourceUrl }] : [])] },
        select: { id: true },
      });
      if (knownSource) {
        await duplicateEvent(same.id, true);
        return { jobId: same.id, duplicate: true, merged: false, upgraded };
      }
      await db.jobSource.create({
        data: {
          jobId: same.id,
          platform: input.job.platform,
          importMethod: input.job.importMethod,
          integrationClass: IMPORT_METHOD_INTEGRATION_CLASS[input.job.importMethod],
          attribution: input.raw.attribution,
          sourceUrl: input.raw.sourceUrl,
          externalId: input.raw.externalId,
          metadata: input.raw.raw as Prisma.InputJsonValue,
        },
      });
      await duplicateEvent(same.id, true);
      return { jobId: same.id, duplicate: true, merged: true, upgraded };
    }
  }
  const created = await createOrFindRacing(db, data.dedupeKey, input.ownerUserId, {
      ...(input.id ? { id: input.id } : {}),
      ...data,
      descriptionLevel: level,
      feedId: input.feedId ?? null,
      sources: {
        create: {
          platform: input.job.platform,
          importMethod: input.job.importMethod,
          integrationClass: IMPORT_METHOD_INTEGRATION_CLASS[input.job.importMethod],
          attribution: input.raw.attribution,
          sourceUrl: input.raw.sourceUrl,
          externalId: input.raw.externalId,
          metadata: input.raw.raw as Prisma.InputJsonValue,
        },
      },
      skillRequirements: {
        create: [
          ...input.job.requiredSkills.map((s) => ({ name: s.name, canonicalName: s.canonicalName, required: true, mandatory: s.mandatory })),
          ...input.job.preferredSkills.map((s) => ({ name: s.name, canonicalName: s.canonicalName, required: false, mandatory: false })),
        ],
      },
      requirements: { create: input.job.otherRequirements.map((r) => ({ text: r.text, mandatory: r.mandatory })) },
      contacts: input.job.hrEmail ? { create: [{ email: input.job.hrEmail, role: "HR / hiring" }] } : undefined,
      importEvents: {
        create: {
          userId: input.importedByUserId,
          connector: input.connector,
          importMethod: input.raw.importMethod,
          status: "SUCCESS",
          rawPayload: input.raw.raw as Prisma.InputJsonValue,
        },
      },
  });
  return { jobId: created.id, duplicate: created.existed, merged: false, upgraded: false };
}

/** Create the job; if a concurrent import created the same job first (unique violation), use that one. */
async function createOrFindRacing(db: Db, dedupeKey: string, ownerUserId: string | null, data: Prisma.JobUncheckedCreateInput): Promise<{ id: string; existed: boolean }> {
  try {
    const created = await db.job.create({ data, select: { id: true } });
    return { id: created.id, existed: false };
  } catch (e) {
    if ((e as { code?: string }).code !== "P2002") throw e;
    const existing = await db.job.findFirst({ where: { ownerUserId, dedupeKey }, select: { id: true } });
    if (!existing) throw e;
    return { id: existing.id, existed: true };
  }
}

/** Rebuild a NormalizedJob from a database row + its skill requirements. */
export function jobRowToNormalized(
  row: Prisma.JobGetPayload<{ include: { skillRequirements: true } }>,
): NormalizedJob & { id: string } {
  return {
    id: row.id,
    platform: row.platform,
    title: row.title,
    company: row.company,
    companyWebsite: row.companyWebsite,
    location: row.locations,
    workMode: row.workMode,
    employmentType: row.employmentType,
    seniority: row.seniority,
    description: row.description,
    responsibilities: row.responsibilities,
    requiredSkills: row.skillRequirements.filter((s) => s.required).map((s) => ({ name: s.name, canonicalName: s.canonicalName, mandatory: s.mandatory })),
    preferredSkills: row.skillRequirements.filter((s) => !s.required).map((s) => ({ name: s.name, canonicalName: s.canonicalName, mandatory: false })),
    otherRequirements: (row.otherRequirements as { text: string; mandatory: boolean }[] | null) ?? [],
    domains: row.domains,
    experienceMinYears: row.experienceMinYears,
    experienceMaxYears: row.experienceMaxYears,
    salaryMin: row.salaryMin,
    salaryMax: row.salaryMax,
    currency: row.currency,
    postedAt: row.postedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    applyUrl: row.applyUrl,
    hrEmail: row.hrEmail,
    applicationInstructions: row.applicationInstructions,
    screeningQuestions: row.screeningQuestions,
    applyMethod: row.applyMethod,
    importMethod: row.importMethod,
    sourceUrl: row.sourceUrl,
    sourceExternalId: row.sourceExternalId,
    isDemo: row.isDemo,
  };
}
