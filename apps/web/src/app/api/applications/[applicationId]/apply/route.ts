import { applicationApplySchema } from "@applywise/validation";
import { route } from "@/server/http";
import { applicationService } from "@/server/services/application.service";

/**
 * POST: "Approve & apply" from the review queue (or "Retry" after a manual fix). Requires explicit confirmation;
 * the submission itself runs in the worker through the execution service (idempotent, daily limit).
 */
export const POST = route<{ applicationId: string }, typeof applicationApplySchema>({ body: applicationApplySchema }, async ({ userId, params, body, requestId }) =>
  applicationService.applyNow(userId, params.applicationId, { retry: body.retry, acknowledgeUncertain: body.acknowledgeUncertain }, requestId),
);
