import { z } from "zod";
import { route } from "@/server/http";
import { extensionService } from "@/server/services/extension.service";

export const GET = route({}, async ({ userId }) => extensionService.listTokens(userId));

export const POST = route({ body: z.object({ name: z.string().trim().max(60).default("Browser extension") }) }, async ({ userId, body, requestId }) =>
  extensionService.createToken(userId, body.name, requestId),
);
