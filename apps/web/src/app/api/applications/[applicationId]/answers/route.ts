import { applicationAnswersSchema } from "@applywise/validation";
import { route } from "@/server/http";
import { provideInformation } from "@/server/services/application-routing.service";
import { applicationService } from "@/server/services/application.service";

/** POST: answer NEEDS_INFORMATION questions; answers are saved for reuse and the application resumes. */
export const POST = route<{ applicationId: string }, typeof applicationAnswersSchema>({ body: applicationAnswersSchema }, async ({ userId, params, body, requestId }) => {
  await applicationService.get(userId, params.applicationId);
  await provideInformation(userId, params.applicationId, body.answers, requestId);
  return applicationService.get(userId, params.applicationId);
});
