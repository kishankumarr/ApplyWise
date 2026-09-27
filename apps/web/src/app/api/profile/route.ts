import { profileUpdateSchema } from "@applywise/validation";
import { route } from "@/server/http";
import { profileService } from "@/server/services/profile.service";

export const GET = route({}, async ({ userId }) => profileService.getView(userId));

export const PATCH = route({ body: profileUpdateSchema }, async ({ userId, body, requestId }) => profileService.update(userId, body, requestId));
