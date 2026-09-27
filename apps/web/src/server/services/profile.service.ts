import "server-only";
import { prisma, type CandidateRecord, type TruthStatus } from "@applywise/database";
import { normalizeSkill } from "@applywise/job-engine";
import type { CandidateProfile } from "@applywise/types";
import type { ProfileUpdateInput } from "@applywise/validation";
import { audit } from "../audit";
import { Errors } from "../errors";
import { enqueue } from "../queue";
import { profileRepo } from "../repositories/profile.repo";
import { consentService } from "./consent.service";

export function toCandidateProfile(c: CandidateRecord): CandidateProfile {
  return {
    id: c.id,
    userId: c.userId,
    fullName: c.fullName,
    email: c.email,
    phone: c.phone,
    yoe: c.yoe,
    preferredLocations: c.preference?.preferredLocations ?? [],
    workModePreference: c.preference?.workModePreference ?? "any",
    openToRelocation: c.preference?.openToRelocation ?? false,
    targetRoles: c.preference?.targetRoles ?? [],
    noticePeriod: c.preference?.noticePeriod ?? null,
    expectedSalaryMin: c.preference?.expectedSalaryMin ?? null,
    expectedSalaryMax: c.preference?.expectedSalaryMax ?? null,
    currentTitle: c.currentTitle,
    currentCompany: c.currentCompany,
    portfolioUrl: c.portfolioUrl,
    githubUrl: c.githubUrl,
    linkedinUrl: c.linkedinUrl,
    summary: c.summary,
    skills: c.skills.map((s) => ({ id: s.id, name: s.name, canonicalName: s.canonicalName, source: s.source, status: s.status, yearsUsed: s.yearsUsed })),
    experience: c.experiences.map((e) => ({
      id: e.id,
      title: e.title,
      company: e.company,
      location: e.location,
      startDate: e.startDate,
      endDate: e.endDate,
      isCurrent: e.isCurrent,
      status: e.status,
      bullets: e.bullets.map((b) => ({ id: b.id, kind: b.kind, text: b.text, status: b.status, section: b.section, experienceId: b.experienceId })),
    })),
    education: c.educations.map((e) => ({
      id: e.id,
      institution: e.institution,
      degree: e.degree,
      field: e.field,
      startYear: e.startYear,
      endYear: e.endYear,
      status: e.status,
    })),
    projects: c.projects.map((p) => ({ id: p.id, name: p.name, description: p.description, url: p.url, technologies: p.technologies, status: p.status })),
    truthBankItems: c.truthBankItems.map((f) => ({
      id: f.id,
      kind: f.kind,
      text: f.text,
      status: f.status,
      section: f.section,
      experienceId: f.experienceId,
      projectId: f.projectId,
      educationId: f.educationId,
    })),
  };
}

type FactEntity = "truth" | "skill" | "experience" | "education" | "project";

async function findFactEntity(userId: string, id: string): Promise<{ entity: FactEntity; text: string }> {
  const [truth, skill, experience, education, project] = await Promise.all([
    prisma.truthBankItem.findFirst({ where: { id, userId }, select: { text: true } }),
    prisma.candidateSkill.findFirst({ where: { id, userId }, select: { name: true } }),
    prisma.experience.findFirst({ where: { id, userId }, select: { title: true, company: true } }),
    prisma.education.findFirst({ where: { id, userId }, select: { institution: true } }),
    prisma.project.findFirst({ where: { id, userId }, select: { name: true } }),
  ]);
  if (truth) return { entity: "truth", text: truth.text };
  if (skill) return { entity: "skill", text: skill.name };
  if (experience) return { entity: "experience", text: `${experience.title} at ${experience.company}` };
  if (education) return { entity: "education", text: education.institution };
  if (project) return { entity: "project", text: project.name };
  throw Errors.notFound("Fact");
}

async function setStatus(userId: string, id: string, entity: FactEntity, status: TruthStatus, editedText?: string) {
  const now = new Date();
  switch (entity) {
    case "truth":
      await prisma.truthBankItem.update({
        where: { id },
        data: { status, verifiedAt: status === "USER_REJECTED" ? null : now, ...(editedText ? { text: editedText } : {}) },
      });
      break;
    case "skill":
      await prisma.candidateSkill.update({
        where: { id },
        data: { status, ...(editedText ? { name: editedText, canonicalName: normalizeSkill(editedText) } : {}) },
      });
      break;
    case "experience":
      await prisma.experience.update({ where: { id }, data: { status } });
      // Rejecting a role rejects its bullets; verifying a role does not auto-verify bullets.
      if (status === "USER_REJECTED") await prisma.truthBankItem.updateMany({ where: { userId, experienceId: id }, data: { status: "USER_REJECTED" } });
      break;
    case "education":
      await prisma.education.update({ where: { id }, data: { status } });
      await prisma.truthBankItem.updateMany({ where: { userId, educationId: id }, data: { status } });
      break;
    case "project":
      await prisma.project.update({ where: { id }, data: { status } });
      await prisma.truthBankItem.updateMany({ where: { userId, projectId: id }, data: { status } });
      break;
  }
}

async function refreshMatches(userId: string) {
  await profileRepo.bumpFactsVersion(userId);
  await enqueue("job.match", { userId }, { userId });
}

