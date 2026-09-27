import type { RawImportedJob } from "../../connectors/types";
import type { FeedContext, FeedEnv } from "../types";
import { definedOnly } from "../util";

/** Build a RawImportedJob for a job-search API result. `raw` stays small: no payload copies. */
export function toSearchJob(input: {
  provider: string;
  id: string;
  attribution: string;
  sourceUrl: string | null;
  text: string;
  descriptionLevel: "FULL" | "SNIPPET";
  hints: RawImportedJob["hints"];
}): RawImportedJob {
  return {
    provider: "JOB_SEARCH_API",
    importMethod: "JOB_SEARCH_API",
    externalId: `${input.provider}:${input.id}`,
    sourceUrl: input.sourceUrl,
    attribution: input.attribution,
    raw: { kind: "job_search_api", provider: input.provider, id: input.id },
    text: input.text,
    descriptionLevel: input.descriptionLevel,
    hints: definedOnly(input.hints),
  };
}

export function feedEnv(ctx: FeedContext): FeedEnv {
  return ctx.env ?? (typeof process !== "undefined" ? process.env : {});
}

/** Pages needed for `limit` results, capped per provider to respect quotas. */
export function pageCount(limit: number, perPage: number, maxPages: number): number {
  return Math.max(1, Math.min(maxPages, Math.ceil(Math.max(1, limit) / perPage)));
}
