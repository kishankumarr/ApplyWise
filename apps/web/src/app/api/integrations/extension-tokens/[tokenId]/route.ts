import { route } from "@/server/http";
import { extensionService } from "@/server/services/extension.service";

export const DELETE = route<{ tokenId: string }>({}, async ({ userId, params, requestId }) => extensionService.revokeToken(userId, params.tokenId, requestId));
