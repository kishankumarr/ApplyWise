import { signUpSchema } from "@applywise/validation";
import { route } from "@/server/http";
import { RATE_LIMITS } from "@/server/rate-limit";
import { authService } from "@/server/services/auth.service";

export const POST = route({ auth: "public", rateLimit: RATE_LIMITS.auth, body: signUpSchema }, async ({ body, requestId }) => {
  return authService.signUp(body, requestId);
});
