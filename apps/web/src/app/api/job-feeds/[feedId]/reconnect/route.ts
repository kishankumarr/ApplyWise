import { z } from "zod";
import { route } from "@/server/http";
import { RATE_LIMITS } from "@/server/rate-limit";
import { jobFeedsService } from "@/server/services/job-feeds.service";

const bodySchema = z.object({ appPassword: z.string().min(4, "Enter the app password").max(200) });

/** POST: replace the app password of a mailbox that needs attention (tested first, stored encrypted). */
export const POST = route<{ feedId: string }, typeof bodySchema>({ body: bodySchema, rateLimit: RATE_LIMITS.mailboxConnect }, async ({ userId, params, body, requestId }) =>
  jobFeedsService.reconnectImap(userId, params.feedId, body.appPassword, requestId),
);
