import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@applywise/database";
import { classifyQuestion, DEMO_SINGAPORE_PERMIT_QUESTION, questionKeyFor, resolveApplicationAnswers } from "@applywise/job-engine";
import { logger } from "@/server/logger";
import { provideInformation, resolveQuestions } from "@/server/services/application-routing.service";
import { applicationScopedKey, candidateAnswersService } from "@/server/services/candidate-answers.service";
import { aiConfigFor, buildGenerationContext } from "@/server/services/context.service";
import { bareUser, disableTrackedUsers, fabricateApp } from "./automation-helpers";

/**
 * Reusable application answers (CandidateAnswer): keyed by the question classifier, application-scoped answers
 * ("save for future applications" unticked) and the rule that sensitive answers are never inferred.
 */

const service = candidateAnswersService;
const NOTICE = "What is your notice period?";
const CURRENT_CTC = "What is your current CTC?";
const EXPECTED_CTC = "What is your expected CTC?";

/**
 * A user with a minimal profile; preferences include an expected salary (never a current one). Verified profile data
 * and preferences come before saved answers in the resolver, so `notice: false` leaves the notice period to answers.
 */
async function answersUser(tag: string, opts: { notice?: boolean } = {}): Promise<string> {
  const userId = await bareUser(tag, { profile: true, fullName: "Asha Rao" });
  await prisma.candidatePreference.updateMany({
    where: { userId },
    data: { expectedSalaryMin: 2_800_000, expectedSalaryMax: 3_800_000, currency: "INR", noticePeriod: opts.notice === false ? null : "30 days" },
  });
  return userId;
}

const resolveOne = async (userId: string, question: string, applicationId: string | null = null, options: string[] | null = null) => {
  const q = classifyQuestion(question, { required: true, options, origin: "provider" });
  const { answers, pending } = resolveApplicationAnswers([q], await service.answerSources(userId, applicationId));
  return { answer: answers[0]!, pending };
};

afterAll(disableTrackedUsers);

describe("upsert keyed by the question classifier", () => {
  it("differently worded versions of the same question update one answer", async () => {
    const u = await answersUser("answers-key", { notice: false });
    expect(questionKeyFor("Notice period (in days)?")).toBe(questionKeyFor(NOTICE));

    const first = await service.upsert(u, { question: NOTICE, answer: "30 days" });
    expect(first).toMatchObject({ questionKey: questionKeyFor(NOTICE), question: NOTICE, answer: "30 days", source: "CANDIDATE_ANSWER", status: "USER_VERIFIED" });
    const second = await service.upsert(u, { question: "Notice period (in days)?", answer: "45 days" });
    expect(second.id).toBe(first.id);
    expect(await service.list(u)).toEqual([expect.objectContaining({ id: first.id, question: "Notice period (in days)?", answer: "45 days" })]);

    // Unrecognised questions get a stable custom key per wording; an explicit key wins.
    const a = await service.upsert(u, { question: "Why do you want to work with us?", answer: "Your editor product." });
    const b = await service.upsert(u, { question: "Why do you want to join us?", answer: "The team." });
    expect(a.questionKey).toMatch(/^custom:/);
    expect(b.questionKey).not.toBe(a.questionKey);
    const explicit = await service.upsert(u, { questionKey: "custom:portfolio-walkthrough", question: "Walk us through a project", answer: "ReelNotes." });
    expect(explicit.questionKey).toBe("custom:portfolio-walkthrough");
    expect(await service.list(u)).toHaveLength(4);

    // The saved answer is what the resolver uses for the same question, however it is worded.
    const { answer } = await resolveOne(u, "How long is your notice period?");
    expect(answer).toMatchObject({ status: "RESOLVED", answer: "45 days", source: "CANDIDATE_ANSWER" });

    // Answers are PII: the audit log records the key and sensitivity, never the answer.
    const audits = await prisma.auditLog.findMany({ where: { userId: u, action: "candidate_answer.saved" } });
    expect(audits).toHaveLength(5);
    expect(JSON.stringify(audits)).not.toContain("45 days");
    expect(audits.find((x) => (x.metadata as { questionKey?: string }).questionKey === "notice_period")?.metadata).toMatchObject({ sensitive: true });
  });

  it("removing an answer is limited to its owner", async () => {
    const u = await answersUser("answers-remove");
    const other = await answersUser("answers-remove-other");
    const saved = await service.upsert(u, { question: NOTICE, answer: "30 days" });
    await expect(service.remove(other, saved.id)).rejects.toMatchObject({ status: 404 });
    await expect(service.remove(u, saved.id)).resolves.toEqual({ removed: true });
    expect(await service.list(u)).toEqual([]);
  });
});

