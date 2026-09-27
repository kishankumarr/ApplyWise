import { automationRunItemsQuerySchema } from "@applywise/validation";
import { route } from "@/server/http";
import { automationRunsService } from "@/server/services/automation-runs.service";

/** GET: one page of the run's timeline (?page=&pageSize=50&stage=&outcome=&q=), oldest first, with stage/outcome counts. 404 unless the run is the user's. */
export const GET = route<{ runId: string }, undefined, typeof automationRunItemsQuerySchema>({ query: automationRunItemsQuerySchema }, async ({ userId, params, query }) =>
  automationRunsService.items(userId, params.runId, query),
);
