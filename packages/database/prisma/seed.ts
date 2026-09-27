/**
 * Seed script - DEMO CONTENT ONLY.
 *
 * Creates the demo user, a pre-verified demo profile aligned with a frontend/full-stack
 * React + TypeScript developer, and 30+ fictional jobs from Naukri-like, Indeed-like,
 * Instahyre-like and ATS career-page sources. Safe to re-run (idempotent).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import bcrypt from "bcryptjs";
import { DEMO_WORK_AUTH_QUESTION, questionKeyFor } from "@applywise/job-engine";
import { checkResumeFormat, parseCvText, parsedCvToDocument, resumeContentHash, type ResumeDocument } from "@applywise/resume-engine";
import { applyParsedCv, prisma, recomputeMatchScores, seedDemoJobs, type Prisma } from "../src/index";

export const DEMO_EMAIL = "demo@applywise.test";
export const DEMO_PASSWORD = "DemoPass2026!";

const here = dirname(fileURLToPath(import.meta.url));

async function seedSkillTaxonomy() {
  // Example admin-extensible aliases (loaded into the matcher by the web app on start-up).
  const rows = [
    { name: "React Native", aliases: ["rn"], related: ["React"], category: "mobile" },
    { name: "TanStack Query", aliases: ["react query", "tanstack query"], related: ["React"], category: "frontend" },
    { name: "RxJS", aliases: ["rxjs", "reactive extensions"], related: ["Angular"], category: "frontend" },
    { name: "CRDTs", aliases: ["crdt", "crdts", "yjs", "automerge"], related: ["WebSockets"], category: "concept" },
  ];
  for (const r of rows) {
    await prisma.skill.upsert({ where: { name: r.name }, create: r, update: { aliases: r.aliases, related: r.related } });
  }
}

async function seedDemoUser() {
  await prisma.user.deleteMany({ where: { email: DEMO_EMAIL } });
  const user = await prisma.user.create({
    data: {
      email: DEMO_EMAIL,
      name: "Aarav Mehta (Demo)",
      passwordHash: await bcrypt.hash(DEMO_PASSWORD, 10),
      isDemo: true,
      // The fictional demo address cannot receive mail; treat it as confirmed so the demo works end to end.
      emailVerifiedAt: new Date(),
      consents: {
        create: [
          { type: "CV_PROCESSING", granted: true, grantedAt: new Date() },
          // Fictional demo user: AI consent covers any provider (see consent.service scopes).
          { type: "AI_PROCESSING", granted: true, version: "2026-09:external", grantedAt: new Date() },
          { type: "EMAIL_SENDING", granted: false },
          { type: "ANALYTICS", granted: false },
          // Fictional demo user: the standing authorisation for Auto mode (see docs/platform-integration-policy.md).
          { type: "AUTO_APPLY", granted: true, grantedAt: new Date() },
        ],
      },
    },
  });

  const cvText = readFileSync(join(here, "..", "..", "resume-engine", "fixtures", "demo-cv.txt"), "utf8");
  const parsed = parseCvText(cvText);
  const profile = await prisma.candidateProfile.create({
    data: {
      userId: user.id,
      fullName: parsed.fullName,
      email: parsed.email,
      phone: parsed.phone,
      yoe: parsed.totalYearsExperience ?? 5,
      currentTitle: parsed.experience[0]?.title ?? null,
      currentCompany: parsed.experience[0]?.company ?? null,
      summary: parsed.summary,
      githubUrl: parsed.links.github,
      linkedinUrl: parsed.links.linkedin,
      portfolioUrl: parsed.links.portfolio,
      resumeFormatWarnings: checkResumeFormat(cvText, parsed),
      onboardingCompleted: true,
      onboardingStep: 10,
      preference: {
        create: {
          userId: user.id,
          preferredLocations: ["Bengaluru", "Remote - India"],
          workModePreference: "any",
          openToRelocation: false,
          targetRoles: ["Frontend Engineer", "React Developer", "Full-Stack Developer"],
          noticePeriod: "30 days",
          expectedSalaryMin: 2800000,
          expectedSalaryMax: 3800000,
        },
      },
    },
  });

  await applyParsedCv(prisma, { userId: user.id, profileId: profile.id, resumeId: null, parsed, status: "USER_VERIFIED", source: "DEMO_SEED" });
  // Leave a couple of claims unverified so the verification flow is visible in the demo.
  await prisma.candidateSkill.updateMany({ where: { userId: user.id, canonicalName: { in: ["Docker", "Figma"] } }, data: { status: "PARSED_UNVERIFIED" } });
  await prisma.truthBankItem.updateMany({ where: { userId: user.id, kind: "ACHIEVEMENT" }, data: { status: "PARSED_UNVERIFIED", verifiedAt: null } });

  const doc = parsedCvToDocument(parsed);
  await prisma.resumeVersion.create({
    data: {
      userId: user.id,
      kind: "ORIGINAL",
      label: "Demo CV (original, parsed)",
      content: doc as unknown as Prisma.InputJsonValue,
      contentHash: resumeContentHash(doc),
      approvedAt: new Date(),
    },
  });

  await seedDemoAutomation(user.id, profile.id, doc);

  await prisma.auditLog.create({ data: { userId: user.id, action: "demo.seeded", entityType: "User", entityId: user.id, metadata: { demo: true } } });
  return user;
}

/** Put the listed skills first (same verified content, different emphasis - never new claims). */
function emphasise(skills: string[], first: string[]): string[] {
  const lower = first.map((s) => s.toLowerCase());
  return [...skills.filter((s) => lower.includes(s.toLowerCase())), ...skills.filter((s) => !lower.includes(s.toLowerCase()))];
}

