import type { Prisma, PrismaClient } from "@prisma/client";
import { computeMatchReport, normalizeSkill, type MatchCandidate } from "@applywise/job-engine";
import { isVerifiedTruthStatus, type JobMatchReport, type SourceFact } from "@applywise/types";
import { jobRowToNormalized } from "./jobs";

type Db = PrismaClient | Prisma.TransactionClient;

export const candidateInclude = {
  preference: true,
  truthBankItems: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
  skills: { orderBy: { createdAt: "asc" } },
  experiences: { orderBy: { sortOrder: "asc" }, include: { bullets: { orderBy: { sortOrder: "asc" } } } },
  educations: { orderBy: { sortOrder: "asc" } },
  projects: { orderBy: { sortOrder: "asc" } },
} satisfies Prisma.CandidateProfileInclude;

export type CandidateRecord = Prisma.CandidateProfileGetPayload<{ include: typeof candidateInclude }>;

/** Always scoped to the given user. */
export async function loadCandidate(db: Db, userId: string): Promise<CandidateRecord | null> {
  return db.candidateProfile.findUnique({ where: { userId }, include: candidateInclude });
}

export function toMatchCandidate(c: CandidateRecord): MatchCandidate {
  // Experience/project/education entities that the user rejected invalidate their facts.
  const rejectedExperience = new Set(c.experiences.filter((e) => e.status === "USER_REJECTED").map((e) => e.id));
  const rejectedProjects = new Set(c.projects.filter((p) => p.status === "USER_REJECTED").map((p) => p.id));
  return {
    yoe: c.yoe,
    preferredLocations: c.preference?.preferredLocations ?? [],
    workModePreference: c.preference?.workModePreference ?? "any",
    openToRelocation: c.preference?.openToRelocation ?? false,
    targetRoles: c.preference?.targetRoles ?? [],
    currentTitle: c.currentTitle,
    facts: c.truthBankItems
      .filter((f) => !(f.experienceId && rejectedExperience.has(f.experienceId)) && !(f.projectId && rejectedProjects.has(f.projectId)))
      .map((f) => ({ id: f.id, kind: f.kind, text: f.text, status: f.status })),
    skills: c.skills.map((s) => ({ id: s.id, name: s.name, canonicalName: s.canonicalName, source: s.source, status: s.status })),
    resumeFormatWarnings: c.resumeFormatWarnings,
  };
}

/**
 * Verified facts only, plus synthetic facts for user-entered profile fields
 * (user-entered values count as verified). Used by every generator and the claim validator.
 */
export function verifiedSourceFacts(c: CandidateRecord): SourceFact[] {
  const facts: SourceFact[] = [];
  if (c.yoe != null) facts.push({ id: "profile:yoe", kind: "OTHER", text: `${c.yoe} years of professional experience` });
  if (c.currentTitle) {
    facts.push({ id: "profile:title", kind: "OTHER", text: `Current title: ${c.currentTitle}${c.currentCompany ? ` at ${c.currentCompany}` : ""}` });
  }
  if (c.preference?.noticePeriod) facts.push({ id: "profile:notice", kind: "OTHER", text: `Notice period: ${c.preference.noticePeriod}` });
  const toMatch = toMatchCandidate(c);
  for (const f of toMatch.facts) if (isVerifiedTruthStatus(f.status) && f.kind !== "CONTACT") facts.push({ id: f.id, kind: f.kind, text: f.text });
  for (const s of c.skills) if (isVerifiedTruthStatus(s.status)) facts.push({ id: s.id, kind: "SKILL", text: s.name });
  for (const e of c.experiences) {
    if (isVerifiedTruthStatus(e.status)) {
      facts.push({ id: e.id, kind: "EXPERIENCE", text: `${e.title} at ${e.company}${e.startDate ? ` (${e.startDate} - ${e.isCurrent ? "Present" : e.endDate ?? ""})` : ""}` });
    }
  }
  for (const p of c.projects) {
    if (isVerifiedTruthStatus(p.status) && !c.truthBankItems.some((f) => f.projectId === p.id)) {
      facts.push({ id: p.id, kind: "PROJECT", text: `${p.name}: ${p.description} (${p.technologies.join(", ")})` });
    }
  }
  for (const ed of c.educations) {
    if (isVerifiedTruthStatus(ed.status)) {
      facts.push({ id: ed.id, kind: "EDUCATION", text: [ed.degree, ed.field, ed.institution, ed.endYear].filter(Boolean).join(", ") });
    }
  }
  return facts;
}

/** Compute and upsert match scores for a user across the given jobs (deterministic). */
export async function recomputeMatchScores(db: Db, userId: string, jobIds?: string[]): Promise<number> {
  const candidate = await loadCandidate(db, userId);
  if (!candidate) return 0;
  const mc = toMatchCandidate(candidate);
  const jobs = await db.job.findMany({
    where: { OR: [{ ownerUserId: null }, { ownerUserId: userId }], ...(jobIds ? { id: { in: jobIds } } : {}) },
    include: { skillRequirements: true },
  });
  for (const row of jobs) {
    const report: JobMatchReport = computeMatchReport(jobRowToNormalized(row), mc);
    const data = {
      score: report.estimatedMatchScore,
      label: report.scoreLabel,
      recommendation: report.applicationRecommendation,
      report: report as unknown as Prisma.InputJsonValue,
      engineVersion: report.engineVersion,
      factsVersion: candidate.factsVersion,
      computedAt: new Date(),
    };
    const saved = await db.jobMatchScore.upsert({
      where: { userId_jobId: { userId, jobId: row.id } },
      create: { userId, jobId: row.id, ...data },
      update: data,
      select: { id: true },
    });
    await db.jobMatchFactor.deleteMany({ where: { matchScoreId: saved.id } });
    await db.jobMatchFactor.createMany({
      data: report.scoreFactors.map((f) => ({ matchScoreId: saved.id, key: f.key, label: f.label, points: f.points, maxPoints: f.maxPoints, explanation: f.explanation })),
    });
  }
  return jobs.length;
}

export { normalizeSkill };
