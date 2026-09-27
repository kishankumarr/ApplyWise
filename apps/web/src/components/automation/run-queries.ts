import type { AutomationRunDetail, AutomationRunSummary } from "@applywise/types";
import { api } from "@/lib/api";
import { RUNS_PAGE_SIZE } from "./run-format";

export interface RunsPage {
  runs: AutomationRunSummary[];
  nextCursor: string | null;
}

/**
 * Query keys. Both live under ["automation", "runs"], so invalidating ["automation"] or ["automation", "runs"]
 * (e.g. after "Run now") refreshes the history and any open run.
 */
export const RUNS_HISTORY_KEY = ["automation", "runs", "history"] as const;
export const runDetailKey = (runId: string) => ["automation", "runs", "detail", runId] as const;

/**
 * Pages pass fresh server data as `initialData`, which TanStack ignores when a cached copy already exists (e.g. after
 * navigating away and back). Refetch on mount in that case only - not right after the server render.
 */
export const refetchCachedOnMount = (q: { state: { dataUpdatedAt: number } }) => (Date.now() - q.state.dataUpdatedAt > 2_000 ? "always" : false) as "always" | false;

export function fetchRunsPage(cursor: string | null): Promise<RunsPage> {
  const qs = new URLSearchParams({ limit: String(RUNS_PAGE_SIZE) });
  if (cursor) qs.set("cursor", cursor);
  return api<RunsPage>(`/api/automation/runs?${qs.toString()}`);
}

export function fetchRun(runId: string): Promise<AutomationRunDetail> {
  return api<AutomationRunDetail>(`/api/automation/runs/${encodeURIComponent(runId)}`);
}
