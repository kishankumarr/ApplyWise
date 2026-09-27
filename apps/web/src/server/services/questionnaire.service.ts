import "server-only";
import { prisma, type Prisma } from "@applywise/database";
import { generateQuestionnaire } from "@applywise/ai";
import { normalizeSkill } from "@applywise/job-engine";
import type { JobQuestion, QuestionOption } from "@applywise/types";
import type { QuestionnaireAnswersInput } from "@applywise/validation";
import { audit } from "../audit";
import { Errors } from "../errors";
import { logger } from "../logger";
import { profileRepo } from "../repositories/profile.repo";
import { aiConfigFor, buildGenerationContext } from "./context.service";
import { jobsService } from "./jobs.service";

const questionInclude = { questions: { orderBy: { sortOrder: "asc" }, include: { answer: true } } } satisfies Prisma.JobQuestionnaireInclude;

type QuestionnaireRow = Prisma.JobQuestionnaireGetPayload<{ include: typeof questionInclude }>;

function toView(q: QuestionnaireRow) {
  const questions: JobQuestion[] = q.questions.map((x) => ({
    id: x.key,
    type: x.type,
    text: x.text,
    whyAsked: x.whyAsked,
    requiredForJob: x.requiredForJob,
    relatedRequirement: x.relatedRequirement,
    options: (x.options as QuestionOption[] | null) ?? null,
    allowFreeText: x.allowFreeText,
    showWhen: (x.showWhen as JobQuestion["showWhen"]) ?? null,
  }));
  const answers: Record<string, { value: string; freeText: string | null }> = {};
  for (const x of q.questions) if (x.answer) answers[x.key] = { value: x.answer.value, freeText: x.answer.freeText };
  return { id: q.id, jobId: q.jobId, status: q.status, provider: q.provider, modelId: q.modelId, promptVersion: q.promptVersion, questions, answers };
}

/** Skill questions are sanitised to these canonical options; only they create verified facts. */
const POSITIVE_SKILL_ANSWERS = new Set(["yes_professional", "yes_project"]);

