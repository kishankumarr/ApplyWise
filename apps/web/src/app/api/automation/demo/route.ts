import { route } from "@/server/http";
import { demoAutomationService } from "@/server/services/demo-automation.service";

/** POST: add the fictional demo provider (DEMO CONTENT), connect it and run the real pipeline once. */
export const POST = route({}, async ({ userId, requestId }) => demoAutomationService.setup(userId, { run: true }, requestId));
