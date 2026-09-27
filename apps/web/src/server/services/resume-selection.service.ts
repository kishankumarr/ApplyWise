import "server-only";
import { prisma, verifiedSourceFacts } from "@applywise/database";
import { extractSkillsFromText, normalizeSkill, selectResume } from "@applywise/job-engine";
import { renderResumeText, type ResumeDocument } from "@applywise/resume-engine";
import { isVerifiedTruthStatus, type ResumeSelectionCandidate, type ResumeSelectionResult } from "@applywise/types";
import { audit } from "../audit";
import { Errors } from "../errors";
import { profileRepo } from "../repositories/profile.repo";
import { recordApplicationEvent } from "./application-transitions";

/**
 * Automatic resume selection per application: every resume variant (each parsed upload, plus profile snapshots)
 * is scored by the pure selector on the job requirements it covers with VERIFIED evidence. The user can override
 * the choice; an override is never replaced automatically.
 */

/** Candidates not tied to an uploaded file (profile snapshots) use this prefix instead of a Resume id. */
const VERSION_PREFIX = "version:";

async function resumeCandidates(userId: string): Promise<ResumeSelectionCandidate[]> {
  const [resumes, versions] = await Promise.all([
    prisma.resume.findMany({ where: { userId, status: "PARSED" }, select: { id: true, label: true, originalFileName: true, targetRoles: true, isPrimary: true, createdAt: true } }),
    prisma.resumeVersion.findMany({
      where: { userId, kind: { in: ["ORIGINAL", "EDITED"] }, applicationId: null },
      orderBy: { createdAt: "desc" },
      select: { id: true, resumeId: true, label: true, content: true, createdAt: true },
    }),
  ]);
  const toCandidate = (resumeId: string, versionId: string, label: string, targetRoles: string[], isPrimary: boolean, doc: ResumeDocument, createdAt: Date): ResumeSelectionCandidate => ({
    resumeId,
    versionId,
    label,
    targetRoles,
    isPrimary,
    skills: [...new Set(doc.skills.map((s) => normalizeSkill(s)).filter(Boolean))],
    titles: doc.experience.map((e) => e.title),
    text: renderResumeText(doc),
    createdAt: createdAt.toISOString(),
  });
  const out: ResumeSelectionCandidate[] = [];
  for (const r of resumes) {
    // Latest non-tailored version of this upload (an edited version wins over the original).
    const v = versions.find((x) => x.resumeId === r.id);
    if (v) out.push(toCandidate(r.id, v.id, r.label ?? r.originalFileName, r.targetRoles, r.isPrimary, v.content as unknown as ResumeDocument, r.createdAt));
  }
  // Variants without an uploaded file (profile snapshots, labelled variants): the newest version per label competes.
  const seenLabels = new Set<string>();
  for (const v of versions.filter((x) => !x.resumeId)) {
    const key = v.label.trim().toLowerCase();
    if (seenLabels.has(key) || seenLabels.size >= 5) continue;
    seenLabels.add(key);
    out.push(toCandidate(`${VERSION_PREFIX}${v.id}`, v.id, v.label, [], resumes.length === 0 && seenLabels.size === 1, v.content as unknown as ResumeDocument, v.createdAt));
  }
  return out;
}

/** Canonical skills the candidate has verified evidence for (verified skills + skills named in verified facts). */
async function verifiedSkillSet(userId: string): Promise<Set<string>> {
  const c = await profileRepo.ensure(userId);
  const set = new Set(c.skills.filter((s) => isVerifiedTruthStatus(s.status)).map((s) => s.canonicalName));
  for (const f of verifiedSourceFacts(c)) for (const s of extractSkillsFromText(f.text)) set.add(normalizeSkill(s));
  return set;
}

