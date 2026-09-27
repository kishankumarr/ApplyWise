import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { vi } from "vitest";
import { prisma, type ApplicationMode, type ApplicationStatus, type Prisma } from "@applywise/database";
import { DEMO_WORK_AUTH_QUESTION, generateDemoAutomationJobs, MATCH_ENGINE_VERSION, normalizeRawJob } from "@applywise/job-engine";
import { parseCvText, parsedCvToDocument, renderResumeDocx } from "@applywise/resume-engine";
import type { AutomationSettingsUpdateInput } from "@applywise/validation";
import { authService } from "@/server/services/auth.service";
import { automationSettingsService } from "@/server/services/automation-settings.service";
import { candidateAnswersService } from "@/server/services/candidate-answers.service";
import { consentService } from "@/server/services/consent.service";
import { demoAutomationService } from "@/server/services/demo-automation.service";
import { jobsService } from "@/server/services/jobs.service";
import { profileService } from "@/server/services/profile.service";
import { providerConnectionsService } from "@/server/services/provider-connections.service";
import { resumeService } from "@/server/services/resume.service";

/**
 * Shared fixtures for the automation service tests (not a test file itself).
 *
 * The unit database is shared across runs and files, so every user created here is tracked: global scheduler
 * queries can be scoped to them (scopeGlobalQueriesToTrackedUsers) and their automation is switched off at the end
 * of a file (disableTrackedUsers) so later scheduler ticks elsewhere never pick them up.
 */

const tracked = new Set<string>();

export const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

export function track(userId: string): string {
  tracked.add(userId);
  return userId;
}

export function trackedUsers(): string[] {
  return [...tracked];
}

