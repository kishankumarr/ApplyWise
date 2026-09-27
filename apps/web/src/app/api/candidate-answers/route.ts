import { candidateAnswerUpsertSchema } from "@applywise/validation";
import { route } from "@/server/http";
import { candidateAnswersService } from "@/server/services/candidate-answers.service";

/** GET: the user's reusable application answers. */
export const GET = route({}, async ({ userId }) => candidateAnswersService.list(userId));

/** PUT: create or replace a reusable answer (always user-authored). */
export const PUT = route({ body: candidateAnswerUpsertSchema }, async ({ userId, body, requestId }) => candidateAnswersService.upsert(userId, body, requestId));
