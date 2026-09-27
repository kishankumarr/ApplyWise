import { route } from "@/server/http";
import { RATE_LIMITS } from "@/server/rate-limit";
import { jobFeedsService } from "@/server/services/job-feeds.service";

/** POST: sync this source now (runs in the background). */
export const POST = route<{ feedId: string }>({ rateLimit: RATE_LIMITS.feedSync }, async ({ userId, params }) => jobFeedsService.syncNow(userId, params.feedId));