/**
 * DEMO CONTENT for the automation pipeline: resume variants, reusable answers the demo user "gave once", and Auto-mode
 * settings. Automation stays OFF here: `pnpm --filter @applywise/web demo:automation` connects the demo provider
 * (encrypted token), turns it on and runs the real pipeline.
 */
async function seedDemoAutomation(userId: string, profileId: string, doc: ResumeDocument) {
  const variants = [
    { label: "Frontend Resume", headline: "Frontend Engineer", first: ["React", "TypeScript", "Next.js", "JavaScript", "CSS", "HTML"] },
    { label: "Full-stack Resume", headline: "Full-Stack Developer", first: ["Node.js", "Express", "REST API", "PostgreSQL", "TypeScript", "React"] },
  ];
  for (const v of variants) {
    const variant: ResumeDocument = { ...doc, headline: v.headline, skills: emphasise(doc.skills, v.first) };
    await prisma.resumeVersion.create({
      data: { userId, kind: "EDITED", label: v.label, content: variant as unknown as Prisma.InputJsonValue, contentHash: resumeContentHash(variant), approvedAt: new Date() },
    });
  }
  await prisma.candidateAnswer.createMany({
    data: [
      { userId, profileId, questionKey: questionKeyFor(DEMO_WORK_AUTH_QUESTION), question: DEMO_WORK_AUTH_QUESTION, answer: "Yes" },
      { userId, profileId, questionKey: questionKeyFor("What is your current location?"), question: "What is your current location?", answer: "Bengaluru" },
    ],
  });
  await prisma.automationSettings.create({
    data: {
      userId,
      enabled: false,
      mode: "AUTO",
      recommendScore: 50,
      minMatchScore: 70,
      autoApplyScore: 90,
      maxApplicationsPerDay: 30,
      maxJobAgeDays: 14,
      searchFrequencyMinutes: 360,
      timezone: "Asia/Kolkata",
      dailySummaryHour: 20,
    },
  });
  // Shows the excluded-company rule on an otherwise reviewable demo job.
  await prisma.automationRule.create({ data: { userId, excludedCompanies: ["Bazaarly"] } });
}

async function main() {
  const appUrl = process.env.APP_URL ?? "http://localhost:3000";
  await seedSkillTaxonomy();
  const jobs = await seedDemoJobs(prisma, appUrl);
  const user = await seedDemoUser();
  const scored = await recomputeMatchScores(prisma, user.id);
  console.warn(`[seed] DEMO CONTENT: ${jobs} demo jobs, demo user ${DEMO_EMAIL}, ${scored} match scores computed.`);
}

main()
  .catch((e) => {
    console.error("[seed] failed", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
