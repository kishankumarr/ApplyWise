import { accountDeleteSchema } from "@applywise/validation";
import { signOut } from "@/auth";
import { route } from "@/server/http";
import { accountService } from "@/server/services/account.service";

export const POST = route({ body: accountDeleteSchema }, async ({ userId, requestId }) => {
  const result = await accountService.delete(userId, requestId);
  await signOut({ redirect: false }).catch(() => undefined);
  return result;
});
