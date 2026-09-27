import { emailSendSchema } from "@applywise/validation";
import { route } from "@/server/http";
import { RATE_LIMITS } from "@/server/rate-limit";
import { emailService } from "@/server/services/email.service";

/** Requires the preview confirmation token + explicit confirmation + consent. */
export const POST = route<{ applicationId: string }, typeof emailSendSchema>({ rateLimit: RATE_LIMITS.emailSend, body: emailSendSchema }, async ({ userId, params, body, requestId }) =>
  emailService.requestSend(userId, params.applicationId, body, requestId),
);