async function jobInput(userId: string, jobId: string) {
  const job = await prisma.job.findFirst({ where: { id: jobId, OR: [{ ownerUserId: null }, { ownerUserId: userId }] }, include: { skillRequirements: true } });
  if (!job) throw Errors.notFound("Job");
  return {
    title: job.title,
    requiredSkills: job.skillRequirements.filter((s) => s.required).map((s) => ({ canonicalName: s.canonicalName, mandatory: s.mandatory })),
    preferredSkills: job.skillRequirements.filter((s) => !s.required).map((s) => s.canonicalName),
    domains: job.domains,
  };
}

function storedIds(result: { resumeId: string; versionId: string | null }): { selectedResumeId: string | null; selectedResumeVersionId: string | null } {
  return result.resumeId.startsWith(VERSION_PREFIX)
    ? { selectedResumeId: null, selectedResumeVersionId: result.versionId }
    : { selectedResumeId: result.resumeId, selectedResumeVersionId: result.versionId };
}

export const resumeSelectionService = {
  /** Rank every resume variant for a job (UI: "Why this resume?" and the override picker). */
  async rank(userId: string, jobId: string): Promise<ResumeSelectionResult | null> {
    const [candidates, verified, job] = await Promise.all([resumeCandidates(userId), verifiedSkillSet(userId), jobInput(userId, jobId)]);
    return selectResume(job, candidates, verified);
  },

  /** Choose the resume for an application unless the user overrode it. Returns the stored selection. */
  async selectForApplication(userId: string, applicationId: string): Promise<ResumeSelectionResult | null> {
    const app = await prisma.application.findFirst({ where: { id: applicationId, userId }, select: { jobId: true, resumeSelectionOverridden: true, selectedResumeId: true, selectedResumeVersionId: true } });
    if (!app) throw Errors.notFound("Application");
    if (app.resumeSelectionOverridden) return null;
    const result = await this.rank(userId, app.jobId);
    if (!result) return null;
    const ids = storedIds(result);
    await prisma.application.update({
      where: { id: applicationId },
      data: { ...ids, resumeSelectionScore: result.score, resumeSelectionReason: result.reason.slice(0, 500) },
    });
    if (ids.selectedResumeId !== app.selectedResumeId || ids.selectedResumeVersionId !== app.selectedResumeVersionId) {
      await recordApplicationEvent(userId, applicationId, "resume_selected", `Selected "${result.label}" (score ${result.score}). ${result.reason}`.slice(0, 500), {
        metadata: { resumeId: ids.selectedResumeId, versionId: ids.selectedResumeVersionId, score: result.score, ranking: result.ranking.map((r) => ({ label: r.label, score: r.score })) },
      });
    }
    return result;
  },

  /** User override. `resumeId` = a Resume id or a ResumeVersion id; null returns to automatic selection. */
  async override(userId: string, applicationId: string, resumeId: string | null, requestId?: string) {
    const app = await prisma.application.findFirst({ where: { id: applicationId, userId }, select: { id: true } });
    if (!app) throw Errors.notFound("Application");
    if (resumeId === null) {
      await prisma.application.update({ where: { id: applicationId }, data: { resumeSelectionOverridden: false } });
      const result = await this.selectForApplication(userId, applicationId);
      await audit(userId, "application.resume_overridden", { requestId, entityType: "Application", entityId: applicationId, metadata: { automatic: true } });
      return { automatic: true, selection: result };
    }
    const candidates = await resumeCandidates(userId);
    const chosen = candidates.find((c) => c.resumeId === resumeId || c.versionId === resumeId);
    if (!chosen) throw Errors.notFound("Resume");
    const ids = storedIds(chosen);
    await prisma.application.update({
      where: { id: applicationId },
      data: { ...ids, resumeSelectionOverridden: true, resumeSelectionScore: null, resumeSelectionReason: `Chosen by you: ${chosen.label}` },
    });
    await recordApplicationEvent(userId, applicationId, "resume_overridden", `You chose "${chosen.label}" for this application.`, { actor: "user", metadata: ids });
    await audit(userId, "application.resume_overridden", { requestId, entityType: "Application", entityId: applicationId, metadata: { automatic: false } });
    return { automatic: false, selection: null };
  },
};
