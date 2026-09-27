import { questionnaireAnswersSchema } from "@applywise/validation";
import { route } from "@/server/http";
import { questionnaireService } from "@/server/services/questionnaire.service";

export const POST = route<{ jobId: string }, typeof questionnaireAnswersSchema>({ body: questionnaireAnswersSchema }, async ({ userId, params, body, requestId }) =>
  questionnaireService.saveAnswers(userId, params.jobId, body, requestId),
);
