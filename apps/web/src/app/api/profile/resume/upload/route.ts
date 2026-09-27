import { route } from "@/server/http";
import { Errors } from "@/server/errors";
import { RATE_LIMITS } from "@/server/rate-limit";
import { resumeService } from "@/server/services/resume.service";

export const POST = route({ rateLimit: RATE_LIMITS.upload, multipart: true }, async ({ req, userId, requestId }) => {
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) throw Errors.validation('Attach a PDF or DOCX file in the "file" field.');
  return resumeService.upload(userId, file, requestId);
});
