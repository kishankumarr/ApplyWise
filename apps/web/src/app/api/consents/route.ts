import { consentUpdateSchema } from "@applywise/validation";
import { route } from "@/server/http";
import { consentService } from "@/server/services/consent.service";

export const GET = route({}, async ({ userId }) => consentService.get(userId));

export const PATCH = route({ body: consentUpdateSchema }, async ({ userId, body, requestId }) => consentService.update(userId, body, requestId));
