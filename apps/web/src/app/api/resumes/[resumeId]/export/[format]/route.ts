import { NextResponse } from "next/server";
import { route } from "@/server/http";
import { Errors } from "@/server/errors";
import { resumeService } from "@/server/services/resume.service";

const FORMATS = ["pdf", "docx", "txt", "html"] as const;

/** POST /api/resumes/[resumeId]/export/pdf|docx|txt|html - returns the file (not a JSON envelope). */
export const POST = route<{ resumeId: string; format: string }>({}, async ({ userId, params, requestId }) => {
  const format = params.format as (typeof FORMATS)[number];
  if (!FORMATS.includes(format)) throw Errors.validation("Unsupported export format.");
  const file = await resumeService.export(userId, params.resumeId, format, requestId);
  return new NextResponse(new Uint8Array(file.bytes), {
    headers: {
      "content-type": file.mimeType,
      "content-disposition": `attachment; filename="${file.fileName}"`,
      "cache-control": "private, no-store",
    },
  });
});
