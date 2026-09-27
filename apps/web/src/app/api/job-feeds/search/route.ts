import { feedSearchCreateSchema } from "@applywise/validation";
import { route } from "@/server/http";
import { jobFeedsService } from "@/server/services/job-feeds.service";

/** POST: add a saved search (job-search API). The first sync starts immediately. */
export const POST = route({ body: feedSearchCreateSchema }, async ({ userId, body, requestId }) => jobFeedsService.createSearch(userId, body, requestId));
