import { z } from "zod";
import { questionTypeSchema } from "./common";

export const questionOptionSchema = z.object({
  value: z.string().min(1).max(80),
  label: z.string().min(1).max(200),
});

export const jobQuestionSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9_:-]+$/i, "Question ids must be stable slugs"),
  type: questionTypeSchema,
  text: z.string().min(5).max(300),
  whyAsked: z.string().min(5).max(400),
  requiredForJob: z.boolean(),
  relatedRequirement: z.string().max(200).nullable(),
  options: z.array(questionOptionSchema).min(2).max(8).nullable(),
  allowFreeText: z.boolean(),
  showWhen: z
    .object({ questionId: z.string().min(1), equalsAny: z.array(z.string()).min(1) })
    .nullable(),
});

/** Questionnaires must contain between 3 and 8 questions with unique ids. */
export const questionListSchema = z
  .array(jobQuestionSchema)
  .min(3, "A questionnaire needs at least 3 questions")
  .max(8, "A questionnaire can have at most 8 questions")
  .superRefine((questions, ctx) => {
    const ids = new Set<string>();
    for (const q of questions) {
      if (ids.has(q.id)) {
        ctx.addIssue({ code: "custom", message: `Duplicate question id ${q.id}` });
      }
      ids.add(q.id);
    }
    for (const q of questions) {
      if (q.showWhen && !ids.has(q.showWhen.questionId)) {
        ctx.addIssue({
          code: "custom",
          message: `Question ${q.id} depends on unknown question ${q.showWhen.questionId}`,
        });
      }
      if (q.type === "SKILL_CONFIRMATION" && q.options) {
        const values = q.options.map((o) => o.value.toLowerCase());
        if (!values.some((v) => v === "no" || v === "not_sure")) {
          ctx.addIssue({
            code: "custom",
            message: `Skill confirmation ${q.id} must offer a "No" or "Not sure" option`,
          });
        }
      }
    }
  });

export const answerSchema = z.object({
  value: z.string().trim().max(80),
  freeText: z.string().trim().max(2000).nullable().optional(),
});

/** POST /api/jobs/[jobId]/questionnaire/answers */
export const questionnaireAnswersSchema = z.object({
  answers: z.record(z.string().min(1).max(80), answerSchema),
  complete: z.boolean().optional().default(false),
});
export type QuestionnaireAnswersInput = z.infer<typeof questionnaireAnswersSchema>;
