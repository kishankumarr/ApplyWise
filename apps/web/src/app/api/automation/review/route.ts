import { reviewQueueQuerySchema } from "@applywise/validation";
import { route } from "@/server/http";
import { reviewQueueService } from "@/server/services/review-queue.service";

/** GET: one page of the review queue (?page=&pageSize=, 10 per page by default) - applications waiting for the user's decision, best matches first. */
export const GET = route({ query: reviewQueueQuerySchema }, async ({ userId, query }) =>
  reviewQueueService.page(userId, query),
);
