import { feedBoardCreateSchema } from "@applywise/validation";
import { route } from "@/server/http";
import { jobFeedsService } from "@/server/services/job-feeds.service";

/** POST: follow a company's public job board. */
export const POST = route({ body: feedBoardCreateSchema }, async ({ userId, body, requestId }) => jobFeedsService.createBoard(userId, body, requestId));
