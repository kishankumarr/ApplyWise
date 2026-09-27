import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma, type Prisma } from "@applywise/database";
import { normalizeSkill } from "@applywise/job-engine";
import { DEFAULT_SECTION_ORDER, resumeContentHash, type ResumeDocument } from "@applywise/resume-engine";
import { applicationService } from "@/server/services/application.service";
import { resumeSelectionService } from "@/server/services/resume-selection.service";
import { bareUser, disableTrackedUsers, uid } from "./automation-helpers";

/**
 * Automatic resume selection per application with two labelled variants (like the seeded "Frontend Resume" and
 * "Full-stack Resume": the same verified person, different emphasis): the best variant per job with a stored reason,
 * a user override that sticks through re-selection and preparation, and override(null) back to automatic.
 */

const VERIFIED_SKILLS = ["React", "TypeScript", "Next.js", "CSS", "Tailwind CSS", "Node.js", "Express", "PostgreSQL"];

function variant(headline: string, skills: string[], summary: string): ResumeDocument {
  return {
    contact: { fullName: "Asha Rao", email: "asha.rao@example.test", phone: null, location: "Bengaluru", links: [] },
    headline,
    summary,
    // Skill-neutral bullets: the emphasis lives in the headline, title and skills section.
    experience: [{ title: headline, company: "Clipverse Media", location: "Bengaluru", startDate: "2021", endDate: null, bullets: ["Shipped features used by thousands of creators every day."] }],
    projects: [],
    skills,
    education: [],
    achievements: [],
    sectionOrder: DEFAULT_SECTION_ORDER,
  };
}

const FRONTEND = variant("Frontend Engineer", ["React", "TypeScript", "Next.js", "CSS", "Tailwind CSS"], "Frontend engineer who builds accessible product interfaces.");
const FULLSTACK = variant("Full-Stack Developer", ["Node.js", "Express", "PostgreSQL", "TypeScript", "React"], "Full-stack developer who builds product features end to end.");

async function saveVariant(userId: string, label: string, doc: ResumeDocument) {
  return prisma.resumeVersion.create({ data: { userId, kind: "EDITED", label, content: doc as unknown as Prisma.InputJsonValue, contentHash: resumeContentHash(doc), approvedAt: new Date() } });
}

async function jobWithApp(userId: string, title: string, skills: { name: string; required: boolean; mandatory?: boolean }[]) {
  const key = uid();
  const job = await prisma.job.create({
    data: {
      ownerUserId: userId,
      platform: "COMPANY_CAREER_PAGE",
      title,
      company: `Selection Co ${key}`,
      description: `${title}.`,
      importMethod: "MANUAL_ENTRY",
      dedupeKey: `select-${key}`,
      applyUrl: `https://careers.selection.example/jobs/${key}`,
      applyMethod: "CAREER_PAGE",
      skillRequirements: { create: skills.map((s) => ({ name: s.name, canonicalName: normalizeSkill(s.name), required: s.required, mandatory: !!s.mandatory })) },
    },
  });
  const app = await prisma.application.create({ data: { userId, jobId: job.id, applyMethod: "CAREER_PAGE", status: "MATCHED", origin: "AUTOMATION", mode: "REVIEW" } });
  return { jobId: job.id, appId: app.id };
}

const appRow = (id: string) => prisma.application.findUniqueOrThrow({ where: { id } });

let userId: string;
let frontendVersion: string;
let fullstackVersion: string;
let frontendJob: { jobId: string; appId: string };
let fullstackJob: { jobId: string; appId: string };

beforeAll(async () => {
  userId = await bareUser("resume-select", { profile: true, fullName: "Asha Rao" });
  const profile = await prisma.candidateProfile.findUniqueOrThrow({ where: { userId } });
  await prisma.candidateSkill.createMany({ data: VERIFIED_SKILLS.map((name) => ({ userId, profileId: profile.id, name, canonicalName: normalizeSkill(name), status: "USER_VERIFIED" as const })) });
  frontendVersion = (await saveVariant(userId, "Frontend Resume", FRONTEND)).id;
  fullstackVersion = (await saveVariant(userId, "Full-stack Resume", FULLSTACK)).id;
  frontendJob = await jobWithApp(userId, "Frontend Engineer - Design System", [
    { name: "React", required: true, mandatory: true },
    { name: "TypeScript", required: true },
    { name: "Next.js", required: true },
    { name: "CSS", required: false },
    { name: "Tailwind CSS", required: false },
  ]);
  fullstackJob = await jobWithApp(userId, "Full-Stack Engineer - Payments API", [
    { name: "Node.js", required: true, mandatory: true },
    { name: "Express", required: true },
    { name: "PostgreSQL", required: true },
    { name: "React", required: false },
  ]);
});

afterAll(disableTrackedUsers);

