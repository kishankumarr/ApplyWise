import { route } from "@/server/http";
import { demoService } from "@/server/services/demo.service";

/** Development only (ENABLE_DEMO_ADMIN=true). Re-seeds shared demo jobs. */
export const POST = route({}, async ({ userId, requestId }) => demoService.reset(userId, requestId));

export const GET = route({}, async () => demoService.status());
