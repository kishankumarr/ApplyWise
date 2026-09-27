import { jobListQuerySchema } from "@applywise/validation";
import { route } from "@/server/http";
import { jobsService } from "@/server/services/jobs.service";

export const GET = route({ query: jobListQuerySchema }, async ({ userId, query }) => jobsService.list(userId, query));
