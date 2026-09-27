import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, type ApplicationMode, type ApplicationStatus, type Prisma } from "@applywise/database";
import type * as Ai from "@applywise/ai";
import { DEFAULT_SECTION_ORDER, resumeContentHash, type ResumeDocument } from "@applywise/resume-engine";
import type { TailoredResumePlan } from "@applywise/types";
import { logger } from "@/server/logger";
import { applicationExecutionService } from "@/server/services/application-execution.service";
import { applicationService, nextActionFor } from "@/server/services/application.service";
import { provideInformation, resolveQuestions, routeAfterPreparation } from "@/server/services/application-routing.service";
import { automationSettingsService } from "@/server/services/automation-settings.service";
import { candidateAnswersService } from "@/server/services/candidate-answers.service";
import { aiConfigFor, buildGenerationContext } from "@/server/services/context.service";
import { resumeSelectionService } from "@/server/services/resume-selection.service";
import { bareUser, disableTrackedUsers, enableAutomation, markEvaluated, uid } from "./automation-helpers";

/**
 * Safety of the preparation -> approval -> submission path (application.service / application-routing.service):
 * generated answers never answer required questions and never pass the AUTO policy unreviewed, a retry never sends
 * unapproved content, approvals in Review/Auto mode queue the submission, edits are fenced against executors, the
 * user's cover-letter / tailoring settings are honoured, and preparations are attributed and notified per episode.
 *
 * The queue is captured (nothing runs in the background) and the screening-answer generator is replaced by a
 * deterministic one that always "confirms" its draft, so these tests exercise the routing rules, not the generator.
 */

const h = vi.hoisted(() => ({
  enqueue: vi.fn(async (..._args: unknown[]) => ({ taskId: "test-task" })),
}));

vi.mock("@/server/queue", () => ({ enqueue: (...args: unknown[]) => h.enqueue(...args) }));

vi.mock("@applywise/ai", async (importOriginal) => {
  const actual = await importOriginal<typeof Ai>();
  return {
    ...actual,
    generateScreeningAnswer: async (question: string) => ({
      data: { answer: `Generated draft for: ${question}`, canConfirm: true, claims: [] },
      meta: { workflow: "screening-answer", provider: "fallback", modelId: null, promptVersion: "test", attempts: 1, durationMs: 0 },
    }),
  };
});

const SLOW = 60_000;

const PLAN: TailoredResumePlan = {
  summary: { text: "Frontend engineer who builds accessible product interfaces.", sourceFactIds: [] },
  bulletChanges: [],
  selectedSkills: [],
  sectionOrder: [],
  orderingNotes: [],
  warnings: [],
};

function resumeDoc(bullet: string): ResumeDocument {
  return {
    contact: { fullName: "Asha Rao", email: "asha.rao@example.test", phone: null, location: "Bengaluru", links: [] },
    headline: "Frontend Engineer",
    summary: "Frontend engineer.",
    experience: [{ title: "Frontend Engineer", company: "Clipverse Media", location: null, startDate: "2021", endDate: null, bullets: [bullet] }],
    projects: [],
    skills: ["React"],
    education: [],
    achievements: [],
    sectionOrder: DEFAULT_SECTION_ORDER,
  };
}

interface AppOptions {
  status?: ApplicationStatus;
  mode?: ApplicationMode | null;
  origin?: "USER" | "AUTOMATION";
  decision?: "AUTO_ELIGIBLE" | "REVIEW" | null;
  rulesVersion?: number | null;
  preparedAt?: Date | null;
  approvedAt?: Date | null;
  approvalSource?: string | null;
  nextActionAt?: Date | null;
  manualActionReason?: "SUBMISSION_UNCERTAIN" | "LOGIN_REQUIRED" | null;
  automationRunId?: string | null;
  runtimeQuestions?: Prisma.InputJsonValue;
  pendingQuestions?: Prisma.InputJsonValue;
  locations?: string[];
  screeningQuestions?: string[];
  /** Create the prepared drafts (tailored resume + cover letter). */
  drafts?: boolean;
}

