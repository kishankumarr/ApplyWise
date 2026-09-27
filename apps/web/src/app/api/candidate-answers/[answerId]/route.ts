import { route } from "@/server/http";
import { candidateAnswersService } from "@/server/services/candidate-answers.service";

export const DELETE = route<{ answerId: string }>({}, async ({ userId, params, requestId }) => candidateAnswersService.remove(userId, params.answerId, requestId));
