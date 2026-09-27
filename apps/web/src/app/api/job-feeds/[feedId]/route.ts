import { feedUpdateSchema } from "@applywise/validation";
import { route } from "@/server/http";
import { jobFeedsService } from "@/server/services/job-feeds.service";

/** PATCH: pause/resume, rename, change filters or the refresh interval. */
export const PATCH = route<{ feedId: string }, typeof feedUpdateSchema>({ body: feedUpdateSchema }, async ({ userId, params, body, requestId }) =>
  jobFeedsService.update(userId, params.feedId, body, requestId),
);

/** DELETE: remove the source (Gmail access is revoked). Jobs already found stay. */
export const DELETE = route<{ feedId: string }>({}, async ({ userId, params, requestId }) => jobFeedsService.remove(userId, params.feedId, requestId));
