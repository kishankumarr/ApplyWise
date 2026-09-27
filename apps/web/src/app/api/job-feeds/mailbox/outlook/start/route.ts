import { z } from "zod";
import { route } from "@/server/http";
import { RATE_LIMITS } from "@/server/rate-limit";
import { jobFeedsService } from "@/server/services/job-feeds.service";

const bodySchema = z.object({
  email: z.email().max(254),
  consent: z.literal(true, { error: "Confirm that ApplyWise may read job-alert emails in this mailbox" }),
});

/** POST: start Microsoft sign-in with a one-time code (the user enters it at microsoft.com/devicelogin). */
export const POST = route({ body: bodySchema, rateLimit: RATE_LIMITS.mailboxConnect }, async ({ userId, body }) => jobFeedsService.outlookStart(userId, body.email));
