import { applicationUpdateSchema } from "@applywise/validation";
import { route } from "@/server/http";
import { applicationService } from "@/server/services/application.service";

export const GET = route<{ applicationId: string }>({}, async ({ userId, params }) => applicationService.get(userId, params.applicationId));

export const PATCH = route<{ applicationId: string }, typeof applicationUpdateSchema>({ body: applicationUpdateSchema }, async ({ userId, params, body, requestId }) =>
  applicationService.update(userId, params.applicationId, body, requestId),
);
