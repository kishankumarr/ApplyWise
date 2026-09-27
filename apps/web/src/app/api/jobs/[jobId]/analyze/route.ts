import { route } from "@/server/http";
import { RATE_LIMITS } from "@/server/rate-limit";
import { jobsService } from "@/server/services/jobs.service";

export const POST = route<{ jobId: string }>({ rateLimit: RATE_LIMITS.ai }, async ({ userId, params, requestId }) => jobsService.analyze(userId, params.jobId, requestId));