describe("automatic resume selection", () => {
  it("picks the variant with the strongest verified evidence per job and stores the reason", async () => {
    const front = await resumeSelectionService.selectForApplication(userId, frontendJob.appId);
    expect(front).toMatchObject({ label: "Frontend Resume", versionId: frontendVersion, resumeId: `version:${frontendVersion}` });
    expect(front!.ranking.map((r) => r.label)).toEqual(["Frontend Resume", "Full-stack Resume"]);
    expect(front!.ranking[0]!.score).toBeGreaterThan(front!.ranking[1]!.score);
    expect(front!.reason).toMatch(/^Frontend Resume covers 5 of 5 job skills with verified evidence/);

    const full = await resumeSelectionService.selectForApplication(userId, fullstackJob.appId);
    expect(full).toMatchObject({ label: "Full-stack Resume", versionId: fullstackVersion });
    expect(full!.reason).toMatch(/^Full-stack Resume covers 4 of 4 job skills with verified evidence/);

    // Stored on the application: variants without an uploaded file are referenced by their version.
    expect(await appRow(frontendJob.appId)).toMatchObject({ selectedResumeId: null, selectedResumeVersionId: frontendVersion, resumeSelectionScore: front!.score, resumeSelectionReason: front!.reason, resumeSelectionOverridden: false });
    expect(await appRow(fullstackJob.appId)).toMatchObject({ selectedResumeVersionId: fullstackVersion, resumeSelectionReason: full!.reason });
    const event = await prisma.applicationEvent.findFirstOrThrow({ where: { applicationId: fullstackJob.appId, type: "resume_selected" } });
    expect(event.message).toContain('Selected "Full-stack Resume"');

    // Re-selecting with nothing changed keeps the choice without another timeline entry.
    await resumeSelectionService.selectForApplication(userId, fullstackJob.appId);
    expect(await prisma.applicationEvent.count({ where: { applicationId: fullstackJob.appId, type: "resume_selected" } })).toBe(1);
  });

  it("only verified skills count as evidence", async () => {
    await prisma.candidateSkill.updateMany({ where: { userId, canonicalName: { in: ["Node.js", "Express", "PostgreSQL"].map(normalizeSkill) } }, data: { status: "PARSED_UNVERIFIED" } });
    try {
      const ranked = await resumeSelectionService.rank(userId, fullstackJob.jobId);
      const fullstack = ranked!.ranking.find((r) => r.label === "Full-stack Resume")!;
      expect(fullstack.matchedSkills).toEqual(["React"]);
      expect(fullstack.missingSkills).toEqual(expect.arrayContaining(["Node.js", "Express", "PostgreSQL"]));
    } finally {
      await prisma.candidateSkill.updateMany({ where: { userId }, data: { status: "USER_VERIFIED" } });
    }
  });
});

describe("user override", () => {
  it("sticks through re-selection and preparation; override(null) returns to automatic", async () => {
    const res = await resumeSelectionService.override(userId, fullstackJob.appId, frontendVersion);
    expect(res).toEqual({ automatic: false, selection: null });
    const overridden = { selectedResumeId: null, selectedResumeVersionId: frontendVersion, resumeSelectionOverridden: true, resumeSelectionScore: null, resumeSelectionReason: "Chosen by you: Frontend Resume" };
    expect(await appRow(fullstackJob.appId)).toMatchObject(overridden);
    expect(await prisma.applicationEvent.findFirst({ where: { applicationId: fullstackJob.appId, type: "resume_overridden", actor: "user" } })).not.toBeNull();
    expect(await prisma.auditLog.count({ where: { userId, action: "application.resume_overridden", entityId: fullstackJob.appId } })).toBe(1);

    // Automatic re-selection leaves the user's choice alone...
    expect(await resumeSelectionService.selectForApplication(userId, fullstackJob.appId)).toBeNull();
    expect(await appRow(fullstackJob.appId)).toMatchObject(overridden);
    // ...including when the application is prepared (which re-runs the selection first).
    await prisma.application.update({ where: { id: fullstackJob.appId }, data: { status: "PREPARING" } });
    await applicationService.runPrepare(userId, fullstackJob.appId);
    const prepared = await appRow(fullstackJob.appId);
    expect(prepared.preparedAt).not.toBeNull();
    expect(prepared).toMatchObject(overridden);

    // Back to automatic: the best variant for this job again.
    const back = await resumeSelectionService.override(userId, fullstackJob.appId, null);
    expect(back).toMatchObject({ automatic: true, selection: { label: "Full-stack Resume", versionId: fullstackVersion } });
    expect(await appRow(fullstackJob.appId)).toMatchObject({ selectedResumeVersionId: fullstackVersion, resumeSelectionOverridden: false, resumeSelectionReason: expect.stringMatching(/^Full-stack Resume covers/) });
  });

  it("accepts the version reference form and refuses resumes or applications of other users", async () => {
    await resumeSelectionService.override(userId, frontendJob.appId, `version:${fullstackVersion}`);
    expect(await appRow(frontendJob.appId)).toMatchObject({ selectedResumeVersionId: fullstackVersion, resumeSelectionOverridden: true });

    const other = await bareUser("resume-select-other", { profile: true });
    const foreignVersion = (await saveVariant(other, "Other Resume", FRONTEND)).id;
    await expect(resumeSelectionService.override(userId, frontendJob.appId, foreignVersion)).rejects.toMatchObject({ status: 404 });
    await expect(resumeSelectionService.override(userId, frontendJob.appId, "no-such-resume")).rejects.toMatchObject({ status: 404 });
    await expect(resumeSelectionService.override(other, frontendJob.appId, foreignVersion)).rejects.toMatchObject({ status: 404 });
    await expect(resumeSelectionService.selectForApplication(other, frontendJob.appId)).rejects.toMatchObject({ status: 404 });
    // The failed attempts changed nothing.
    expect(await appRow(frontendJob.appId)).toMatchObject({ selectedResumeVersionId: fullstackVersion, resumeSelectionOverridden: true });
  });

  it("a newer version of a labelled variant replaces the older one in the selection", async () => {
    const newer = await saveVariant(userId, "Frontend Resume", { ...FRONTEND, skills: [...FRONTEND.skills, "Node.js"] });
    const ranked = await resumeSelectionService.rank(userId, frontendJob.jobId);
    expect(ranked!.ranking.map((r) => r.versionId).sort()).toEqual([newer.id, fullstackVersion].sort());
    expect(ranked).toMatchObject({ label: "Frontend Resume", versionId: newer.id });
  });
});
