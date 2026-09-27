import { applicationSkipSchema } from "@applywise/validation";
import { route } from "@/server/http";
import { applicationService } from "@/server/services/application.service";

export const POST = route<{ applicationId: string }, typeof applicationSkipSchema>({ body: applicationSkipSchema }, async ({ userId, params, body }) =>
  applicationService.skip(userId, params.applicationId, body.days),
);
