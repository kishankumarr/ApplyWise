import { emailImportSchema } from "@applywise/validation";
import { route } from "@/server/http";
import { RATE_LIMITS } from "@/server/rate-limit";
import { jobsService } from "@/server/services/jobs.service";

export const POST = route({ rateLimit: RATE_LIMITS.jobImport, body: emailImportSchema }, async ({ userId, body, requestId }) =>
  jobsService.importEmail(userId, body.raw, requestId),
);
