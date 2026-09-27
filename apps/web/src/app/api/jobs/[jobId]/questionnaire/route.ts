import { route } from "@/server/http";
import { RATE_LIMITS } from "@/server/rate-limit";
import { questionnaireService } from "@/server/services/questionnaire.service";

export const GET = route<{ jobId: string }>({}, async ({ userId, params }) => questionnaireService.get(userId, params.jobId));

/** Generate (or return the existing) questionnaire. Pass ?regenerate=true to replace it. */
export const POST = route<{ jobId: string }>({ rateLimit: RATE_LIMITS.ai }, async ({ req, userId, params, requestId }) =>
  questionnaireService.generate(userId, params.jobId, { regenerate: req.nextUrl.searchParams.get("regenerate") === "true", requestId }),
);
