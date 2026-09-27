import { route } from "@/server/http";
import { RATE_LIMITS } from "@/server/rate-limit";
import { applicationService } from "@/server/services/application.service";

/** Generates drafts for review. Never submits an application. */
export const POST = route<{ jobId: string }>({ rateLimit: RATE_LIMITS.ai }, async ({ userId, params, requestId }) =>
  applicationService.prepare(userId, params.jobId, requestId),
);
