import { jobStateUpdateSchema } from "@applywise/validation";
import { route } from "@/server/http";
import { jobsService } from "@/server/services/jobs.service";

export const PATCH = route<{ jobId: string }, typeof jobStateUpdateSchema>({ body: jobStateUpdateSchema }, async ({ userId, params, body }) =>
  jobsService.setState(userId, params.jobId, body),
);
