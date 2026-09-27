import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { route } from "@/server/http";
import { extensionCorsHeaders, extensionService } from "@/server/services/extension.service";

/** Resolve a short-lived prefill code into the user-approved fields. Read-only; never submits. */
export const GET = route({ auth: "extension", query: z.object({ code: z.string().min(10).max(2000) }) }, async ({ userId, query }) =>
  extensionService.resolvePrefill(userId, query.code),
);

export function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: extensionCorsHeaders(req) });
}
