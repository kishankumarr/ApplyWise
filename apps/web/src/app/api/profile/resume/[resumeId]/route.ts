import { resumeVariantSchema } from "@applywise/validation";
import { route } from "@/server/http";
import { resumeService } from "@/server/services/resume.service";

/** PATCH: label a resume variant and its target roles (used by automatic resume selection). */
export const PATCH = route<{ resumeId: string }, typeof resumeVariantSchema>({ body: resumeVariantSchema }, async ({ userId, params, body }) =>
  resumeService.updateVariant(userId, params.resumeId, body),
);
