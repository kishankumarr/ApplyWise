import { applicationDeclineSchema } from "@applywise/validation";
import { route } from "@/server/http";
import { applicationService } from "@/server/services/application.service";

/** POST: decline (review queue "Reject") - the application is withdrawn and the job hidden. */
export const POST = route<{ applicationId: string }, typeof applicationDeclineSchema>({ body: applicationDeclineSchema }, async ({ userId, params, body, requestId }) =>
  applicationService.decline(userId, params.applicationId, body.reason, requestId),
);