async function makeApp(userId: string, o: AppOptions = {}): Promise<{ appId: string; jobId: string }> {
  const key = uid();
  const job = await prisma.job.create({
    data: {
      ownerUserId: userId,
      platform: "COMPANY_CAREER_PAGE",
      title: "Frontend Engineer",
      company: `Safety Co ${key}`,
      description: "Build our React product.",
      importMethod: "MANUAL_ENTRY",
      dedupeKey: `safety-${key}`,
      matchKey: `safety-mk-${key}`,
      applyUrl: `https://careers.safety.example/jobs/${key}`,
      applyMethod: "CAREER_PAGE",
      locations: o.locations ?? [],
      screeningQuestions: o.screeningQuestions ?? [],
    },
  });
  const app = await prisma.application.create({
    data: {
      userId,
      jobId: job.id,
      applyMethod: "CAREER_PAGE",
      status: o.status ?? "WAITING_APPROVAL",
      origin: o.origin ?? "AUTOMATION",
      mode: o.mode === undefined ? "REVIEW" : o.mode,
      canonicalJobKey: job.matchKey,
      automationDecision: o.decision ?? null,
      rulesVersion: o.rulesVersion ?? null,
      preparedAt: o.preparedAt === undefined ? new Date(Date.now() - 60_000) : o.preparedAt,
      approvedAt: o.approvedAt ?? null,
      approvalSource: o.approvalSource ?? null,
      nextActionAt: o.nextActionAt ?? null,
      manualActionReason: o.manualActionReason ?? null,
      automationRunId: o.automationRunId ?? null,
      ...(o.runtimeQuestions !== undefined ? { runtimeQuestions: o.runtimeQuestions } : {}),
      ...(o.pendingQuestions !== undefined ? { pendingQuestions: o.pendingQuestions } : {}),
    },
  });
  await markEvaluated(userId, app.id, job.id);
  if (o.drafts ?? true) {
    await prisma.tailoredResume.create({ data: { userId, applicationId: app.id, jobId: job.id, plan: PLAN as unknown as Prisma.InputJsonValue, provider: "fallback", promptVersion: "test" } });
    await prisma.coverLetter.create({ data: { userId, applicationId: app.id, body: "Approved cover letter.", originalBody: "Approved cover letter.", provider: "fallback", promptVersion: "test" } });
  }
  return { appId: app.id, jobId: job.id };
}

const appRow = (id: string) => prisma.application.findUniqueOrThrow({ where: { id } });
const executeCalls = () => h.enqueue.mock.calls.filter((c) => c[0] === "application.execute") as [string, Record<string, unknown>, { dedupeKey?: string }][];
const prepareOpts = async (u: string) => ({ logger, config: await aiConfigFor(u) });
const automaticExecutor = () =>
  vi.spyOn(applicationExecutionService, "describeExecutor").mockResolvedValue({ kind: "API", id: "api:demo", label: "Demo ATS", automatic: true, reason: null, detail: "Submitted automatically via Demo ATS." });

beforeEach(() => {
  h.enqueue.mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
});
afterAll(disableTrackedUsers);

// ---------------------------------------------------------------- generated answers (#0)