export const questionnaireService = {
  async get(userId: string, jobId: string) {
    const q = await prisma.jobQuestionnaire.findUnique({ where: { userId_jobId: { userId, jobId } }, include: questionInclude });
    return q ? toView(q) : null;
  },

  async generate(userId: string, jobId: string, opts: { regenerate?: boolean; requestId?: string } = {}) {
    await jobsService.getRow(userId, jobId);
    const existing = await this.get(userId, jobId);
    if (existing && !opts.regenerate) return existing;
    const ctx = await buildGenerationContext(userId, jobId);
    const result = await generateQuestionnaire(ctx, { logger, config: await aiConfigFor(userId) });
    const q = await prisma.$transaction(async (tx) => {
      await tx.jobQuestionnaire.deleteMany({ where: { userId, jobId } });
      return tx.jobQuestionnaire.create({
        data: {
          userId,
          jobId,
          status: "PENDING",
          provider: result.meta.provider,
          modelId: result.meta.modelId,
          promptVersion: result.meta.promptVersion,
          questions: {
            create: result.data.map((x, i) => ({
              key: x.id,
              type: x.type,
              text: x.text,
              whyAsked: x.whyAsked,
              requiredForJob: x.requiredForJob,
              relatedRequirement: x.relatedRequirement,
              options: (x.options ?? undefined) as Prisma.InputJsonValue | undefined,
              allowFreeText: x.allowFreeText,
              showWhen: (x.showWhen ?? undefined) as Prisma.InputJsonValue | undefined,
              sortOrder: i,
            })),
          },
        },
        include: questionInclude,
      });
    });
    await audit(userId, "questionnaire.generated", { requestId: opts.requestId, entityType: "JobQuestionnaire", entityId: q.id, metadata: { provider: result.meta.provider, promptVersion: result.meta.promptVersion, count: result.data.length } });
    return toView(q);
  },

  /**
   * Save answers. Truthful positive answers become USER_VERIFIED facts (the user authored
   * them); "No" answers never create facts, and "No" on an unverified CV claim rejects it.
   */
  async saveAnswers(userId: string, jobId: string, input: QuestionnaireAnswersInput, requestId?: string) {
    const q = await prisma.jobQuestionnaire.findUnique({ where: { userId_jobId: { userId, jobId } }, include: questionInclude });
    if (!q) throw Errors.notFound("Questionnaire");
    const profile = await profileRepo.ensure(userId);
    const byKey = new Map(q.questions.map((x) => [x.key, x]));

    for (const [key, answer] of Object.entries(input.answers)) {
      const question = byKey.get(key);
      if (!question) throw Errors.validation(`Unknown question "${key}".`);
      const options = (question.options as QuestionOption[] | null) ?? null;
      if (options && answer.value && !options.some((o) => o.value === answer.value)) throw Errors.validation(`Invalid option for "${key}".`);

      let factId: string | null = question.answer?.truthBankItemId ?? null;
      // Remove a previously derived fact when the answer changes.
      if (factId) {
        await prisma.truthBankItem.deleteMany({ where: { id: factId, userId } });
        factId = null;
      }
      const skill = question.relatedRequirement ? normalizeSkill(question.relatedRequirement) : null;
      const free = answer.freeText?.trim() || null;

      if (question.type === "SKILL_CONFIRMATION" && skill) {
        const isConfirmOfCvClaim = key.startsWith("confirm_");
        if (POSITIVE_SKILL_ANSWERS.has(answer.value)) {
          const where = answer.value === "yes_professional" ? " in a professional role" : " in a personal/side project";
          const fact = await prisma.truthBankItem.create({
            data: { userId, profileId: profile.id, kind: "QUESTIONNAIRE_ANSWER", text: `Has used ${question.relatedRequirement}${where}.`, status: "USER_VERIFIED", source: "QUESTIONNAIRE", verifiedAt: new Date() },
          });
          factId = fact.id;
          await prisma.candidateSkill.upsert({
            where: { profileId_canonicalName: { profileId: profile.id, canonicalName: skill } },
            create: { userId, profileId: profile.id, name: question.relatedRequirement!, canonicalName: skill, source: "QUESTIONNAIRE", status: "USER_VERIFIED" },
            update: { status: "USER_VERIFIED" },
          });
        } else if (answer.value === "no" && isConfirmOfCvClaim) {
          await prisma.candidateSkill.updateMany({ where: { userId, canonicalName: skill }, data: { status: "USER_REJECTED" } });
        }
      } else if (free && (question.type === "EXPERIENCE_DETAIL" || question.type === "METRIC" || question.type === "SCREENING" || question.type === "OPEN_TEXT")) {
        const prefix = question.relatedRequirement && question.type === "EXPERIENCE_DETAIL" ? `${question.relatedRequirement} experience: ` : "";
        const fact = await prisma.truthBankItem.create({
          data: { userId, profileId: profile.id, kind: "QUESTIONNAIRE_ANSWER", text: `${prefix}${free}`, status: "USER_VERIFIED", source: "QUESTIONNAIRE", section: question.type.toLowerCase(), verifiedAt: new Date() },
        });
        factId = fact.id;
      } else if (question.type === "ELIGIBILITY" && key === "elig_notice" && answer.value) {
        const label = answer.value === "immediate" ? "Immediate" : `${answer.value} days`;
        await prisma.candidatePreference.updateMany({ where: { userId }, data: { noticePeriod: label } });
      }

      await prisma.jobAnswer.upsert({
        where: { questionId: question.id },
        create: { userId, questionId: question.id, value: answer.value, freeText: free, truthBankItemId: factId },
        update: { value: answer.value, freeText: free, truthBankItemId: factId },
      });
    }

    const answeredCount = await prisma.jobAnswer.count({ where: { userId, question: { questionnaireId: q.id } } });
    await prisma.jobQuestionnaire.update({ where: { id: q.id }, data: { status: input.complete ? "COMPLETED" : answeredCount > 0 ? "IN_PROGRESS" : "PENDING" } });
    await profileRepo.bumpFactsVersion(userId);
    await audit(userId, "questionnaire.answered", { requestId, entityType: "JobQuestionnaire", entityId: q.id, metadata: { answered: Object.keys(input.answers).length, complete: input.complete } });
    return this.get(userId, jobId);
  },
};
