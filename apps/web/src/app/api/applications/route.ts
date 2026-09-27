import { applicationListQuerySchema } from "@applywise/validation";
import { route } from "@/server/http";
import { applicationService } from "@/server/services/application.service";

/**
 * GET: one page of applications (?page=&pageSize=, 25 per page by default) with the per-view counts;
 * ?view=active (default) | pipeline (automation-evaluated jobs) | all.
 */
export const GET = route({ query: applicationListQuerySchema }, async ({ userId, query }) => applicationService.list(userId, query));
