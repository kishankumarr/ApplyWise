import { route } from "@/server/http";
import { RATE_LIMITS } from "@/server/rate-limit";
import { resumeService } from "@/server/services/resume.service";

export const POST = route<{ resumeId: string }>({ rateLimit: RATE_LIMITS.ai }, async ({ userId, params, requestId }) =>
  resumeService.requestParse(userId, params.resumeId, requestId),
);
