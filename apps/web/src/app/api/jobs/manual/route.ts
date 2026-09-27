import { manualJobSchema } from "@applywise/validation";
import { route } from "@/server/http";
import { RATE_LIMITS } from "@/server/rate-limit";
import { jobsService } from "@/server/services/jobs.service";

export const POST = route({ rateLimit: RATE_LIMITS.jobImport, body: manualJobSchema }, async ({ userId, body, requestId }) =>
  jobsService.importManual(userId, body, requestId),
);
