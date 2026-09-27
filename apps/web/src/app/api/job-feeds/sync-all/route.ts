import { route } from "@/server/http";
import { RATE_LIMITS } from "@/server/rate-limit";
import { jobFeedsService } from "@/server/services/job-feeds.service";

/** POST: sync every active source now. */
export const POST = route({ rateLimit: RATE_LIMITS.feedSync }, async ({ userId }) => jobFeedsService.syncAll(userId));
