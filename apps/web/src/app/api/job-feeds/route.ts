import { route } from "@/server/http";
import { jobFeedsService } from "@/server/services/job-feeds.service";

/** GET: the user's automatic job sources, available providers, suggestions and setup guides. */
export const GET = route({}, async ({ userId }) => jobFeedsService.overview(userId));
