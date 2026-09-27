import { markEvaluated } from "./automation-helpers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, type ApplicationMode, type ApplicationStatus, type Prisma } from "@applywise/database";
import type * as JobEngine from "@applywise/job-engine";
import type { ApplicationSupport, JobProvider, ProviderQuestion, SubmissionPayload, SubmissionResult } from "@applywise/job-engine";
import { DEFAULT_SECTION_ORDER, type ResumeDocument } from "@applywise/resume-engine";
import type { ApplicationQuestion, CanonicalQuestionKey, ProviderAuthMode, ProviderInfo } from "@applywise/types";
import type * as Transitions from "@/server/services/application-transitions";
import { applicationExecutionService, EXECUTION_LEASE_MS } from "@/server/services/application-execution.service";
import { inQuietHours } from "@/server/services/automation-time";
import { dailyLimitService } from "@/server/services/daily-limit.service";
import { providerConnectionsService } from "@/server/services/provider-connections.service";

// The provider registry and the question classifier belong to other workstreams: tests inject fakes, and the queue
// is captured so delayed re-enqueues (retries, deferrals) can be asserted and replayed deterministically.
const h = vi.hoisted(() => ({
  provider: null as unknown as JobProvider,
  providers: {} as Record<string, JobProvider>,
  enqueue: vi.fn(async (..._args: unknown[]) => ({ taskId: "test-task" })),
  /** Make the next transition with this action throw a non-AppError (a dropped DB connection, a killed process). */
  failTransition: null as string | null,
}));

vi.mock("@/server/queue", () => ({ enqueue: (...args: unknown[]) => h.enqueue(...args) }));

vi.mock("@/server/services/application-transitions", async (importOriginal) => {
  const actual = await importOriginal<typeof Transitions>();
  return {
    ...actual,
    transitionApplication: async (...args: Parameters<typeof actual.transitionApplication>) => {
      if (h.failTransition && args[2] === h.failTransition) {
        h.failTransition = null;
        throw new Error("Connection reset");
      }
      return actual.transitionApplication(...args);
    },
  };
});

