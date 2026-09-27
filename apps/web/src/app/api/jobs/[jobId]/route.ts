import { route } from "@/server/http";
import { jobsService } from "@/server/services/jobs.service";

export const GET = route<{ jobId: string }>({}, async ({ userId, params }) => jobsService.get(userId, params.jobId));
