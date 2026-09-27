import { route } from "@/server/http";
import { automationRunsService } from "@/server/services/automation-runs.service";

export const GET = route<{ runId: string }>({}, async ({ userId, params }) => automationRunsService.get(userId, params.runId));
