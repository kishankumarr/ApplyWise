import { route } from "@/server/http";
import { jobFeedsService } from "@/server/services/job-feeds.service";

/** POST: create (or return) the user's private forwarding address for job-alert emails. */
export const POST = route({}, async ({ userId, requestId }) => jobFeedsService.createForwarding(userId, requestId));
