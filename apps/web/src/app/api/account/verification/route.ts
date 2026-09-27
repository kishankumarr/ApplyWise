import { route } from "@/server/http";
import { RATE_LIMITS } from "@/server/rate-limit";
import { emailVerificationService } from "@/server/services/email-verification.service";

/** GET: is the signed-in user's email confirmed? */
export const GET = route({}, async ({ userId }) => emailVerificationService.status(userId));

/** POST: (re)send the verification link to the account email. */
export const POST = route({ rateLimit: RATE_LIMITS.verifyEmail }, async ({ userId, requestId }) => emailVerificationService.send(userId, requestId));
