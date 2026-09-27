import { addSkillSchema } from "@applywise/validation";
import { route } from "@/server/http";
import { profileService } from "@/server/services/profile.service";

export const POST = route({ body: addSkillSchema }, async ({ userId, body, requestId }) => profileService.addSkill(userId, body.name, requestId));
