import { NextResponse, type NextRequest } from "next/server";
import { route } from "@/server/http";
import { extensionCorsHeaders, extensionService } from "@/server/services/extension.service";

/**
 * Manual handoffs for the browser extension: the signed-in user's applications that need a manual
 * application (newest first, at most 20). Read-only; returns job title/company/apply URL and the reason only.
 */
export const GET = route({ auth: "extension" }, async ({ userId }) => extensionService.listHandoffs(userId));

export function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: extensionCorsHeaders(req) });
}
