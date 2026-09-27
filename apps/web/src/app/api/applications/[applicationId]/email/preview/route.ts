import { emailPreviewSchema } from "@applywise/validation";
import { route } from "@/server/http";
import { emailService } from "@/server/services/email.service";

export const POST = route<{ applicationId: string }, typeof emailPreviewSchema>({ body: emailPreviewSchema }, async ({ userId, params, body, requestId }) =>
  emailService.preview(userId, params.applicationId, body, requestId),
);
