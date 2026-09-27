import { route } from "@/server/http";
import { automationOrchestrator } from "@/server/services/automation-orchestrator.service";

/** POST: "Run now" - discovery, matching, rules and routing for this user (one run at a time). */
export const POST = route({}, async ({ userId, requestId }) => automationOrchestrator.runNow(userId, "manual", requestId));