/** A new user with a parsed, verified CV and preferences, like after onboarding (same as the acceptance test). */
export async function onboardedUser(tag: string): Promise<string> {
  const email = `auto-${tag}-${uid()}@example.test`;
  const userId = track((await authService.signUp({ name: "Aarav Mehta", email, password: "Password123", acceptTerms: true })).userId);
  await consentService.update(userId, { cvProcessing: true, aiProcessing: false });
  const text = readFileSync(resolve(__dirname, "../../../packages/resume-engine/fixtures/demo-cv.txt"), "utf8");
  const docx = await renderResumeDocx(parsedCvToDocument(parseCvText(text)));
  const file = new File([new Uint8Array(docx)], "demo-cv.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
  const resumeId = (await resumeService.upload(userId, file)).id;
  await resumeService.requestParse(userId, resumeId); // inline queue => parsed synchronously
  await profileService.verifyAll(userId);
  await profileService.update(userId, {
    yoe: 5,
    preferredLocations: ["Bengaluru", "Remote - India"],
    workModePreference: "any",
    targetRoles: ["Frontend Engineer", "React Developer", "Full-Stack Developer"],
    noticePeriod: "30 days",
    expectedSalaryMin: 2800000,
    expectedSalaryMax: 3800000,
    onboardingCompleted: true,
  });
  // An answer the user gave once and that is reused for every application.
  await candidateAnswersService.upsert(userId, { question: DEMO_WORK_AUTH_QUESTION, answer: "Yes" });
  return userId;
}

/** A bare account (no CV). `profile` adds a minimal profile + preferences (enough for an automation run). */
export async function bareUser(tag: string, opts: { profile?: boolean; fullName?: string } = {}): Promise<string> {
  const email = `auto-${tag}-${uid()}@example.test`;
  const user = await prisma.user.create({ data: { email, name: opts.fullName ?? "Asha Rao", passwordHash: "unused-in-tests", emailVerifiedAt: new Date() } });
  track(user.id);
  if (opts.profile) {
    const profile = await prisma.candidateProfile.create({ data: { userId: user.id, fullName: opts.fullName ?? "Asha Rao", email, yoe: 5 } });
    await prisma.candidatePreference.create({ data: { profileId: profile.id, userId: user.id, preferredLocations: ["Bengaluru"], noticePeriod: "30 days" } });
  }
  return user.id;
}

export type DemoSetup = "feed" | "connection" | "none";

/**
 * Turn the automation on like the acceptance test. `demo`: "feed" = demoAutomationService.setup (demo feed + encrypted
 * connection; the next run discovers the whole 120-job catalogue), "connection" = only the demo connection (jobs are
 * imported selectively with importDemoJobs), "none" = no provider setup.
 */
export async function enableAutomation(userId: string, mode: ApplicationMode, overrides: AutomationSettingsUpdateInput = {}, demo: DemoSetup = "feed") {
  await automationSettingsService.update(userId, {
    enabled: true,
    mode,
    ...(mode === "AUTO" ? { autoApplyConsent: true } : {}),
    recommendScore: 50,
    minMatchScore: 70,
    autoApplyScore: 90,
    maxApplicationsPerDay: 30,
    maxJobAgeDays: 14,
    ...overrides,
  });
  if (demo === "feed") await demoAutomationService.setup(userId, { run: false });
  if (demo === "connection") await connectDemo(userId);
}

export async function connectDemo(userId: string, expiresAt?: Date) {
  return providerConnectionsService.connect(userId, "demo", { token: `demo-${uid()}`, accountLabel: "Demo account (fictional)", expiresAt: expiresAt?.toISOString() ?? null });
}

/**
 * Import selected jobs of the demo provider's catalogue (DEMO CONTENT) as if the demo feed had found them, without
 * the other 110+ jobs: same raws, same normaliser, same persistence and scoring as a feed sync. Returns key -> jobId.
 */
export async function importDemoJobs(userId: string, keys: string[]): Promise<Map<string, string>> {
  const seen = new Set<string>();
  const raws = generateDemoAutomationJobs({ appUrl: process.env.APP_URL ?? "http://localhost:3000" }).filter((r) => {
    const key = (r.raw as { key?: string }).key ?? "";
    if (!keys.includes(key) || seen.has(key)) return false; // primary listing only (no cross-provider duplicate)
    seen.add(key);
    return true;
  });
  if (raws.length !== keys.length) throw new Error(`Unknown demo job keys: ${keys.filter((k) => !seen.has(k)).join(", ")}`);
  const { results } = await jobsService.importRaws(userId, raws, { connector: "feed:demo", normalize: normalizeRawJob });
  return new Map(raws.map((r, i) => [(r.raw as { key: string }).key, results[i]!.jobId]));
}

/** The user's applications keyed by the demo catalogue key of their job. */
export async function appsByDemoKey(userId: string) {
  const apps = await prisma.application.findMany({
    where: { userId },
    include: { job: { include: { sources: { orderBy: { createdAt: "asc" }, take: 1, select: { metadata: true } } } } },
  });
  return new Map(apps.map((a) => [(a.job.sources[0]?.metadata as { key?: string } | null)?.key ?? a.jobId, a]));
}

/** A plain (non-demo) job owned by the user, plus an application in the given state. */
export async function fabricateApp(
  userId: string,
  o: { status?: ApplicationStatus; mode?: ApplicationMode | null; origin?: "USER" | "AUTOMATION"; nextActionAt?: Date | null; screeningQuestions?: string[]; title?: string } = {},
): Promise<{ appId: string; jobId: string }> {
  const key = uid();
  const job = await prisma.job.create({
    data: {
      ownerUserId: userId,
      platform: "COMPANY_CAREER_PAGE",
      title: o.title ?? "Frontend Engineer",
      company: `Fixture Co ${key}`,
      description: "Build our React product.",
      importMethod: "MANUAL_ENTRY",
      dedupeKey: `fixture-${key}`,
      matchKey: `fixture-mk-${key}`,
      applyUrl: `https://careers.fixture.example/jobs/${key}`,
      applyMethod: "CAREER_PAGE",
      screeningQuestions: o.screeningQuestions ?? [],
    },
  });
  const app = await prisma.application.create({
    data: {
      userId,
      jobId: job.id,
      applyMethod: "CAREER_PAGE",
      status: o.status ?? "APPROVED",
      origin: o.origin ?? "AUTOMATION",
      mode: o.mode === undefined ? "AUTO" : o.mode,
      canonicalJobKey: job.matchKey,
      nextActionAt: o.nextActionAt ?? null,
      ...(o.status === "APPROVED" || o.status === undefined ? { approvedAt: new Date(), approvalSource: "policy" } : {}),
    },
  });
  return { appId: app.id, jobId: job.id };
}

type FindMany = (args?: { where?: object } & Record<string, unknown>) => Promise<unknown>;

/**
 * The scheduler's cross-user queries (tick, daily summaries, deferred re-drive) would otherwise also claim users that
 * other test files and earlier runs left in the shared database. Restrict them to the users created by this file.
 * Returns a function that removes the restriction.
 */
export function scopeGlobalQueriesToTrackedUsers(): () => void {
  const restore: (() => void)[] = [];
  for (const delegate of [prisma.automationSettings, prisma.application] as unknown as Record<"findMany", FindMany>[]) {
    const original = delegate.findMany.bind(delegate);
    const spy = vi.spyOn(delegate, "findMany").mockImplementation((args) => original({ ...args, where: { AND: [args?.where ?? {}, { userId: { in: trackedUsers() } }] } }));
    // mockRestore() cannot restore a property of Prisma's model proxy: delegate to the original instead.
    restore.push(() => spy.mockImplementation(original));
  }
  return () => restore.forEach((r) => r());
}

/** Leave nothing due for other files' scheduler ticks. */
export async function disableTrackedUsers(): Promise<void> {
  await prisma.automationSettings.updateMany({ where: { userId: { in: trackedUsers() } }, data: { enabled: false, nextRunAt: null, runLeaseUntil: null } });
}

export type AppRow = Prisma.ApplicationGetPayload<object>;

/**
 * Give a fabricated application the evaluation a real automation run would have recorded: a match score computed
 * under the profile's current facts, and the decision made after it (the AUTO policy never acts on stale decisions).
 */
export async function markEvaluated(userId: string, applicationId: string, jobId: string, score = 95): Promise<void> {
  const profile = await prisma.candidateProfile.findUnique({ where: { userId }, select: { factsVersion: true } });
  const computedAt = new Date(Date.now() - 1_000);
  const data = { score, label: "strong", recommendation: "apply", report: {}, engineVersion: MATCH_ENGINE_VERSION, factsVersion: profile?.factsVersion ?? 1, computedAt };
  await prisma.jobMatchScore.upsert({ where: { userId_jobId: { userId, jobId } }, create: { userId, jobId, ...data }, update: data });
  await prisma.application.update({ where: { id: applicationId }, data: { evaluatedAt: new Date() } });
}