describe("application-scoped answers (remember = false)", () => {
  it("are used for that application only and hidden from the reusable list", async () => {
    const u = await answersUser("answers-scoped");
    const appA = await fabricateApp(u, { status: "WAITING_APPROVAL", mode: "REVIEW" });
    const appB = await fabricateApp(u, { status: "WAITING_APPROVAL", mode: "REVIEW" });
    const key = questionKeyFor(DEMO_SINGAPORE_PERMIT_QUESTION);

    await provideInformation(u, appA.appId, [{ key, question: DEMO_SINGAPORE_PERMIT_QUESTION, answer: "No", remember: false }]);
    const row = await prisma.candidateAnswer.findFirstOrThrow({ where: { userId: u } });
    expect(row.questionKey).toBe(applicationScopedKey(appA.appId, key));
    expect(await service.list(u)).toEqual([]);

    const forA = await service.answerSources(u, appA.appId);
    expect(forA.candidateAnswers).toEqual([expect.objectContaining({ questionKey: key, answer: "No" })]);
    expect((await service.answerSources(u, appB.appId)).candidateAnswers).toEqual([]);
    expect((await service.answerSources(u)).candidateAnswers).toEqual([]);

    const options = ["Yes", "No"];
    expect((await resolveOne(u, DEMO_SINGAPORE_PERMIT_QUESTION, appA.appId, options)).answer).toMatchObject({ status: "RESOLVED", answer: "No", source: "CANDIDATE_ANSWER" });
    const forB = await resolveOne(u, DEMO_SINGAPORE_PERMIT_QUESTION, appB.appId, options);
    expect(forB.answer.status).toBe("UNKNOWN");
    expect(forB.pending.map((p) => p.key)).toEqual([key]);

    // A reusable answer applies everywhere, but this application's own answer still wins for it.
    await provideInformation(u, appB.appId, [{ key, question: DEMO_SINGAPORE_PERMIT_QUESTION, answer: "Yes", remember: true }]);
    expect((await service.list(u)).map((a) => [a.questionKey, a.answer])).toEqual([[key, "Yes"]]);
    expect((await resolveOne(u, DEMO_SINGAPORE_PERMIT_QUESTION, appA.appId, options)).answer).toMatchObject({ status: "RESOLVED", answer: "No" });
    expect((await resolveOne(u, DEMO_SINGAPORE_PERMIT_QUESTION, appB.appId, options)).answer).toMatchObject({ status: "RESOLVED", answer: "Yes" });
    // Applications are left where they were (only NEEDS_INFORMATION resumes the workflow).
    expect(await prisma.application.count({ where: { userId: u, status: "WAITING_APPROVAL" } })).toBe(2);
    expect(await prisma.applicationEvent.count({ where: { userId: u, type: "information_provided" } })).toBe(2);
  });
});

describe("sensitive answers are never inferred", () => {
  it("a current-salary question stays unresolved even with an expected salary set, until the user answers it", async () => {
    const u = await answersUser("answers-sensitive");
    const { appId, jobId } = await fabricateApp(u, { status: "PREPARING", mode: "REVIEW", screeningQuestions: [`${CURRENT_CTC} *`, EXPECTED_CTC, `${NOTICE} (required)`] });
    const prepare = async () => resolveQuestions(u, jobId, await buildGenerationContext(u, jobId), { logger, config: await aiConfigFor(u) }, appId);

    let { drafts, pending } = await prepare();
    const current = drafts.find((d) => d.questionKey === "current_salary")!;
    expect(current).toMatchObject({ answer: "", resolved: false, canConfirm: false, answerSource: "UNKNOWN", required: true });
    expect(pending).toEqual([expect.objectContaining({ key: "current_salary", canonicalKey: "current_salary", sensitive: true, required: true })]);
    // Its neighbours are answered from the user's own preferences.
    expect(drafts.find((d) => d.questionKey === "expected_salary")).toMatchObject({ resolved: true, answerSource: "PREFERENCE", answer: "INR 2,800,000 - 3,800,000 per year" });
    expect(drafts.find((d) => d.questionKey === "notice_period")).toMatchObject({ resolved: true, answerSource: "PREFERENCE", answer: "30 days" });

    // The resolver says why: current salary is only ever taken from an answer the user gave.
    const direct = await resolveOne(u, CURRENT_CTC);
    expect(direct.answer).toMatchObject({ status: "UNKNOWN", answer: null, source: "UNKNOWN" });
    expect(direct.answer.reason).toMatch(/never from your expected salary/);

    // A saved answer to the expected salary does not count either; the user's own current-salary answer does.
    await service.upsert(u, { question: EXPECTED_CTC, answer: "32 LPA" });
    ({ pending } = await prepare());
    expect(pending.map((p) => p.key)).toEqual(["current_salary"]);
    await service.upsert(u, { question: "Current salary (LPA)", answer: "24 LPA" });
    ({ drafts, pending } = await prepare());
    expect(pending).toEqual([]);
    expect(drafts.find((d) => d.questionKey === "current_salary")).toMatchObject({ resolved: true, answer: "24 LPA", answerSource: "CANDIDATE_ANSWER" });
  });
});
