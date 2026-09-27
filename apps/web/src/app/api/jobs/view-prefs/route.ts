import { jobViewPrefsSchema } from "@applywise/validation";
import { route } from "@/server/http";
import { jobsService } from "@/server/services/jobs.service";

/** PATCH: show/hide demo jobs, or mark all current jobs as seen. */
export const PATCH = route({ body: jobViewPrefsSchema }, async ({ userId, body }) => jobsService.updateViewPrefs(userId, body));
