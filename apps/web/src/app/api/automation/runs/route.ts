import { automationRunsQuerySchema } from "@applywise/validation";
import { route } from "@/server/http";
import { automationRunsService } from "@/server/services/automation-runs.service";

export const GET = route({ query: automationRunsQuerySchema }, async ({ userId, query }) => automationRunsService.list(userId, { limit: query.limit, cursor: query.cursor ?? null }));
