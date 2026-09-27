import { feedImapConnectSchema } from "@applywise/validation";
import { route } from "@/server/http";
import { RATE_LIMITS } from "@/server/rate-limit";
import { jobFeedsService } from "@/server/services/job-feeds.service";

/** POST: connect a mailbox with an app password (tested first; stored encrypted, never returned). */
export const POST = route({ body: feedImapConnectSchema, rateLimit: RATE_LIMITS.mailboxConnect }, async ({ userId, body, requestId }) =>
  jobFeedsService.connectImap(userId, body, requestId),
);
