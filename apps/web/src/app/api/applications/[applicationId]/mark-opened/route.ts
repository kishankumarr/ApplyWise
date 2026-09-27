import { route } from "@/server/http";
import { applicationService } from "@/server/services/application.service";

/** Records that the user opened the official apply page. Returns the URL for the client to open. */
export const POST = route<{ applicationId: string }>({}, async ({ userId, params, requestId }) => applicationService.markOpened(userId, params.applicationId, requestId));
