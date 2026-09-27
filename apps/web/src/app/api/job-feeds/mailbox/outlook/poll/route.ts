import { z } from "zod";
import { route } from "@/server/http";
import { jobFeedsService } from "@/server/services/job-feeds.service";

const bodySchema = z.object({ flowToken: z.string().min(20).max(4000) });

/** POST: check whether the user finished the Microsoft sign-in; creates the source when done. */
export const POST = route({ body: bodySchema }, async ({ userId, body, requestId }) => jobFeedsService.outlookPoll(userId, body.flowToken, requestId));
