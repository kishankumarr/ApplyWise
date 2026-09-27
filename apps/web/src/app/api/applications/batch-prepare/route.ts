import { batchPrepareSchema } from "@applywise/validation";
import { route } from "@/server/http";
import { RATE_LIMITS } from "@/server/rate-limit";
import { applicationService } from "@/server/services/application.service";

/** Prepare up to 10 applications asynchronously. Each still needs individual review and approval. */
export const POST = route({ rateLimit: RATE_LIMITS.ai, body: batchPrepareSchema }, async ({ userId, body, requestId }) =>
  applicationService.batchPrepare(userId, body.jobIds, requestId),
);
