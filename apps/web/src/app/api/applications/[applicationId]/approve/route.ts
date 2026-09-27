import { approveApplicationSchema } from "@applywise/validation";
import { route } from "@/server/http";
import { applicationService } from "@/server/services/application.service";

export const POST = route<{ applicationId: string }, typeof approveApplicationSchema>({ body: approveApplicationSchema }, async ({ userId, params, requestId }) =>
  applicationService.approve(userId, params.applicationId, requestId),
);
