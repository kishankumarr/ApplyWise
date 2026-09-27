import { route } from "@/server/http";
import { profileService } from "@/server/services/profile.service";

export const POST = route({}, async ({ userId, requestId }) => profileService.verifyAll(userId, requestId));
