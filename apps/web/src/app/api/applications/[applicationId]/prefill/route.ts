import { route } from "@/server/http";
import { extensionService } from "@/server/services/extension.service";

/** Issue a short-lived prefill code for the browser extension (approved applications only). */
export const POST = route<{ applicationId: string }>({}, async ({ userId, params, requestId }) => extensionService.issuePrefill(userId, params.applicationId, requestId));
