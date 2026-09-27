import { NextResponse } from "next/server";
import { route } from "@/server/http";
import { resumeService } from "@/server/services/resume.service";

/** Authenticated download - private files are never exposed via public URLs. */
export const GET = route<{ resumeId: string }>({}, async ({ userId, params, requestId }) => {
  const file = await resumeService.download(userId, params.resumeId, requestId);
  return new NextResponse(new Uint8Array(file.bytes), {
    headers: {
      "content-type": file.mimeType,
      "content-disposition": `attachment; filename="${file.fileName.replace(/"/g, "")}"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
});
