import { applicationResumeOverrideSchema } from "@applywise/validation";
import { route } from "@/server/http";
import { applicationService } from "@/server/services/application.service";
import { resumeSelectionService } from "@/server/services/resume-selection.service";

/** GET: every resume variant ranked for this job (why the selected one was chosen). */
export const GET = route<{ applicationId: string }>({}, async ({ userId, params }) => {
  const app = await applicationService.get(userId, params.applicationId);
  return { selection: app.resumeSelection, ranking: (await resumeSelectionService.rank(userId, app.job.id))?.ranking ?? [] };
});

/** PUT: override the selected resume (null = back to automatic selection). */
export const PUT = route<{ applicationId: string }, typeof applicationResumeOverrideSchema>({ body: applicationResumeOverrideSchema }, async ({ userId, params, body, requestId }) => {
  await resumeSelectionService.override(userId, params.applicationId, body.resumeId, requestId);
  return applicationService.get(userId, params.applicationId);
});
