import { route } from "@/server/http";
import { applicationService } from "@/server/services/application.service";

/** GET: the manual handoff package (job, URL, match explanation, resume, cover letter, answers, reason). */
export const GET = route<{ applicationId: string }>({}, async ({ userId, params }) => applicationService.handoff(userId, params.applicationId));
