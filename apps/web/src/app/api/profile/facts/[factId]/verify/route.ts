import { factVerifySchema } from "@applywise/validation";
import { route } from "@/server/http";
import { profileService } from "@/server/services/profile.service";

export const POST = route<{ factId: string }, typeof factVerifySchema>({ body: factVerifySchema }, async ({ userId, params, body, requestId }) =>
  profileService.verifyFact(userId, params.factId, body.editedText, requestId),
);