export const profileService = {
  async getView(userId: string) {
    const profile = await profileRepo.ensure(userId);
    const [consents, resumes] = await Promise.all([
      consentService.get(userId),
      prisma.resume.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        select: { id: true, originalFileName: true, mimeType: true, sizeBytes: true, status: true, parseError: true, parserProvider: true, createdAt: true, label: true, targetRoles: true },
      }),
    ]);
    const facts = toCandidateProfile(profile);
    const all = [...profile.truthBankItems, ...profile.skills, ...profile.experiences, ...profile.educations, ...profile.projects];
    return {
      profile: facts,
      onboarding: { step: profile.onboardingStep, completed: profile.onboardingCompleted },
      resumeFormatWarnings: profile.resumeFormatWarnings,
      verification: {
        total: all.length,
        verified: all.filter((f) => f.status === "USER_VERIFIED" || f.status === "USER_EDITED").length,
        unverified: all.filter((f) => f.status === "PARSED_UNVERIFIED").length,
        rejected: all.filter((f) => f.status === "USER_REJECTED").length,
      },
      consents,
      resumes,
    };
  },

  async update(userId: string, input: ProfileUpdateInput, requestId?: string) {
    await profileRepo.ensure(userId);
    const { preferredLocations, workModePreference, openToRelocation, targetRoles, noticePeriod, expectedSalaryMin, expectedSalaryMax, onboardingCompleted, ...profileFields } = input;
    await prisma.candidateProfile.update({
      where: { userId },
      data: {
        ...profileFields,
        ...(onboardingCompleted !== undefined ? { onboardingCompleted, onboardingStep: onboardingCompleted ? 10 : undefined } : {}),
        preference: {
          update: {
            ...(preferredLocations !== undefined ? { preferredLocations } : {}),
            ...(workModePreference !== undefined ? { workModePreference } : {}),
            ...(openToRelocation !== undefined ? { openToRelocation } : {}),
            ...(targetRoles !== undefined ? { targetRoles } : {}),
            ...(noticePeriod !== undefined ? { noticePeriod } : {}),
            ...(expectedSalaryMin !== undefined ? { expectedSalaryMin } : {}),
            ...(expectedSalaryMax !== undefined ? { expectedSalaryMax } : {}),
          },
        },
      },
    });
    await audit(userId, "profile.updated", { requestId, metadata: { fields: Object.keys(input) } });
    await refreshMatches(userId);
    return this.getView(userId);
  },

  async setOnboardingStep(userId: string, step: number) {
    await prisma.candidateProfile.update({ where: { userId }, data: { onboardingStep: step } });
  },

  async verifyFact(userId: string, factId: string, editedText: string | undefined, requestId?: string) {
    const found = await findFactEntity(userId, factId);
    const edited = editedText && editedText.trim() !== found.text.trim() ? editedText.trim() : undefined;
    await setStatus(userId, factId, found.entity, edited ? "USER_EDITED" : "USER_VERIFIED", edited);
    await audit(userId, edited ? "fact.edited" : "fact.verified", { requestId, entityType: found.entity, entityId: factId });
    await refreshMatches(userId);
    return { id: factId, status: edited ? "USER_EDITED" : "USER_VERIFIED" };
  },

  async rejectFact(userId: string, factId: string, requestId?: string) {
    const found = await findFactEntity(userId, factId);
    await setStatus(userId, factId, found.entity, "USER_REJECTED");
    await audit(userId, "fact.rejected", { requestId, entityType: found.entity, entityId: factId });
    await refreshMatches(userId);
    return { id: factId, status: "USER_REJECTED" };
  },

  /** Bulk-verify every unverified fact (the user confirms the whole parsed profile at once). */
  async verifyAll(userId: string, requestId?: string) {
    const where = { userId, status: "PARSED_UNVERIFIED" as const };
    const now = new Date();
    const [a, b, c, d, e] = await prisma.$transaction([
      prisma.truthBankItem.updateMany({ where, data: { status: "USER_VERIFIED", verifiedAt: now } }),
      prisma.candidateSkill.updateMany({ where, data: { status: "USER_VERIFIED" } }),
      prisma.experience.updateMany({ where, data: { status: "USER_VERIFIED" } }),
      prisma.education.updateMany({ where, data: { status: "USER_VERIFIED" } }),
      prisma.project.updateMany({ where, data: { status: "USER_VERIFIED" } }),
    ]);
    const count = a.count + b.count + c.count + d.count + e.count;
    await audit(userId, "fact.verified", { requestId, metadata: { bulk: true, count } });
    await refreshMatches(userId);
    return { verified: count };
  },

  async addSkill(userId: string, name: string, requestId?: string) {
    const profile = await profileRepo.ensure(userId);
    const canonicalName = normalizeSkill(name);
    const skill = await prisma.candidateSkill.upsert({
      where: { profileId_canonicalName: { profileId: profile.id, canonicalName } },
      create: { userId, profileId: profile.id, name, canonicalName, source: "USER_ADDED", status: "USER_VERIFIED" },
      update: { status: "USER_VERIFIED" },
    });
    await audit(userId, "fact.verified", { requestId, entityType: "skill", entityId: skill.id, metadata: { added: true } });
    await refreshMatches(userId);
    return skill;
  },
};