describe("generated answers", () => {
  it("never answer a required question: it stays pending; an optional one is marked as generated", async () => {
    const u = await bareUser("gen-required", { profile: true });
    const { appId, jobId } = await makeApp(u, { status: "PREPARING", screeningQuestions: ["Describe a product you are proud of *", "Tell us about a side project you enjoyed"] });
    const { drafts, pending } = await resolveQuestions(u, jobId, await buildGenerationContext(u, jobId), await prepareOpts(u), appId);

    const required = drafts.find((d) => d.question.startsWith("Describe a product"))!;
    // The draft is kept as a suggestion for the user, but it is not an answer: never sent, the question stays pending.
    expect(required).toMatchObject({ required: true, answerSource: "GENERATED", resolved: false });
    expect(required.answer).toMatch(/^Generated draft/);
    expect(pending.map((p) => p.key)).toContain(required.questionKey);

    const optional = drafts.find((d) => d.question.startsWith("Tell us about a side project"))!;
    expect(optional).toMatchObject({ required: false, answerSource: "GENERATED", resolved: true });
    expect(pending.map((p) => p.key)).not.toContain(optional.questionKey);
  });

  it("keep the AUTO policy from approving while a generated answer would be sent", async () => {
    const u = await bareUser("gen-policy", { profile: true });
    await enableAutomation(u, "AUTO", {}, "none");
    const { settings } = await automationSettingsService.ensure(u);
    const base = { status: "PREPARING" as const, mode: "AUTO" as const, decision: "AUTO_ELIGIBLE" as const, rulesVersion: settings.rulesVersion };
    automaticExecutor();

    // Control: every condition holds -> approved by the policy and queued.
    const clean = await makeApp(u, base);
    await expect(routeAfterPreparation(u, clean.appId, { pending: [], truthOk: true, warnings: [], runId: null })).resolves.toBe("APPROVED");
    expect(executeCalls().map((c) => c[1].applicationId)).toEqual([clean.appId]);

    // The same application with one generated (optional) answer that would be sent waits for the user.
    const generated = await makeApp(u, base);
    await prisma.screeningAnswerDraft.create({
      data: { userId: u, applicationId: generated.appId, question: "Tell us about a side project", answer: "Generated draft.", originalAnswer: "Generated draft.", canConfirm: true, provider: "fallback", promptVersion: "test", answerSource: "GENERATED", resolved: true },
    });
    await expect(routeAfterPreparation(u, generated.appId, { pending: [], truthOk: true, warnings: [], runId: null })).resolves.toBe("WAITING_APPROVAL");
    expect(await appRow(generated.appId)).toMatchObject({ status: "WAITING_APPROVAL", approvedAt: null, approvalSource: null });
    const event = await prisma.applicationEvent.findFirstOrThrow({ where: { applicationId: generated.appId, toStatus: "WAITING_APPROVAL" } });
    expect(event.message).toMatch(/drafted by the answer generator/);
    expect(executeCalls().map((c) => c[1].applicationId)).toEqual([clean.appId]);
  });
});

// ---------------------------------------------------------------- rules version (#6)

