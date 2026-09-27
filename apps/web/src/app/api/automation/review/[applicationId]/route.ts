import { route } from "@/server/http";
import { reviewQueueService } from "@/server/services/review-queue.service";

/** GET: the review view of one application (how it would be sent, warnings, answers) without loading the whole queue. */
export const GET = route<{ applicationId: string }>({}, async ({ userId, params }) =>
  reviewQueueService.item(userId, params.applicationId),
);
