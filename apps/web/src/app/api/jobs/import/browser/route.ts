import { NextResponse, type NextRequest } from "next/server";
import { browserImportSchema } from "@applywise/validation";
import { route } from "@/server/http";
import { RATE_LIMITS } from "@/server/rate-limit";
import { extensionCorsHeaders } from "@/server/services/extension.service";
import { jobsService } from "@/server/services/jobs.service";

/** User-triggered import from the browser extension (bearer extension token). */
export const POST = route({ auth: "extension", rateLimit: RATE_LIMITS.jobImport, body: browserImportSchema }, async ({ userId, body, requestId }) =>
  jobsService.importBrowser(userId, body, requestId),
);

export function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: extensionCorsHeaders(req) });
}