describe("AUTO policy and the rules version", () => {
  it("does not approve an application evaluated under older rules", async () => {
    const u = await bareUser("rules-version", { profile: true });
    await enableAutomation(u, "AUTO", {}, "none");
    const { settings } = await automationSettingsService.ensure(u);
    automaticExecutor();
    const stale = await makeApp(u, { status: "PREPARING", mode: "AUTO", decision: "AUTO_ELIGIBLE", rulesVersion: settings.rulesVersion - 1 });
    await expect(routeAfterPreparation(u, stale.appId, { pending: [], truthOk: true, warnings: [], runId: null })).resolves.toBe("WAITING_APPROVAL");
    const event = await prisma.applicationEvent.findFirstOrThrow({ where: { applicationId: stale.appId, toStatus: "WAITING_APPROVAL" } });
    expect(event.message).toMatch(/rules changed/);
    expect(executeCalls()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- approvals and retries (#5, #7)

describe("approvals and retries", () => {
  it("a retry never submits content that was not approved; Review & approve from the handoff queues it", async () => {
    const u = await bareUser("retry-approval", { profile: true });
    // Handed off straight from preparation (no automatic executor at that time): never approved.
    const { appId } = await makeApp(u, { status: "MANUAL_ACTION_REQUIRED", mode: "AUTO", manualActionReason: "LOGIN_REQUIRED" });
    await expect(applicationService.applyNow(u, appId, { retry: true })).rejects.toMatchObject({ code: "INVALID_STATE", message: expect.stringMatching(/approve/i) });
    expect(executeCalls()).toHaveLength(0);

    const approved = await applicationService.approve(u, appId);
    expect(approved.status).toBe("APPROVED");
    expect(await appRow(appId)).toMatchObject({ status: "APPROVED", approvalSource: "user", manualActionReason: null, nextActionAt: null });
    expect((await appRow(appId)).approvedAt).not.toBeNull();
    const calls = executeCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]![1]).toMatchObject({ applicationId: appId });
    expect(calls[0]![1].retry).toBeFalsy();
    // The approval froze the content that will be sent.
    expect(await prisma.resumeVersion.count({ where: { applicationId: appId, kind: "TAILORED", approvedAt: { not: null } } })).toBe(1);
  });

  it("editing a failed application clears its approval and the scheduled retry; a retry then needs a new approval", async () => {
    const u = await bareUser("retry-edit", { profile: true });
    const { appId } = await makeApp(u, { status: "FAILED", mode: "REVIEW", approvedAt: new Date(), approvalSource: "user", nextActionAt: new Date(Date.now() + 60_000) });
    await applicationService.update(u, appId, { coverLetter: "Edited after the failure, never approved." });
    expect(await appRow(appId)).toMatchObject({ status: "FAILED", approvedAt: null, approvalSource: null, nextActionAt: null });
    await expect(applicationService.applyNow(u, appId, { retry: true })).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(executeCalls()).toHaveLength(0);
  });

  it("an uncertain submission can neither be edited nor re-approved; only the confirmed retry lifts its lock", async () => {
    const u = await bareUser("retry-uncertain", { profile: true });
    const { appId, jobId } = await makeApp(u, { status: "MANUAL_ACTION_REQUIRED", mode: "AUTO", manualActionReason: "SUBMISSION_UNCERTAIN", approvedAt: new Date(), approvalSource: "policy" });
    const execution = await prisma.applicationExecution.create({
      data: { userId: u, applicationId: appId, idempotencyKey: `${u}:uncertain-${jobId}`, executorKind: "BROWSER", executorId: "browser:greenhouse", status: "FAILED", attempts: 1, manualActionReason: "SUBMISSION_UNCERTAIN" },
    });
    await expect(applicationService.update(u, appId, { coverLetter: "Changed" })).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect((await prisma.coverLetter.findUniqueOrThrow({ where: { applicationId: appId } })).body).toBe("Approved cover letter.");
    await expect(applicationService.approve(u, appId)).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(executeCalls()).toHaveLength(0);

    // Only the user's explicit acknowledgement ("I checked: it was not received") lifts the lock.
    await expect(applicationService.applyNow(u, appId, { retry: true })).rejects.toMatchObject({ code: "INVALID_STATE" });
    await applicationService.applyNow(u, appId, { retry: true, acknowledgeUncertain: true });
    expect((await prisma.applicationExecution.findUniqueOrThrow({ where: { id: execution.id } })).manualActionReason).toBeNull();
    const calls = executeCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]![1]).toMatchObject({ applicationId: appId, retry: true });
    // Its own queue key: an older queued task without the retry flag can never absorb it.
    expect(calls[0]![2].dedupeKey).toMatch(new RegExp(`^application\\.execute:${appId}:user-retry:`));
  });

  it("approving a Review/Auto application queues its submission; the manual flow's approval submits nothing", async () => {
    const u = await bareUser("approve-queues", { profile: true });
    const review = await makeApp(u, { status: "WAITING_APPROVAL", mode: "REVIEW", nextActionAt: new Date(Date.now() + 3_600_000) });
    const after = await applicationService.approve(u, review.appId);
    expect(after.status).toBe("APPROVED");
    expect(await appRow(review.appId)).toMatchObject({ approvalSource: "user", nextActionAt: null });
    expect(executeCalls().map((c) => c[1].applicationId)).toEqual([review.appId]);

    h.enqueue.mockClear();
    const manual = await makeApp(u, { status: "READY_FOR_REVIEW", mode: null, origin: "USER" });
    expect((await applicationService.approve(u, manual.appId)).status).toBe("APPROVED");
    expect(executeCalls()).toHaveLength(0);
  });

  it("an edit after approval returns a Review/Auto application to WAITING_APPROVAL and drops its deferred submission", async () => {
    const u = await bareUser("edit-approved", { profile: true });
    const { appId } = await makeApp(u, { status: "APPROVED", mode: "AUTO", approvedAt: new Date(), approvalSource: "policy", nextActionAt: new Date(Date.now() + 3_600_000) });
    await applicationService.update(u, appId, { coverLetter: "Edited while the submission was deferred." });
    expect(await appRow(appId)).toMatchObject({ status: "WAITING_APPROVAL", approvedAt: null, approvalSource: null, nextActionAt: null });

    // The manual flow still returns to READY_FOR_REVIEW, as before.
    const manual = await makeApp(u, { status: "APPROVED", mode: null, origin: "USER", approvedAt: new Date(), approvalSource: "user" });
    await applicationService.update(u, manual.appId, { coverLetter: "Edited." });
    expect(await appRow(manual.appId)).toMatchObject({ status: "READY_FOR_REVIEW", approvedAt: null });
  });

  it("saving the answers form never turns an unchanged generated suggestion into your own answer", async () => {
    const u = await bareUser("answers-unchanged", { profile: true });
    const { appId } = await makeApp(u, { status: "READY_FOR_REVIEW", mode: null, origin: "USER" });
    const common = { userId: u, applicationId: appId, provider: "fallback", promptVersion: "test", required: true };
    const suggestion = await prisma.screeningAnswerDraft.create({ data: { ...common, question: "Describe a product you are proud of", answer: "Generated draft.", originalAnswer: "Generated draft.", canConfirm: true, answerSource: "GENERATED", resolved: false } });
    const typed = await prisma.screeningAnswerDraft.create({ data: { ...common, question: "Why us?", answer: "", originalAnswer: "", answerSource: "UNKNOWN", resolved: false, sortOrder: 1 } });
    await applicationService.update(u, appId, { screeningAnswers: [{ id: suggestion.id, answer: "Generated draft." }, { id: typed.id, answer: "Your editor product." }] });
    expect(await prisma.screeningAnswerDraft.findUniqueOrThrow({ where: { id: suggestion.id } })).toMatchObject({ answerSource: "GENERATED", resolved: false });
    expect(await prisma.screeningAnswerDraft.findUniqueOrThrow({ where: { id: typed.id } })).toMatchObject({ answerSource: "CANDIDATE_ANSWER", resolved: true, answer: "Your editor product." });
  });
});

// ---------------------------------------------------------------- fencing (#18)

describe("fencing content against executors and superseded preparations", () => {
  it("content can not change while the application is being submitted or after it was sent", async () => {
    const u = await bareUser("fence-applying", { profile: true });
    for (const status of ["APPLYING", "APPLIED", "SUBMITTED"] as ApplicationStatus[]) {
      const { appId } = await makeApp(u, { status, mode: "AUTO", approvedAt: new Date() });
      await expect(applicationService.update(u, appId, { coverLetter: "Sneaked in." }), status).rejects.toMatchObject({ code: "INVALID_STATE" });
      expect((await prisma.coverLetter.findUniqueOrThrow({ where: { applicationId: appId } })).body).toBe("Approved cover letter.");
      // Notes are not content and can still be kept.
      await applicationService.update(u, appId, { notes: "Waiting to hear back." });
    }
  });

  it("an edit that loses the race against the executor rolls back completely", async () => {
    const u = await bareUser("fence-race", { profile: true });
    const { appId } = await makeApp(u, { status: "APPROVED", mode: "AUTO", approvedAt: new Date(), approvalSource: "policy" });
    // The executor's compare-and-set (APPROVED -> APPLYING) wins while the edit is being validated.
    const delegate = prisma.tailoredResume as unknown as { findUnique: (args: unknown) => Promise<unknown> };
    const original = delegate.findUnique.bind(delegate);
    vi.spyOn(delegate, "findUnique").mockImplementationOnce(async (args: unknown) => {
      await prisma.application.update({ where: { id: appId }, data: { status: "APPLYING" } });
      return original(args);
    });
    await expect(applicationService.update(u, appId, { tailoredSummary: "Unapproved summary.", coverLetter: "Unapproved edit." })).rejects.toMatchObject({ code: "INVALID_STATE" });
    // Nothing of the edit was written: the executor only ever reads approved content.
    expect((await prisma.coverLetter.findUniqueOrThrow({ where: { applicationId: appId } })).body).toBe("Approved cover letter.");
    expect((await prisma.tailoredResume.findUniqueOrThrow({ where: { applicationId: appId } })).editedSummary).toBeNull();
    expect(await appRow(appId)).toMatchObject({ status: "APPLYING" });
  });

  it("a preparation whose application moved on writes no drafts and does not fail it", async () => {
    const u = await bareUser("fence-prepare", { profile: true });
    const { appId } = await makeApp(u, { status: "PREPARING", mode: "REVIEW", preparedAt: null, drafts: false });
    // The user declines it while the drafts are generated.
    vi.spyOn(resumeSelectionService, "selectForApplication").mockImplementationOnce(async () => {
      await prisma.application.update({ where: { id: appId }, data: { status: "WITHDRAWN" } });
      return null;
    });
    await expect(applicationService.runPrepare(u, appId)).resolves.toBeUndefined();
    expect(await appRow(appId)).toMatchObject({ status: "WITHDRAWN", preparedAt: null, preparationError: null });
    expect(await prisma.tailoredResume.count({ where: { applicationId: appId } })).toBe(0);
    expect(await prisma.applicationEvent.count({ where: { applicationId: appId, type: { in: ["prepared", "preparation_failed"] } } })).toBe(0);
  }, SLOW);
});

// ---------------------------------------------------------------- settings honoured (#11, #12)

describe("automation settings are honoured", () => {
  it("'Write a cover letter' off: no letter is generated, and none from an earlier preparation is kept", async () => {
    const u = await bareUser("no-cover", { profile: true });
    await enableAutomation(u, "REVIEW", { generateCoverLetter: false }, "none");
    const { appId } = await makeApp(u, { status: "PREPARING", mode: "REVIEW", preparedAt: null });
    expect(await prisma.coverLetter.count({ where: { applicationId: appId } })).toBe(1);
    await applicationService.runPrepare(u, appId);
    expect(await prisma.coverLetter.count({ where: { applicationId: appId } })).toBe(0);
    expect((await appRow(appId)).preparedAt).not.toBeNull();

    // The manual flow (not created by the automation) keeps generating one.
    const manual = await makeApp(u, { status: "PREPARING", mode: null, origin: "USER", preparedAt: null, drafts: false });
    await applicationService.runPrepare(u, manual.appId);
    expect(await prisma.coverLetter.count({ where: { applicationId: manual.appId } })).toBe(1);
  }, SLOW);

  it("'Tailor my resume' off: the approval freezes a version built from verified facts, never the raw CV parse", async () => {
    const u = await bareUser("no-tailor", { profile: true });
    await enableAutomation(u, "REVIEW", { tailorResume: false }, "none");
    const raw = resumeDoc("Rejected claim from the CV parser.");
    const original = await prisma.resumeVersion.create({ data: { userId: u, kind: "ORIGINAL", label: "Original: cv.pdf", content: raw as unknown as Prisma.InputJsonValue, contentHash: resumeContentHash(raw) } });
    const { appId } = await makeApp(u, { status: "WAITING_APPROVAL", mode: "REVIEW" });
    await prisma.application.update({ where: { id: appId }, data: { selectedResumeVersionId: original.id } });

    await applicationService.approve(u, appId);
    const frozen = await prisma.resumeVersion.findFirstOrThrow({ where: { applicationId: appId, kind: "TAILORED" } });
    expect(frozen.approvedAt).not.toBeNull();
    expect(JSON.stringify(frozen.content)).not.toContain("Rejected claim from the CV parser.");
    expect((await prisma.tailoredResume.findUniqueOrThrow({ where: { applicationId: appId } })).resumeVersionId).toBe(frozen.id);

    // A variant the user edited and approved themselves is used as-is.
    const edited = resumeDoc("My own reviewed bullet.");
    const variant = await prisma.resumeVersion.create({ data: { userId: u, kind: "EDITED", label: "Frontend Resume", content: edited as unknown as Prisma.InputJsonValue, contentHash: resumeContentHash(edited), approvedAt: new Date() } });
    const second = await makeApp(u, { status: "WAITING_APPROVAL", mode: "REVIEW" });
    await prisma.application.update({ where: { id: second.appId }, data: { selectedResumeVersionId: variant.id } });
    await applicationService.approve(u, second.appId);
    const frozenVariant = await prisma.resumeVersion.findFirstOrThrow({ where: { applicationId: second.appId, kind: "TAILORED" } });
    expect(JSON.stringify(frozenVariant.content)).toContain("My own reviewed bullet.");
  }, SLOW);
});

// ---------------------------------------------------------------- runtime questions (#19)

describe("questions found on the live form", () => {
  it("are resolved from the user's answers, so the answer reaches the next submission", async () => {
    const u = await bareUser("runtime-questions", { profile: true });
    const question = "Do you have a valid driving licence for this role?";
    const { appId, jobId } = await makeApp(u, {
      status: "PREPARING",
      runtimeQuestions: [{ question, required: true, inputType: "select", options: ["Yes", "No"], providerKey: null }] as unknown as Prisma.InputJsonValue,
    });
    const run = async () => resolveQuestions(u, jobId, await buildGenerationContext(u, jobId), await prepareOpts(u), appId);

    let { drafts, pending } = await run();
    const key = drafts.find((d) => d.question === question)?.questionKey;
    expect(key).toBeTruthy();
    expect(pending.map((p) => p.key)).toContain(key);

    await candidateAnswersService.upsert(u, { question, answer: "Yes" });
    ({ drafts, pending } = await run());
    expect(pending).toEqual([]);
    expect(drafts.find((d) => d.question === question)).toMatchObject({ answer: "Yes", resolved: true, answerSource: "CANDIDATE_ANSWER" });
  });
});

// ---------------------------------------------------------------- run attribution and notifications (#22, #29)

describe("preparation episodes", () => {
  it("only the first preparation counts on the run that created the application", async () => {
    const u = await bareUser("run-count", { profile: true });
    await enableAutomation(u, "REVIEW", {}, "none");
    const run = await prisma.automationRun.create({ data: { userId: u, trigger: "manual", status: "COMPLETED", mode: "REVIEW" } });
    const { appId } = await makeApp(u, { status: "PREPARING", preparedAt: null, automationRunId: run.id, drafts: false });
    await applicationService.runPrepare(u, appId);
    const counted = await prisma.automationRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(counted.applicationsPrepared).toBe(1);

    // Prepared again later (answers given, "Regenerate drafts"): the old run's counters stay as they were.
    await prisma.application.update({ where: { id: appId }, data: { status: "PREPARING" } });
    await applicationService.runPrepare(u, appId);
    const after = await prisma.automationRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(after).toMatchObject({ applicationsPrepared: 1, manualActions: counted.manualActions, needsInformation: counted.needsInformation });
  }, SLOW);

  it("every new preparation notifies again; a duplicate task for the same preparation does not", async () => {
    const u = await bareUser("review-episodes", { profile: true });
    await enableAutomation(u, "MANUAL", {}, "none");
    const { appId } = await makeApp(u, { status: "PREPARING", mode: "MANUAL", preparedAt: null, drafts: false });
    const reviews = () => prisma.notification.count({ where: { userId: u, type: "application.approval_required", link: `/applications/${appId}` } });
    await applicationService.runPrepare(u, appId);
    expect(await appRow(appId)).toMatchObject({ status: "READY_FOR_REVIEW" });
    expect(await reviews()).toBe(1);
    await applicationService.runPrepare(u, appId); // duplicate task: the application is no longer PREPARING
    expect(await reviews()).toBe(1);
    await prisma.application.update({ where: { id: appId }, data: { status: "PREPARING" } });
    await applicationService.runPrepare(u, appId);
    expect(await reviews()).toBe(2);
  }, SLOW);
});

// ---------------------------------------------------------------- next action (#4)

describe("next action", () => {
  it("a failed Review/Auto application with a scheduled retry is not presented as a handoff", () => {
    const at = new Date("2031-03-10T09:30:00Z");
    expect(nextActionFor({ status: "FAILED", mode: "AUTO", pendingCount: 0, nextActionAt: at, manualActionReason: null })).toBe("Retrying automatically after 2031-03-10 09:30 UTC");
    expect(nextActionFor({ status: "FAILED", mode: "REVIEW", pendingCount: 0, nextActionAt: null, manualActionReason: null })).toBe("Retry or apply manually");
    expect(nextActionFor({ status: "FAILED", mode: null, pendingCount: 0, nextActionAt: at, manualActionReason: null })).toBe("Retry or apply manually");
  });
});

// ---------------------------------------------------------------- work authorisation answers (#1)

describe("work authorisation answers are tied to a country", () => {
  const THIS_COUNTRY = "Are you legally authorized to work in this country?";

  it("an answer for a job in a known country is saved for that country only; with an unknown country for that application only", async () => {
    const u = await bareUser("work-auth", { profile: true });
    const pendingFor = (key: string) => [{ key, canonicalKey: "work_authorization", question: THIS_COUNTRY, required: true, options: null, sensitive: true }] as unknown as Prisma.InputJsonValue;

    // A job in Bengaluru: the answer is about India and reusable for other jobs in India.
    const india = await makeApp(u, { status: "NEEDS_INFORMATION", locations: ["Bengaluru"], pendingQuestions: pendingFor("work_authorization") });
    await provideInformation(u, india.appId, [{ key: "work_authorization", question: THIS_COUNTRY, answer: "Yes", remember: true }]);
    expect((await candidateAnswersService.list(u)).map((a) => a.questionKey)).toEqual(["work_authorization:india"]);

    // A job whose country is unknown: kept for that application only, even with "save for future applications".
    const unknown = await makeApp(u, { status: "NEEDS_INFORMATION", locations: [], pendingQuestions: pendingFor("work_authorization") });
    await provideInformation(u, unknown.appId, [{ key: "work_authorization", question: THIS_COUNTRY, answer: "No", remember: true }]);
    expect((await candidateAnswersService.list(u)).map((a) => a.questionKey)).toEqual(["work_authorization:india"]);
    expect(await prisma.candidateAnswer.count({ where: { userId: u, questionKey: `app:${unknown.appId}:work_authorization` } })).toBe(1);
    const sources = await candidateAnswersService.answerSources(u, unknown.appId);
    expect(sources.candidateAnswers).toEqual(
      expect.arrayContaining([expect.objectContaining({ questionKey: "work_authorization", answer: "No", applicationScoped: true }), expect.objectContaining({ questionKey: "work_authorization:india", applicationScoped: false })]),
    );
  });

  it("preparation qualifies the question with the job's country, so an answer for India is never used elsewhere", async () => {
    const u = await bareUser("work-auth-prepare", { profile: true });
    await candidateAnswersService.upsert(u, { questionKey: "work_authorization:india", question: THIS_COUNTRY, answer: "Yes" });
    const resolve = async (locations: string[]) => {
      const { appId, jobId } = await makeApp(u, { status: "PREPARING", locations, screeningQuestions: [`${THIS_COUNTRY} *`] });
      return resolveQuestions(u, jobId, await buildGenerationContext(u, jobId), await prepareOpts(u), appId);
    };
    const inIndia = await resolve(["Bengaluru"]);
    expect(inIndia.pending).toEqual([]);
    expect(inIndia.drafts.find((d) => d.question === THIS_COUNTRY)).toMatchObject({ questionKey: "work_authorization:india", answer: "Yes", answerSource: "CANDIDATE_ANSWER", resolved: true });
    for (const locations of [[], ["London, United Kingdom"]]) {
      const elsewhere = await resolve(locations);
      expect(elsewhere.pending.map((p) => p.question), JSON.stringify(locations)).toEqual([THIS_COUNTRY]);
      expect(elsewhere.drafts.find((d) => d.question === THIS_COUNTRY)).toMatchObject({ resolved: false, answerSource: "UNKNOWN" });
    }
  });
});
