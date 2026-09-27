import { z } from "zod";
import { route } from "@/server/http";
import { RATE_LIMITS } from "@/server/rate-limit";
import { emailVerificationService } from "@/server/services/email-verification.service";

const bodySchema = z.object({ token: z.string().min(20).max(2048) });

/**
 * POST: confirm the address from the page opened via the emailed link. Public (the link may be
 * opened in another browser); the signed token identifies the user. Same-origin is enforced by
 * the middleware, so a third-party page or a link prefetcher cannot confirm an address.
 */
export const POST = route({ auth: "public", rateLimit: RATE_LIMITS.verifyConfirm, body: bodySchema }, async ({ body, requestId }) =>
  emailVerificationService.verify(body.token, requestId),
);
