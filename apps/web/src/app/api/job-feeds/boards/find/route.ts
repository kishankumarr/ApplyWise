import { feedBoardFindSchema } from "@applywise/validation";
import { route } from "@/server/http";
import { RATE_LIMITS } from "@/server/rate-limit";
import { jobFeedsService } from "@/server/services/job-feeds.service";

/** POST: company name or careers URL -> matching public job boards (checked live, nothing saved). */
export const POST = route({ body: feedBoardFindSchema, rateLimit: RATE_LIMITS.feedLookup }, async ({ body }) => ({ boards: await jobFeedsService.findBoards(body.query) }));
