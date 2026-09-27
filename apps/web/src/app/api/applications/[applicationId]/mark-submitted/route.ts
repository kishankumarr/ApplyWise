import { markSubmittedSchema } from "@applywise/validation";
import { route } from "@/server/http";
import { applicationService } from "@/server/services/application.service";

/** The user states they submitted the application themselves on the official page. */
export const POST = route<{ applicationId: string }, typeof markSubmittedSchema>({ body: markSubmittedSchema }, async ({ userId, params, body, requestId }) =>
  applicationService.markSubmitted(userId, params.applicationId, body.note, requestId),
);
