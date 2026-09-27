import { route } from "@/server/http";
import { profileService } from "@/server/services/profile.service";

export const POST = route<{ factId: string }>({}, async ({ userId, params, requestId }) => profileService.rejectFact(userId, params.factId, requestId));