vi.mock("@applywise/job-engine", async (importOriginal) => {
  const actual = await importOriginal<typeof JobEngine>();
  const keyFor = (q: string) =>
    /notice period/i.test(q) ? "notice_period" : /current location/i.test(q) ? "current_location" : `custom:${q.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
  return {
    ...actual,
    applicationProviderForJob: () => h.provider,
    getProvider: (id: string) => h.providers[id] ?? null,
    questionKeyFor: keyFor,
    classifyQuestion: (q: string, opts: { required?: boolean } = {}): ApplicationQuestion => {
      const key = keyFor(q);
      const canonicalKey = (key.startsWith("custom:") ? "custom" : key) as CanonicalQuestionKey;
      return { key, canonicalKey, question: q, required: !!opts.required, inputType: "text", options: null, skill: null, sensitive: canonicalKey === "notice_period", origin: "provider" };
    },
  };
});

// ---------------------------------------------------------------- fixtures

const RESUME: ResumeDocument = {
  contact: { fullName: "Asha Rao Kumar", email: "asha@example.test", phone: null, location: "Bengaluru", links: [] },
  headline: "Frontend Engineer",
  summary: "Frontend engineer.",
  experience: [{ title: "Frontend Engineer", company: "Clipverse Media", location: null, startDate: "2021", endDate: null, bullets: ["Built the editor timeline."] }],
  projects: [],
  skills: ["React", "TypeScript"],
  education: [],
  achievements: [],
  sectionOrder: DEFAULT_SECTION_ORDER,
};

const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

interface UserOptions {
  limit?: number;
  quiet?: [number, number] | null;
  enabled?: boolean;
  mode?: ApplicationMode;
  autoApply?: boolean;
  emailConsent?: boolean;
  verified?: boolean;
  allowEmail?: boolean;
  coverLetters?: boolean;
  /** false = only the raw CV import (ORIGINAL, never approved) exists. */
  approvedResume?: boolean;
}

async function newUser(label: string, o: UserOptions = {}): Promise<string> {
  const email = `exec-${label}-${uid()}@example.test`;
  const user = await prisma.user.create({ data: { email, name: label, passwordHash: "unused-in-tests", emailVerifiedAt: o.verified === false ? null : new Date() } });
  const profile = await prisma.candidateProfile.create({
    data: { userId: user.id, fullName: "Asha  Rao Kumar", email, phone: "+91 90000 00000", yoe: 5, currentTitle: "Frontend Engineer", currentCompany: "Clipverse Media", linkedinUrl: "https://www.linkedin.com/in/asha-test" },
  });
  await prisma.candidatePreference.create({ data: { profileId: profile.id, userId: user.id, preferredLocations: ["Remote - India", "Bengaluru"], noticePeriod: "30 days" } });
  await prisma.automationSettings.create({
    data: {
      userId: user.id,
      enabled: o.enabled ?? true,
      mode: o.mode ?? "AUTO",
      maxApplicationsPerDay: o.limit ?? 10,
      timezone: "UTC",
      quietHoursStart: o.quiet?.[0] ?? null,
      quietHoursEnd: o.quiet?.[1] ?? null,
      allowEmailApplications: o.allowEmail ?? false,
      generateCoverLetter: o.coverLetters ?? true,
    },
  });
  await prisma.userConsent.createMany({
    data: [
      { userId: user.id, type: "AUTO_APPLY", granted: o.autoApply ?? true, grantedAt: new Date() },
      { userId: user.id, type: "EMAIL_SENDING", granted: o.emailConsent ?? false, grantedAt: new Date() },
    ],
  });
  // The raw CV import is never approved; the user's own edited version is.
  await prisma.resumeVersion.create({ data: { userId: user.id, kind: "ORIGINAL", label: "Base resume", content: RESUME as unknown as Prisma.InputJsonValue, contentHash: `hash-${uid()}` } });
  if (o.approvedResume !== false) {
    await prisma.resumeVersion.create({ data: { userId: user.id, kind: "EDITED", label: "Edited resume", content: RESUME as unknown as Prisma.InputJsonValue, contentHash: `hash-${uid()}`, approvedAt: new Date() } });
  }
  return user.id;
}

interface AppOptions {
  matchKey?: string | null;
  status?: ApplicationStatus;
  mode?: ApplicationMode | null;
  approvalSource?: "user" | "policy";
  approvedAt?: Date | null;
  rulesVersion?: number | null;
  hrEmail?: string | null;
  description?: string;
}

async function newApp(userId: string, o: AppOptions = {}): Promise<{ appId: string; jobId: string; matchKey: string | null }> {
  const key = uid();
  const matchKey = o.matchKey === undefined ? `exec-mk-${key}` : o.matchKey;
  const job = await prisma.job.create({
    data: {
      ownerUserId: userId,
      platform: "GREENHOUSE",
      title: "Frontend Engineer",
      company: "Acme Test",
      description: o.description ?? "Build our React product.",
      importMethod: "MANUAL_ENTRY",
      dedupeKey: `exec-${key}`,
      matchKey,
      applyUrl: "https://careers.acme.example/jobs/1",
      hrEmail: o.hrEmail ?? null,
      applyMethod: o.hrEmail ? "EMAIL" : "CAREER_PAGE",
    },
  });
  const app = await prisma.application.create({
    data: {
      userId,
      jobId: job.id,
      status: o.status ?? "APPROVED",
      applyMethod: job.applyMethod,
      origin: "AUTOMATION",
      mode: o.mode === undefined ? "AUTO" : o.mode,
      approvalSource: o.approvalSource ?? "policy",
      approvedAt: o.approvedAt === undefined ? new Date() : o.approvedAt,
      // Evaluated under the settings' current rules (schema default 1).
      rulesVersion: o.rulesVersion === undefined ? 1 : o.rulesVersion,
    },
  });
  await markEvaluated(userId, app.id, job.id);
  return { appId: app.id, jobId: job.id, matchKey };
}

function info(id: string, auth: ProviderAuthMode): ProviderInfo {
  const cap = { status: "SUPPORTED" as const, via: null, note: "" };
  return {
    id,
    label: `Fake ${id}`,
    kind: "ats",
    platforms: ["GREENHOUSE"],
    auth,
    capabilities: { DISCOVERY: cap, DETAIL_FETCH: cap, QUESTION_EXTRACTION: cap, AUTO_APPLY: cap, STATUS_TRACKING: cap },
    manualOnly: false,
    externalRequirements: [],
    notes: [],
    demo: false,
  };
}

const calls: SubmissionPayload[] = [];
type Submit = (p: SubmissionPayload) => Promise<SubmissionResult>;
const submitted: Submit = async () => ({ outcome: "SUBMITTED", externalApplicationId: "EXT-1", confirmation: "Application received" });

function useProvider(id: string, opts: { auth?: ProviderAuthMode; support?: ApplicationSupport; submit?: Submit } = {}): JobProvider {
  const p: JobProvider = {
    id,
    info: () => info(id, opts.auth ?? "none"),
    matchesJob: () => true,
    supportsApplication: () => opts.support ?? { supported: true, channel: "api", reason: null, detail: "" },
    submitApplication: async (payload) => {
      calls.push(payload);
      return (opts.submit ?? submitted)(payload);
    },
  };
  h.provider = p;
  h.providers[id] = p;
  return p;
}

type Enqueued = [string, Record<string, unknown>, { userId: string; runAt?: Date; dedupeKey?: string }];
const execute = (userId: string, appId: string, opts: { runId?: string | null; retry?: boolean; approvedAt?: string | null } = {}) => applicationExecutionService.execute(userId, appId, opts);
const appRow = (id: string) => prisma.application.findUniqueOrThrow({ where: { id } });
const executions = (appId: string) => prisma.applicationExecution.findMany({ where: { applicationId: appId } });
const countToday = (userId: string) => dailyLimitService.countToday(userId, "UTC");
const notifications = (userId: string, type: string) => prisma.notification.findMany({ where: { userId, type } });
const newRun = async (userId: string) => (await prisma.automationRun.create({ data: { userId, trigger: "manual", mode: "AUTO" } })).id;
const enqueued = (appId: string) => (h.enqueue.mock.calls as unknown as Enqueued[]).filter((c) => c[1].applicationId === appId);
/** Replay a captured application.execute task exactly as the queue handler would. */
const replay = (userId: string, task: Enqueued) =>
  execute(userId, String(task[1].applicationId), { runId: (task[1].runId as string | null) ?? null, retry: task[1].retry === true, approvedAt: (task[1].approvedAt as string | undefined) ?? null });
const minutesNow = () => {
  const now = new Date();
  return now.getUTCHours() * 60 + now.getUTCMinutes();
};

beforeEach(() => {
  calls.length = 0;
  h.enqueue.mockClear();
  h.failTransition = null;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------- tests

describe("execute: happy path", () => {
  it("submits through the API executor with verified data only and records every trace", async () => {
    const u = await newUser("happy");
    const { appId, matchKey } = await newApp(u);
    await prisma.coverLetter.create({ data: { userId: u, applicationId: appId, body: "Dear team, I would like to apply.", originalBody: "x", provider: "fallback", promptVersion: "v1" } });
    await prisma.screeningAnswerDraft.createMany({
      data: [
        { userId: u, applicationId: appId, question: "What is your notice period?", answer: "30 days", originalAnswer: "30 days", provider: "rules", promptVersion: "answers-v1", questionKey: "notice_period", resolved: true, answerSource: "PREFERENCE" },
        { userId: u, applicationId: appId, question: "Expected salary?", answer: "", originalAnswer: "", provider: "rules", promptVersion: "answers-v1", questionKey: "expected_salary", resolved: false, answerSource: "UNKNOWN", sortOrder: 1 },
      ],
    });
    const runId = await newRun(u);
    useProvider("acme-api");

    const res = await execute(u, appId, { runId });
    expect(res.outcome).toBe("APPLIED");

    const app = await appRow(appId);
    expect(app).toMatchObject({ status: "APPLIED", externalApplicationId: "EXT-1", executorKind: "API", executorId: "api:acme-api", nextActionAt: null });
    expect(app.appliedAt).toBeInstanceOf(Date);
    const [ex] = await executions(appId);
    expect(ex).toMatchObject({ status: "SUCCEEDED", attempts: 1, leaseUntil: null, idempotencyKey: `${u}:${matchKey}`, externalApplicationId: "EXT-1", slotDay: dailyLimitService.dayKey(new Date(), "UTC") });
    expect(ex!.finishedAt).toBeInstanceOf(Date);
    const events = await prisma.applicationEvent.findMany({ where: { applicationId: appId }, orderBy: { createdAt: "asc" } });
    expect(events.map((e) => [e.type, e.toStatus, e.actor])).toEqual([
      ["execute_started", "APPLYING", "executor"],
      ["execute_succeeded", "APPLIED", "executor"],
    ]);
    expect((await notifications(u, "application.submitted")).map((n) => n.dedupeKey)).toEqual([`submitted:${appId}`]);
    expect((await prisma.automationRun.findUniqueOrThrow({ where: { id: runId } })).applicationsSubmitted).toBe(1);
    expect(await countToday(u)).toBe(1);
    expect(await prisma.auditLog.count({ where: { userId: u, action: "application.submitted_by_executor" } })).toBe(1);

    // Payload: profile values the user entered, the approved resume PDF, the cover letter and resolved answers only.
    expect(calls).toHaveLength(1);
    const p = calls[0]!;
    expect(p.idempotencyKey).toBe(`${u}:${matchKey}`);
    // No current-location answer: where the user lives is unknown (never a preferred city).
    expect(p.applicant).toMatchObject({ fullName: "Asha Rao Kumar", firstName: "Asha", lastName: "Rao Kumar", location: null, yearsOfExperience: 5, githubUrl: null });
    expect(Buffer.from(p.resume!.content).subarray(0, 4).toString()).toBe("%PDF");
    expect(p.coverLetter).toBe("Dear team, I would like to apply.");
    expect(p.answers).toEqual([{ key: "notice_period", question: "What is your notice period?", answer: "30 days" }]);
    expect(p.credential).toBeNull();

    // Running it again is a no-op.
    await expect(execute(u, appId, { retry: true })).resolves.toMatchObject({ outcome: "SKIPPED" });
    expect(calls).toHaveLength(1);
  });

  it("prefers the approved tailored resume of this application", async () => {
    const u = await newUser("tailored");
    const { appId } = await newApp(u);
    const tailored: ResumeDocument = { ...RESUME, contact: { ...RESUME.contact, fullName: "Asha Tailored" } };
    await prisma.resumeVersion.create({ data: { userId: u, applicationId: appId, kind: "TAILORED", label: "Tailored", content: tailored as unknown as Prisma.InputJsonValue, contentHash: `t-${uid()}`, approvedAt: new Date() } });
    useProvider("acme-api");
    await execute(u, appId);
    expect(calls[0]!.resume!.fileName).toBe("Asha_Tailored_Resume.pdf");
  });

  it("never sends the unapproved raw CV import: without an approved resume the user takes over", async () => {
    const u = await newUser("raw-resume", { approvedResume: false });
    const { appId } = await newApp(u);
    // Even when the preparation selected the raw import as the base version.
    const original = await prisma.resumeVersion.findFirstOrThrow({ where: { userId: u, kind: "ORIGINAL" } });
    await prisma.application.update({ where: { id: appId }, data: { selectedResumeVersionId: original.id } });
    useProvider("acme-api");
    const res = await execute(u, appId);
    expect(res).toMatchObject({ outcome: "MANUAL_ACTION_REQUIRED", detail: expect.stringContaining("No approved resume") });
    expect(calls).toHaveLength(0);
    expect(await appRow(appId)).toMatchObject({ status: "MANUAL_ACTION_REQUIRED", manualActionReason: "UNSUPPORTED_FLOW" });
    expect((await executions(appId))[0]).toMatchObject({ status: "MANUAL_ACTION_REQUIRED", slotDay: null, leaseUntil: null });
    expect(await countToday(u)).toBe(0);
  });

  it("sends where the user lives only from their own answer, and no cover letter when cover letters are off", async () => {
    const u = await newUser("location-cover", { coverLetters: false });
    const { appId } = await newApp(u);
    await prisma.coverLetter.create({ data: { userId: u, applicationId: appId, body: "Dear team, an old letter.", originalBody: "x", provider: "fallback", promptVersion: "v1" } });
    await prisma.screeningAnswerDraft.create({
      data: { userId: u, applicationId: appId, question: "Current location", answer: "Kolkata", originalAnswer: "Kolkata", provider: "user", promptVersion: "answers-v1", questionKey: "current_location", resolved: true, answerSource: "CANDIDATE_ANSWER" },
    });
    useProvider("acme-api");
    await expect(execute(u, appId)).resolves.toMatchObject({ outcome: "APPLIED" });
    // preferredLocations = ["Remote - India", "Bengaluru"]: never sent as the current location.
    expect(calls[0]!.applicant.location).toBe("Kolkata");
    expect(calls[0]!.coverLetter).toBeNull();
  });

  it("describes the executor without side effects", async () => {
    const u = await newUser("describe");
    const { appId } = await newApp(u);
    useProvider("acme-api");
    await expect(applicationExecutionService.describeExecutor(u, appId)).resolves.toMatchObject({ kind: "API", id: "api:acme-api", automatic: true, reason: null, paused: false });
    useProvider("restricted", { support: { supported: false, channel: "manual", reason: "PROVIDER_RESTRICTION", detail: "No automation here." } });
    await expect(applicationExecutionService.describeExecutor(u, appId)).resolves.toMatchObject({ kind: "MANUAL", automatic: false, reason: "PROVIDER_RESTRICTION", detail: "No automation here.", paused: false });
    expect((await appRow(appId)).status).toBe("APPROVED");
    expect(await executions(appId)).toHaveLength(0);
    const manual = await newApp(u, { mode: "MANUAL" });
    await expect(applicationExecutionService.describeExecutor(u, manual.appId)).resolves.toMatchObject({ automatic: false, reason: null });
  });
});

describe("execute: approval, modes, policy and quiet hours", () => {
  it("never executes MANUAL-mode or mode-less applications", async () => {
    const u = await newUser("manual-mode", { mode: "MANUAL" });
    useProvider("acme-api");
    for (const mode of ["MANUAL", null] as const) {
      const { appId } = await newApp(u, { mode, approvalSource: "user" });
      await expect(execute(u, appId)).resolves.toMatchObject({ outcome: "SKIPPED" });
      expect((await appRow(appId)).status).toBe("APPROVED");
      expect(await executions(appId)).toHaveLength(0);
    }
    expect(calls).toHaveLength(0);
  });

  it("never submits content nobody approved, even on an explicit retry", async () => {
    const u = await newUser("unapproved");
    useProvider("acme-api");
    for (const status of ["APPROVED", "FAILED", "MANUAL_ACTION_REQUIRED"] as const) {
      const { appId } = await newApp(u, { status, approvalSource: "user", approvedAt: null });
      await expect(execute(u, appId, { retry: true })).resolves.toMatchObject({ outcome: "SKIPPED", detail: expect.stringContaining("never approved") });
      expect((await appRow(appId)).status).toBe(status);
      expect(await executions(appId)).toHaveLength(0);
    }
    expect(calls).toHaveLength(0);
    expect(await countToday(u)).toBe(0);
  });

  it("a deferred task only submits under the approval it was scheduled for", async () => {
    const u = await newUser("stamp");
    useProvider("acme-api");
    const scheduledUnder = new Date(Date.now() - 3_600_000);
    const { appId } = await newApp(u, { approvalSource: "user", approvedAt: new Date() });
    // The user re-approved (or edited and approved again) after the task was scheduled.
    await expect(execute(u, appId, { approvedAt: scheduledUnder.toISOString() })).resolves.toMatchObject({ outcome: "SKIPPED", detail: expect.stringContaining("approval changed") });
    expect(calls).toHaveLength(0);
    expect(await executions(appId)).toHaveLength(0);
    const current = (await appRow(appId)).approvedAt!;
    await expect(execute(u, appId, { approvedAt: current.toISOString() })).resolves.toMatchObject({ outcome: "APPLIED" });
  });

  it("a blocked policy approval goes back to the user's review queue instead of staying APPROVED", async () => {
    const u = await newUser("policy", { autoApply: false });
    useProvider("acme-api");
    const policy = await newApp(u, { approvalSource: "policy" });
    const res = await execute(u, policy.appId);
    expect(res.outcome).toBe("SKIPPED");
    expect(res.detail).toContain("auto-apply consent");
    expect(await appRow(policy.appId)).toMatchObject({ status: "WAITING_APPROVAL", approvalSource: null, approvedAt: null, nextActionAt: null });
    expect(await prisma.applicationEvent.count({ where: { applicationId: policy.appId, fromStatus: "APPROVED", toStatus: "WAITING_APPROVAL", actor: "policy" } })).toBe(1);
    expect((await notifications(u, "application.approval_required")).map((n) => n.dedupeKey)).toEqual([expect.stringMatching(new RegExp(`^review:${policy.appId}:returned:`))]);
    expect(calls).toHaveLength(0);
    // A leftover task for it does nothing.
    await expect(execute(u, policy.appId)).resolves.toMatchObject({ outcome: "SKIPPED" });

    await prisma.userConsent.update({ where: { userId_type: { userId: u, type: "AUTO_APPLY" } }, data: { granted: true } });
    await prisma.automationSettings.update({ where: { userId: u }, data: { enabled: false } });
    const off = await newApp(u, { approvalSource: "policy" });
    await expect(execute(u, off.appId)).resolves.toMatchObject({ outcome: "SKIPPED", detail: expect.stringContaining("automation is turned off") });
    expect((await appRow(off.appId)).status).toBe("WAITING_APPROVAL");

    // A user approval does not depend on the Auto policy.
    const user = await newApp(u, { approvalSource: "user", mode: "REVIEW" });
    await expect(execute(u, user.appId)).resolves.toMatchObject({ outcome: "APPLIED" });
    expect(calls).toHaveLength(1);
  });

  it("a policy approval made under older Auto rules is returned to the user, not submitted", async () => {
    const u = await newUser("rules-changed");
    useProvider("acme-api");
    const { appId } = await newApp(u, { approvalSource: "policy", rulesVersion: 1 });
    // e.g. the user excluded this company after the policy approved the application.
    await prisma.automationSettings.update({ where: { userId: u }, data: { rulesVersion: 2 } });
    await expect(execute(u, appId)).resolves.toMatchObject({ outcome: "SKIPPED", detail: expect.stringContaining("rules changed") });
    expect(await appRow(appId)).toMatchObject({ status: "WAITING_APPROVAL", approvalSource: null, approvedAt: null });
    expect(calls).toHaveLength(0);
    expect(await notifications(u, "application.approval_required")).toHaveLength(1);
  });

  it("defers policy submissions to the end of quiet hours", async () => {
    const now = new Date();
    const minutes = minutesNow();
    const u = await newUser("quiet", { quiet: [(minutes - 60 + 1440) % 1440, (minutes + 60) % 1440] });
    useProvider("acme-api");
    const { appId } = await newApp(u);
    const res = await execute(u, appId);
    expect(res.outcome).toBe("DEFERRED");
    const app = await appRow(appId);
    expect(app.status).toBe("APPROVED");
    expect(app.nextActionAt!.getTime()).toBeGreaterThan(now.getTime() + 55 * 60_000);
    expect(h.enqueue).toHaveBeenCalledTimes(1);
    const [name, body, opts] = h.enqueue.mock.calls[0] as unknown as Enqueued;
    expect(name).toBe("application.execute");
    // The task carries the approval it was scheduled under.
    expect(body).toMatchObject({ applicationId: appId, approvedAt: app.approvedAt!.toISOString() });
    expect(opts.userId).toBe(u);
    expect(opts.runAt!.getTime()).toBe(app.nextActionAt!.getTime());
    expect(opts.dedupeKey!.startsWith(`application.execute:${appId}`)).toBe(true);
    expect(calls).toHaveLength(0);
    expect(await countToday(u)).toBe(0);

    // Quiet hours hold back the automation, not the user's own approval.
    const mine = await newApp(u, { approvalSource: "user" });
    await expect(execute(u, mine.appId)).resolves.toMatchObject({ outcome: "APPLIED" });
  });
});

describe("execute: deferrals, daily limit and quiet hours", () => {
  it("a daily-limit deferral never lands inside quiet hours", async () => {
    // Quiet 23:00-07:00 UTC: the next local day starts inside it, so the deferral moves to 07:00.
    const u = await newUser("limit-quiet", { limit: 1, quiet: [23 * 60, 7 * 60] });
    useProvider("acme-api");
    const first = await newApp(u, { approvalSource: "user" });
    await expect(execute(u, first.appId)).resolves.toMatchObject({ outcome: "APPLIED" });
    const second = await newApp(u, { approvalSource: "user" });
    await expect(execute(u, second.appId)).resolves.toMatchObject({ outcome: "DEFERRED" });
    const at = (await appRow(second.appId)).nextActionAt!;
    expect([at.getUTCHours(), at.getUTCMinutes()]).toEqual([7, 0]);
    expect(at.getTime()).toBeGreaterThan(Date.now());
    expect(inQuietHours({ quietHoursStart: 23 * 60, quietHoursEnd: 7 * 60, timezone: "UTC" }, at)).toBe(false);
    const [task] = enqueued(second.appId);
    expect(task![2].runAt!.getTime()).toBe(at.getTime());
  });

  it("an automatic retry is never scheduled inside quiet hours", async () => {
    const m = minutesNow();
    // Quiet hours started this minute: the user's own approval still runs now, but the retry waits for the end.
    const u = await newUser("retry-quiet", { quiet: [m, (m + 60) % 1440] });
    useProvider("acme-api", { submit: async () => ({ outcome: "FAILED", retryable: true, error: "HTTP 503", submissionUncertain: false }) });
    const { appId } = await newApp(u, { approvalSource: "user" });
    await expect(execute(u, appId)).resolves.toMatchObject({ outcome: "FAILED" });
    const [task] = enqueued(appId);
    expect(task![2].runAt!.getTime()).toBeGreaterThan(Date.now() + 55 * 60_000);
    expect((await appRow(appId)).nextActionAt!.getTime()).toBe(task![2].runAt!.getTime());
  });

  it("a daily limit of 0 is reported once instead of deferring every day", async () => {
    const u = await newUser("limit-zero", { limit: 0 });
    useProvider("acme-api");
    const user = await newApp(u, { approvalSource: "user" });
    const res = await execute(u, user.appId);
    expect(res).toMatchObject({ outcome: "SKIPPED", detail: expect.stringContaining("daily application limit is 0") });
    expect(await appRow(user.appId)).toMatchObject({ status: "APPROVED", nextActionAt: null });
    expect(await prisma.applicationEvent.count({ where: { applicationId: user.appId, type: "execution_blocked" } })).toBe(1);
    expect(enqueued(user.appId)).toHaveLength(0);
    expect(await executions(user.appId)).toHaveLength(0);
    // A policy approval cannot be submitted under a limit of 0: back to the review queue.
    const policy = await newApp(u, { approvalSource: "policy" });
    await expect(execute(u, policy.appId)).resolves.toMatchObject({ outcome: "SKIPPED" });
    expect((await appRow(policy.appId)).status).toBe("WAITING_APPROVAL");
    expect(enqueued(policy.appId)).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });
});

describe("execute: manual handoff and outcomes", () => {
  it("hands an unsupported provider to the user with the reason", async () => {
    const u = await newUser("unsupported");
    const runId = await newRun(u);
    useProvider("restricted", { support: { supported: false, channel: "manual", reason: "PROVIDER_RESTRICTION", detail: "The platform does not allow automated applications." } });
    const { appId } = await newApp(u);
    await expect(execute(u, appId, { runId })).resolves.toMatchObject({ outcome: "MANUAL_ACTION_REQUIRED" });
    expect(await appRow(appId)).toMatchObject({
      status: "MANUAL_ACTION_REQUIRED",
      manualActionReason: "PROVIDER_RESTRICTION",
      manualActionDetail: "The platform does not allow automated applications.",
      executorKind: "MANUAL",
      executorId: "manual",
    });
    expect((await notifications(u, "application.manual_action_required")).map((n) => n.dedupeKey)).toEqual([expect.stringMatching(new RegExp(`^manual:${appId}:PROVIDER_RESTRICTION:`))]);
    expect((await prisma.automationRun.findUniqueOrThrow({ where: { id: runId } })).manualActions).toBe(1);
    expect(await executions(appId)).toHaveLength(0);
    expect(calls).toHaveLength(0);
    expect(await countToday(u)).toBe(0);
  });

  it("a later, different handoff of the same application is announced again", async () => {
    const u = await newUser("handoff-episodes");
    useProvider("acme-key", { auth: "api_key" });
    const { appId } = await newApp(u, { approvalSource: "user" });
    // Not connected yet: handed to the user.
    await expect(execute(u, appId)).resolves.toMatchObject({ outcome: "MANUAL_ACTION_REQUIRED" });
    expect(await notifications(u, "application.manual_action_required")).toHaveLength(1);
    // The user connects and retries; this time the page shows a CAPTCHA.
    useProvider("acme-key", { auth: "api_key", submit: async () => ({ outcome: "MANUAL_ACTION_REQUIRED", reason: "CAPTCHA", detail: "The page shows a CAPTCHA." }) });
    await providerConnectionsService.connect(u, "acme-key", { token: "acme-secret-token-episodes" });
    await expect(execute(u, appId, { retry: true })).resolves.toMatchObject({ outcome: "MANUAL_ACTION_REQUIRED" });
    expect(await appRow(appId)).toMatchObject({ status: "MANUAL_ACTION_REQUIRED", manualActionReason: "CAPTCHA" });
    const keys = (await notifications(u, "application.manual_action_required")).map((n) => n.dedupeKey);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
  });

  it("asks for missing information, keeps the form's questions for the next preparation and gives the daily slot back", async () => {
    const u = await newUser("needs-info");
    const runId = await newRun(u);
    useProvider("acme-api", { submit: async () => ({ outcome: "NEEDS_INFORMATION", questions: [{ question: "Do you hold a valid work permit for Singapore?", required: true }] }) });
    const { appId } = await newApp(u);
    await prisma.application.update({ where: { id: appId }, data: { runtimeQuestions: [{ question: "Earlier form question?", required: false, inputType: "text", options: null, providerKey: null }] } });
    await expect(execute(u, appId, { runId })).resolves.toMatchObject({ outcome: "NEEDS_INFORMATION" });
    const app = await appRow(appId);
    expect(app.status).toBe("NEEDS_INFORMATION");
    expect(app.pendingQuestions).toEqual([
      { key: "custom:do-you-hold-a-valid-work-permit-for-singapore", canonicalKey: "custom", question: "Do you hold a valid work permit for Singapore?", required: true, options: null, sensitive: false },
    ]);
    const runtime: ProviderQuestion[] = [
      { question: "Earlier form question?", required: false, inputType: "text", options: null, providerKey: null },
      { question: "Do you hold a valid work permit for Singapore?", required: true, inputType: "text", options: null, providerKey: null },
    ];
    expect(app.runtimeQuestions).toEqual(runtime);
    expect((await executions(appId))[0]).toMatchObject({ status: "NEEDS_INFORMATION", leaseUntil: null, slotDay: null });
    expect(await countToday(u)).toBe(0);
    expect(await notifications(u, "application.information_required")).toHaveLength(1);
    expect((await prisma.automationRun.findUniqueOrThrow({ where: { id: runId } })).needsInformation).toBe(1);

    // Found again on a later attempt: merged, not duplicated.
    await prisma.application.update({ where: { id: appId }, data: { status: "APPROVED" } });
    await expect(execute(u, appId)).resolves.toMatchObject({ outcome: "NEEDS_INFORMATION" });
    expect((await appRow(appId)).runtimeQuestions).toEqual(runtime);
  });

  it("an auth failure marks the connection NEEDS_ATTENTION once and is never retried", async () => {
    const u = await newUser("auth");
    useProvider("acme-key", { auth: "api_key", submit: async () => ({ outcome: "AUTH_FAILED", detail: "401 from the provider" }) });
    await providerConnectionsService.connect(u, "acme-key", { token: "acme-secret-token-123456" });
    const { appId } = await newApp(u);
    await expect(execute(u, appId)).resolves.toMatchObject({ outcome: "MANUAL_ACTION_REQUIRED" });
    // The decrypted credential reached the provider for this call only.
    expect(calls[0]!.credential).toEqual({ token: "acme-secret-token-123456" });
    const conn = await prisma.providerConnection.findUniqueOrThrow({ where: { userId_provider: { userId: u, provider: "acme-key" } } });
    expect(conn).toMatchObject({ status: "NEEDS_ATTENTION", consecutiveFailures: 1 });
    expect(await appRow(appId)).toMatchObject({ status: "MANUAL_ACTION_REQUIRED", manualActionReason: "LOGIN_REQUIRED" });
    expect(await countToday(u)).toBe(0);
    expect(h.enqueue).not.toHaveBeenCalled();

    // A retry does not reach the provider while the connection needs attention; still one notification.
    await expect(execute(u, appId, { retry: true })).resolves.toMatchObject({ outcome: "MANUAL_ACTION_REQUIRED" });
    expect(calls).toHaveLength(1);
    expect(await notifications(u, "provider.needs_attention")).toHaveLength(1);
  });

  it("holds approved applications while a provider credential is broken and resumes them on reconnect", async () => {
    const u = await newUser("paused");
    useProvider("acme-key", { auth: "api_key" });
    await providerConnectionsService.connect(u, "acme-key", { token: "acme-secret-token-paused" });
    await providerConnectionsService.markAuthFailed(u, "acme-key", "401 Unauthorized");
    const { appId } = await newApp(u, { approvalSource: "policy" });
    await prisma.application.update({ where: { id: appId }, data: { nextActionAt: new Date(Date.now() - 1_000) } });

    const res = await execute(u, appId);
    expect(res).toMatchObject({ outcome: "DEFERRED", detail: expect.stringContaining("Paused until you reconnect") });
    // Held, not handed off; out of the deferred sweep; no per-application notification (the provider notice covers it).
    expect(await appRow(appId)).toMatchObject({ status: "APPROVED", nextActionAt: null, manualActionReason: "LOGIN_REQUIRED" });
    expect(await notifications(u, "application.manual_action_required")).toHaveLength(0);
    expect(await executions(appId)).toHaveLength(0);
    expect(calls).toHaveLength(0);
    // Idempotent: a second pass adds no timeline entry.
    await expect(execute(u, appId)).resolves.toMatchObject({ outcome: "DEFERRED" });
    expect(await prisma.applicationEvent.count({ where: { applicationId: appId, type: "execution_blocked" } })).toBe(1);
    await expect(applicationExecutionService.describeExecutor(u, appId)).resolves.toMatchObject({ automatic: false, reason: "LOGIN_REQUIRED", paused: true });

    // An expired token found at execution time holds the application as well (nothing is claimed or moved).
    const v = await newUser("paused-expired");
    await providerConnectionsService.connect(v, "acme-key", { token: "acme-secret-token-expired", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    await prisma.providerConnection.update({ where: { userId_provider: { userId: v, provider: "acme-key" } }, data: { expiresAt: new Date(Date.now() - 1_000) } });
    const expired = await newApp(v);
    await expect(execute(v, expired.appId)).resolves.toMatchObject({ outcome: "DEFERRED" });
    expect(await appRow(expired.appId)).toMatchObject({ status: "APPROVED", manualActionReason: "LOGIN_REQUIRED" });
    expect(await executions(expired.appId)).toHaveLength(0);
    expect(await countToday(v)).toBe(0);

    // Reconnecting re-queues it under the same approval; the task submits.
    h.enqueue.mockClear();
    await providerConnectionsService.connect(u, "acme-key", { token: "acme-secret-token-fresh" });
    const [task] = enqueued(appId);
    expect(task).toBeDefined();
    expect(task![1]).toMatchObject({ applicationId: appId, retry: false, approvedAt: (await appRow(appId)).approvedAt!.toISOString() });
    expect(task![2].dedupeKey).toContain(":reconnect:");
    expect(await appRow(appId)).toMatchObject({ status: "APPROVED", manualActionReason: null });
    await expect(replay(u, task!)).resolves.toMatchObject({ outcome: "APPLIED" });
    expect(calls[0]!.credential).toEqual({ token: "acme-secret-token-fresh" });
  });

  it("retries a transient failure with backoff, then applies", async () => {
    const u = await newUser("transient");
    let n = 0;
    useProvider("acme-api", {
      submit: async () => (++n === 1 ? { outcome: "FAILED", retryable: true, error: "HTTP 503", submissionUncertain: false } : { outcome: "SUBMITTED", externalApplicationId: "EXT-2", confirmation: null }),
    });
    const { appId } = await newApp(u);
    const before = Date.now();
    await expect(execute(u, appId)).resolves.toMatchObject({ outcome: "FAILED" });
    expect(await appRow(appId)).toMatchObject({ status: "FAILED", failureReason: "HTTP 503" });
    expect(await countToday(u)).toBe(0);
    expect(h.enqueue).toHaveBeenCalledTimes(1);
    const task = h.enqueue.mock.calls[0] as unknown as Enqueued;
    expect(task[1]).toMatchObject({ applicationId: appId, retry: true, approvedAt: expect.any(String) });
    expect(task[2].runAt!.getTime()).toBeGreaterThanOrEqual(before + 30_000);
    expect(task[2].dedupeKey!.startsWith(`application.execute:${appId}`)).toBe(true);
    expect(await notifications(u, "application.failed")).toHaveLength(0);

    // The queued retry runs.
    await expect(replay(u, task)).resolves.toMatchObject({ outcome: "APPLIED" });
    expect(calls).toHaveLength(2);
    expect((await executions(appId))[0]).toMatchObject({ status: "SUCCEEDED", attempts: 2 });
    expect(await countToday(u)).toBe(1);
  });

  it("gives up after the last attempt and notifies the failure", async () => {
    const u = await newUser("permanent");
    useProvider("acme-api", { submit: async () => ({ outcome: "FAILED", retryable: false, error: "The posting closed", submissionUncertain: false }) });
    const { appId } = await newApp(u);
    await expect(execute(u, appId)).resolves.toMatchObject({ outcome: "FAILED", detail: "The posting closed" });
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(await notifications(u, "application.failed")).toHaveLength(1);
  });

  it("an uncertain failure of a non-idempotent executor asks the user to check (slot kept, no retry)", async () => {
    const u = await newUser("uncertain");
    useProvider("acme-api", { submit: async () => ({ outcome: "FAILED", retryable: true, error: "Timed out after sending.", submissionUncertain: true }) });
    const { appId } = await newApp(u);
    await expect(execute(u, appId)).resolves.toMatchObject({ outcome: "MANUAL_ACTION_REQUIRED" });
    expect(await appRow(appId)).toMatchObject({ status: "MANUAL_ACTION_REQUIRED", manualActionReason: "SUBMISSION_UNCERTAIN" });
    expect((await executions(appId))[0]).toMatchObject({ status: "FAILED", manualActionReason: "SUBMISSION_UNCERTAIN" });
    expect(await countToday(u)).toBe(1);
    expect(h.enqueue).not.toHaveBeenCalled();

    // The same failure from an idempotent provider (the demo provider deduplicates) is simply retried.
    const v = await newUser("uncertain-idem");
    useProvider("demo", { submit: async () => ({ outcome: "FAILED", retryable: true, error: "Timed out after sending.", submissionUncertain: true }) });
    const other = await newApp(v);
    await expect(execute(v, other.appId)).resolves.toMatchObject({ outcome: "FAILED" });
    expect((await appRow(other.appId)).status).toBe("FAILED");
    expect(h.enqueue).toHaveBeenCalledTimes(1);
    expect(await countToday(v)).toBe(0);
  });

  it("an uncertain submission is never resent by a leftover automatic task, only after the user's explicit retry", async () => {
    const u = await newUser("uncertain-lock");
    useProvider("acme-api", { submit: async () => ({ outcome: "FAILED", retryable: true, error: "Timed out after sending.", submissionUncertain: true }) });
    const { appId } = await newApp(u, { approvalSource: "user" });
    await expect(execute(u, appId)).resolves.toMatchObject({ outcome: "MANUAL_ACTION_REQUIRED" });
    useProvider("acme-api");
    calls.length = 0;
    // A retry task queued earlier (retry:/limit:/recover:) for the same application runs now.
    await expect(execute(u, appId, { retry: true })).resolves.toMatchObject({ outcome: "SKIPPED" });
    expect(calls).toHaveLength(0);
    expect(await appRow(appId)).toMatchObject({ status: "MANUAL_ACTION_REQUIRED", manualActionReason: "SUBMISSION_UNCERTAIN" });
    // The user checked and explicitly retries: the lock of this application is lifted.
    await expect(applicationExecutionService.acknowledgeUncertainSubmission(u, appId)).resolves.toEqual({ released: 1 });
    await expect(execute(u, appId, { retry: true })).resolves.toMatchObject({ outcome: "APPLIED" });
    expect(calls).toHaveLength(1);
  });

  it("sends an email application through the email executor when every condition holds", async () => {
    const u = await newUser("email", { emailConsent: true, allowEmail: true });
    useProvider("email_application", { support: { supported: true, channel: "email", reason: null, detail: "" } });
    const { appId } = await newApp(u, { hrEmail: "hr@acme.test", description: "Build our React product. To apply, send your resume to hr@acme.test." });
    await prisma.applicationEmailDraft.create({
      data: { userId: u, applicationId: appId, to: "hr@acme.test", subject: "Application: Frontend Engineer", body: "Dear hiring team, please find my resume attached.", originalBody: "x", provider: "fallback", promptVersion: "v1" },
    });
    await expect(execute(u, appId)).resolves.toMatchObject({ outcome: "APPLIED" });
    expect(await appRow(appId)).toMatchObject({ status: "APPLIED", executorId: "api:email" });
    const draft = await prisma.applicationEmailDraft.findUniqueOrThrow({ where: { applicationId: appId } });
    expect(draft.status).toBe("SENT");
    expect(draft.sendMessageId).toMatch(/^dev-/);
    expect(calls).toHaveLength(0);

    // Without the email-sending consent it is a manual handoff that says why.
    const v = await newUser("email-no-consent", { emailConsent: false, allowEmail: true });
    const other = await newApp(v, { hrEmail: "hr@acme.test", description: "Send your resume to hr@acme.test." });
    const res = await execute(v, other.appId);
    expect(res.outcome).toBe("MANUAL_ACTION_REQUIRED");
    expect(res.detail).toContain("email-sending consent");
  });

  it("never emails an address the posting does not ask applications to be sent to", async () => {
    const u = await newUser("email-not-requested", { emailConsent: true, allowEmail: true });
    useProvider("email_application", { support: { supported: true, channel: "email", reason: null, detail: "" } });
    // job.hrEmail was picked up from a fraud-report line, not from an application request.
    const { appId } = await newApp(u, { hrEmail: "hr@acme.test", description: "Build our React product. Report recruitment fraud to hr@acme.test." });
    await prisma.applicationEmailDraft.create({
      data: { userId: u, applicationId: appId, to: "hr@acme.test", subject: "Application: Frontend Engineer", body: "Dear hiring team, please find my resume attached.", originalBody: "x", provider: "fallback", promptVersion: "v1" },
    });
    const res = await execute(u, appId);
    expect(res).toMatchObject({ outcome: "MANUAL_ACTION_REQUIRED", detail: expect.stringContaining("does not clearly ask for email applications") });
    expect((await prisma.applicationEmailDraft.findUniqueOrThrow({ where: { applicationId: appId } })).status).not.toBe("SENT");
    expect(await appRow(appId)).toMatchObject({ status: "MANUAL_ACTION_REQUIRED", emailSentAt: null, appliedAt: null });
    expect(await countToday(u)).toBe(0);
  });
});

describe("execute: idempotency and concurrency", () => {
  it("5 parallel executions of one application submit exactly once", async () => {
    const u = await newUser("parallel");
    useProvider("acme-api", {
      submit: async () => {
        await new Promise((r) => setTimeout(r, 150));
        return { outcome: "SUBMITTED", externalApplicationId: "EXT-P", confirmation: null };
      },
    });
    const { appId } = await newApp(u);
    const results = await Promise.all(Array.from({ length: 5 }, () => execute(u, appId)));
    expect(results.filter((r) => r.outcome === "APPLIED")).toHaveLength(1);
    expect(results.filter((r) => r.outcome === "SKIPPED")).toHaveLength(4);
    expect(calls).toHaveLength(1);
    expect(await executions(appId)).toHaveLength(1);
    expect((await appRow(appId)).status).toBe("APPLIED");
    expect(await countToday(u)).toBe(1);
  });

  it("two Job rows sharing a matchKey are submitted once; the duplicate is withdrawn", async () => {
    const u = await newUser("duplicate");
    useProvider("acme-api");
    const shared = `exec-shared-${uid()}`;
    const first = await newApp(u, { matchKey: shared });
    const second = await newApp(u, { matchKey: shared });
    await expect(execute(u, first.appId)).resolves.toMatchObject({ outcome: "APPLIED" });
    await expect(execute(u, second.appId)).resolves.toMatchObject({ outcome: "SKIPPED", detail: "Already applied via another listing." });
    expect((await appRow(second.appId)).status).toBe("WITHDRAWN");
    expect(await prisma.applicationEvent.count({ where: { applicationId: second.appId, type: "duplicate_skipped" } })).toBe(1);
    expect(calls).toHaveLength(1);

    // In parallel as well.
    const shared2 = `exec-shared-${uid()}`;
    const a = await newApp(u, { matchKey: shared2 });
    const b = await newApp(u, { matchKey: shared2 });
    useProvider("acme-api", {
      submit: async () => {
        await new Promise((r) => setTimeout(r, 100));
        return { outcome: "SUBMITTED", externalApplicationId: null, confirmation: null };
      },
    });
    calls.length = 0;
    const results = await Promise.all([execute(u, a.appId), execute(u, b.appId)]);
    expect(results.filter((r) => r.outcome === "APPLIED")).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it("an application blocked by another listing's live attempt tries again later instead of staying stuck", async () => {
    const u = await newUser("claim-conflict");
    useProvider("acme-api");
    const shared = `exec-conflict-${uid()}`;
    const holder = await newApp(u, { matchKey: shared });
    const waiting = await newApp(u, { matchKey: shared, approvalSource: "user" });
    // Another worker is submitting the other listing right now.
    await prisma.applicationExecution.create({
      data: { userId: u, applicationId: holder.appId, idempotencyKey: `${u}:${shared}`, executorKind: "API", executorId: "api:acme-api", status: "RUNNING", attempts: 1, leaseUntil: new Date(Date.now() + 5 * 60_000), startedAt: new Date() },
    });
    const before = Date.now();
    await expect(execute(u, waiting.appId)).resolves.toMatchObject({ outcome: "DEFERRED" });
    expect(calls).toHaveLength(0);
    const row = await appRow(waiting.appId);
    expect(row.status).toBe("APPROVED");
    expect(row.nextActionAt!.getTime()).toBeGreaterThanOrEqual(before + EXECUTION_LEASE_MS - 1_000);
    const [task] = enqueued(waiting.appId);
    expect(task![1]).toMatchObject({ approvedAt: row.approvedAt!.toISOString() });
    expect(task![2].dedupeKey).toContain(":claim:");
  });

  it("a daily limit of 30 with 35 approved applications (5-way parallel) submits exactly 30", async () => {
    const u = await newUser("limit", { limit: 30 });
    useProvider("acme-api");
    const apps: string[] = [];
    for (let i = 0; i < 35; i++) apps.push((await newApp(u)).appId);
    const outcomes: string[] = [];
    let next = 0;
    await Promise.all(
      Array.from({ length: 5 }, async () => {
        while (next < apps.length) {
          const id = apps[next++]!;
          outcomes.push((await execute(u, id)).outcome);
        }
      }),
    );
    expect(outcomes.filter((o) => o === "APPLIED")).toHaveLength(30);
    expect(outcomes.filter((o) => o === "DEFERRED")).toHaveLength(5);
    expect(calls).toHaveLength(30);
    expect(await countToday(u)).toBe(30);
    const deferred = await prisma.application.findMany({ where: { id: { in: apps }, status: "APPROVED" } });
    expect(deferred).toHaveLength(5);
    for (const d of deferred) expect(d.nextActionAt).toBeInstanceOf(Date);
    const pending = await prisma.applicationExecution.findMany({ where: { applicationId: { in: deferred.map((d) => d.id) } } });
    expect(pending.every((e) => e.status === "PENDING" && e.attempts === 0 && e.leaseUntil === null && e.slotDay === null)).toBe(true);
    expect(h.enqueue).toHaveBeenCalledTimes(5);
  }, 180_000);

  it("a worker whose attempt was recovered meanwhile changes nothing (no double slot release)", async () => {
    const u = await newUser("stale-worker");
    // Another submission already holds a slot today.
    await dailyLimitService.reserve(u, 10, "UTC");
    const { appId } = await newApp(u);
    useProvider("acme-api", {
      submit: async () => {
        // Meanwhile crash recovery took this attempt over and gave its slot back.
        const [ex] = await executions(appId);
        await prisma.applicationExecution.update({ where: { id: ex!.id }, data: { status: "PENDING", leaseUntil: null, slotDay: null } });
        await dailyLimitService.release(u, ex!.slotDay!);
        return { outcome: "MANUAL_ACTION_REQUIRED", reason: "CAPTCHA", detail: "CAPTCHA" };
      },
    });
    await expect(execute(u, appId)).resolves.toMatchObject({ outcome: "SKIPPED" });
    expect(await countToday(u)).toBe(1);
    expect((await executions(appId))[0]).toMatchObject({ status: "PENDING" });
    expect(await notifications(u, "application.manual_action_required")).toHaveLength(0);
  });
});

describe("outcome writes are atomic", () => {
  it("a crash between finishing the execution and moving the application leaves nothing stuck in APPLYING", async () => {
    const u = await newUser("atomic");
    useProvider("acme-api");
    const { appId } = await newApp(u);
    h.failTransition = "execute_succeeded";
    await expect(execute(u, appId)).rejects.toThrow("Connection reset");
    // Both writes rolled back together: the execution is still RUNNING (with its lease), so recovery owns it.
    expect((await executions(appId))[0]).toMatchObject({ status: "RUNNING" });
    expect((await appRow(appId)).status).toBe("APPLYING");
    await prisma.applicationExecution.updateMany({ where: { applicationId: appId }, data: { leaseUntil: new Date(Date.now() - 60_000) } });
    await applicationExecutionService.recoverStale(new Date());
    // A non-idempotent provider may have received it: the user checks - never a blind resubmission.
    expect(await appRow(appId)).toMatchObject({ status: "MANUAL_ACTION_REQUIRED", manualActionReason: "SUBMISSION_UNCERTAIN" });
    expect(calls).toHaveLength(1);
  });
});

describe("recoverStale", () => {
  async function staleExecution(userId: string, appId: string, executorId: string, kind: "API" | "BROWSER", idempotencyKey = `${userId}:stale-${uid()}`) {
    const slotDay = await dailyLimitService.reserve(userId, 10, "UTC");
    return prisma.applicationExecution.create({
      data: {
        userId,
        applicationId: appId,
        idempotencyKey,
        executorKind: kind,
        executorId,
        status: "RUNNING",
        attempts: 1,
        leaseUntil: new Date(Date.now() - 60_000),
        slotDay,
        startedAt: new Date(Date.now() - 11 * 60_000),
      },
    });
  }

  const ageApp = (appId: string) => prisma.$executeRaw`UPDATE "Application" SET "updatedAt" = NOW() - INTERVAL '20 minutes' WHERE "id" = ${appId}`;

  it("retries an interrupted idempotent submission", async () => {
    const u = await newUser("recover-idem");
    const { appId } = await newApp(u, { status: "APPLYING" });
    const ex = await staleExecution(u, appId, "api:demo", "API");
    const { recovered } = await applicationExecutionService.recoverStale(new Date());
    expect(recovered).toBeGreaterThanOrEqual(1);
    expect(await prisma.applicationExecution.findUniqueOrThrow({ where: { id: ex.id } })).toMatchObject({ status: "FAILED", leaseUntil: null, slotDay: null });
    expect((await appRow(appId)).status).toBe("FAILED");
    expect(await countToday(u)).toBe(0);
    const [call] = enqueued(appId);
    expect(call?.[1]).toMatchObject({ retry: true });
  });

  it("never resubmits an interrupted non-idempotent submission: the user checks (slot kept)", async () => {
    const u = await newUser("recover-browser");
    const { appId, matchKey } = await newApp(u, { status: "APPLYING" });
    const ex = await staleExecution(u, appId, "browser:demo-ats", "BROWSER", `${u}:${matchKey}`);
    await applicationExecutionService.recoverStale(new Date());
    expect(await prisma.applicationExecution.findUniqueOrThrow({ where: { id: ex.id } })).toMatchObject({ status: "MANUAL_ACTION_REQUIRED", manualActionReason: "SUBMISSION_UNCERTAIN", leaseUntil: null });
    expect(await appRow(appId)).toMatchObject({ status: "MANUAL_ACTION_REQUIRED", manualActionReason: "SUBMISSION_UNCERTAIN" });
    expect(await countToday(u)).toBe(1);
    expect(enqueued(appId)).toHaveLength(0);
    expect(await notifications(u, "application.manual_action_required")).toHaveLength(1);

    // Another listing of the same job is not submitted automatically while that one is unresolved: it is handed to
    // the user with the reason instead of waiting in APPROVED forever.
    useProvider("acme-api");
    const twin = await newApp(u, { matchKey });
    await expect(execute(u, twin.appId)).resolves.toMatchObject({ outcome: "MANUAL_ACTION_REQUIRED", detail: expect.stringContaining("Another listing of this job") });
    expect(calls).toHaveLength(0);
    expect(await appRow(twin.appId)).toMatchObject({ status: "MANUAL_ACTION_REQUIRED", manualActionReason: "SUBMISSION_UNCERTAIN" });
    expect(await countToday(u)).toBe(1);
    // The other listing's lock is not lifted by acknowledging this one.
    await expect(applicationExecutionService.acknowledgeUncertainSubmission(u, twin.appId)).resolves.toEqual({ released: 0 });
  });

  it("an attempt that never reached APPLYING is simply re-queued", async () => {
    const u = await newUser("recover-unstarted");
    const { appId } = await newApp(u, { status: "APPROVED" });
    const ex = await staleExecution(u, appId, "browser:demo-ats", "BROWSER");
    await applicationExecutionService.recoverStale(new Date());
    expect(await prisma.applicationExecution.findUniqueOrThrow({ where: { id: ex.id } })).toMatchObject({ status: "PENDING", leaseUntil: null });
    expect((await appRow(appId)).status).toBe("APPROVED");
    expect(await countToday(u)).toBe(0);
    expect(enqueued(appId)).toHaveLength(1);
  });

  it("reconciles applications left in APPLYING after their execution finished", async () => {
    const u = await newUser("orphans");
    // Submitted, but the application never left APPLYING.
    const done = await newApp(u, { status: "APPLYING" });
    await prisma.applicationExecution.create({
      data: { userId: u, applicationId: done.appId, idempotencyKey: `${u}:orphan-${uid()}`, executorKind: "API", executorId: "api:acme-api", status: "SUCCEEDED", attempts: 1, submittedAt: new Date(), externalApplicationId: "EXT-O", finishedAt: new Date() },
    });
    // A browser attempt that may have been sent.
    const maybe = await newApp(u, { status: "APPLYING" });
    await prisma.applicationExecution.create({
      data: { userId: u, applicationId: maybe.appId, idempotencyKey: `${u}:orphan-${uid()}`, executorKind: "BROWSER", executorId: "browser:demo-ats", status: "FAILED", manualActionReason: "SUBMISSION_UNCERTAIN", attempts: 1, finishedAt: new Date() },
    });
    // Failed before sending anything.
    const failed = await newApp(u, { status: "APPLYING" });
    await prisma.applicationExecution.create({
      data: { userId: u, applicationId: failed.appId, idempotencyKey: `${u}:orphan-${uid()}`, executorKind: "API", executorId: "api:acme-api", status: "FAILED", lastError: "HTTP 503", attempts: 1, finishedAt: new Date() },
    });
    // Recent: a live worker may still be between its two writes - left alone.
    const recent = await newApp(u, { status: "APPLYING" });
    for (const id of [done.appId, maybe.appId, failed.appId]) await ageApp(id);

    await applicationExecutionService.recoverStale(new Date());
    expect(await appRow(done.appId)).toMatchObject({ status: "APPLIED", externalApplicationId: "EXT-O" });
    expect(await appRow(maybe.appId)).toMatchObject({ status: "MANUAL_ACTION_REQUIRED", manualActionReason: "SUBMISSION_UNCERTAIN" });
    expect(await appRow(failed.appId)).toMatchObject({ status: "FAILED", failureReason: "HTTP 503" });
    expect((await appRow(recent.appId)).status).toBe("APPLYING");
  });
});
