"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Loader2, RefreshCw } from "lucide-react";
import type { AutomationRunSummary } from "@applywise/types";
import {
  Alert,
  AlertDescription,
  Button,
  buttonVariants,
  Card,
  CardContent,
  cn,
  EmptyState,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@applywise/ui";
import { errorMessage } from "@/lib/api";
import { plural } from "@/lib/format";
import { RunModeBadge, RunStatusBadge, RunTriggerLabel } from "./run-badges";
import { metricValueClass, modeLabel, RUN_POLL_MS, RUN_TABLE_METRICS, runMetric, runPollInterval, RUNS_PAGE_SIZE } from "./run-format";
import { fetchRunsPage, refetchCachedOnMount, RUNS_HISTORY_KEY, type RunsPage } from "./run-queries";
import { localDateTime, relativeTime, RunDuration, useNow } from "./run-time";

const METRICS = RUN_TABLE_METRICS.map(runMetric);
const runHref = (id: string) => `/automation/runs/${id}`;

/** /automation/runs: every run, newest first, with "Load more" and live refresh while a run is in progress. */
export function RunsHistory({ initial }: { initial: RunsPage }) {
  const query = useInfiniteQuery({
    queryKey: RUNS_HISTORY_KEY,
    queryFn: ({ pageParam }) => fetchRunsPage(pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    initialData: { pages: [initial], pageParams: [null] },
    refetchOnMount: refetchCachedOnMount,
    refetchInterval: (q) => runPollInterval(q.state.data?.pages.flatMap((p) => p.runs) ?? []),
  });
  const now = useNow(30_000);

  const runs = useMemo(() => {
    const seen = new Set<string>();
    const out: AutomationRunSummary[] = [];
    for (const page of query.data?.pages ?? []) {
      for (const r of page.runs) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        out.push(r);
      }
    }
    return out;
  }, [query.data]);
  const running = runs.some((r) => r.status === "RUNNING");

  if (runs.length === 0) {
    return (
      <div className="space-y-3">
        {query.isError ? <LoadError error={query.error} onRetry={() => void query.refetch()} /> : null}
        <EmptyState
          title="No automation runs yet"
          description="A run checks your job sources, scores new jobs against your rules and prepares applications. Runs start on your schedule when automation is on, or whenever you choose Run now."
          action={
            <Link href="/automation" className={cn(buttonVariants({ size: "sm" }))}>
              Go to Automation to run now
            </Link>
          }
        />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 px-1">
        <p id="runs-status" className="text-xs text-muted-foreground" aria-live="polite">
          {plural(runs.length, "run")} shown
          {running ? ` · a run is in progress - updating every ${RUN_POLL_MS / 1000} seconds` : ""}
        </p>
        <div className="flex items-center gap-2">
          {query.isFetching && !query.isFetchingNextPage ? (
            <span className="text-xs text-muted-foreground" aria-hidden="true">
              updating…
            </span>
          ) : null}
          <Button size="sm" variant="ghost" onClick={() => void query.refetch()} disabled={query.isFetching}>
            <RefreshCw aria-hidden="true" /> Refresh
          </Button>
        </div>
      </div>

      {query.isError ? <LoadError error={query.error} more={query.isFetchNextPageError} onRetry={() => void (query.isFetchNextPageError ? query.fetchNextPage() : query.refetch())} /> : null}

      {/* Wide screens: the full table (scrolls sideways inside the card, the start time stays pinned). */}
      <Card className="hidden lg:block">
        <Table data-testid="runs-table">
          <caption className="sr-only">Automation runs, newest first</caption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col" className="sticky left-0 z-10 bg-card">
                Started
              </TableHead>
              <TableHead scope="col">Trigger</TableHead>
              <TableHead scope="col">Mode</TableHead>
              <TableHead scope="col">Status</TableHead>
              <TableHead scope="col" className="text-right">
                Duration
              </TableHead>
              {METRICS.map((m) => (
                <TableHead key={m.key} scope="col" className="whitespace-nowrap text-right" title={m.description}>
                  {m.short}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {runs.map((r) => (
              <TableRow key={r.id} data-testid="run-row" data-status={r.status}>
                <TableCell className="sticky left-0 z-10 whitespace-nowrap bg-card">
                  <Link href={runHref(r.id)} className="font-medium hover:underline">
                    <span className="sr-only">View run started </span>
                    <time dateTime={r.startedAt}>{localDateTime(r.startedAt, now)}</time>
                  </Link>
                  <div className="text-xs text-muted-foreground">{relativeTime(r.startedAt, now)}</div>
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  <RunTriggerLabel trigger={r.trigger} />
                </TableCell>
                <TableCell>
                  <RunModeBadge mode={r.mode} />
                </TableCell>
                <TableCell>
                  <RunStatusBadge status={r.status} />
                  {r.error ? (
                    <p className={cn("mt-1 max-w-[14rem] truncate text-xs", r.status === "FAILED" ? "text-destructive" : "text-muted-foreground")} title={r.error}>
                      {r.error}
                    </p>
                  ) : null}
                </TableCell>
                <TableCell className="whitespace-nowrap text-right tabular-nums">
                  <RunDuration run={r} />
                </TableCell>
                {METRICS.map((m) => (
                  <TableCell key={m.key} className={cn("text-right tabular-nums", metricValueClass(m.tone, r[m.key]))}>
                    {r[m.key]}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      {/* Narrow screens: one card per run. */}
      <ul className="space-y-3 lg:hidden" aria-label="Automation runs, newest first">
        {runs.map((r) => (
          <li key={r.id}>
            <Card>
              <CardContent className="space-y-3 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <Link href={runHref(r.id)} className="font-medium hover:underline">
                      <span className="sr-only">View run started </span>
                      <time dateTime={r.startedAt}>{localDateTime(r.startedAt, now)}</time>
                    </Link>
                    <p className="text-xs text-muted-foreground">
                      <RunTriggerLabel trigger={r.trigger} /> · {modeLabel(r.mode)} mode · <RunDuration run={r} />
                    </p>
                  </div>
                  <RunStatusBadge status={r.status} className="shrink-0" />
                </div>
                {r.error ? <p className={cn("text-xs", r.status === "FAILED" ? "text-destructive" : "text-muted-foreground")}>{r.error}</p> : null}
                <dl className="grid grid-cols-3 gap-x-3 gap-y-2 sm:grid-cols-4">
                  {METRICS.map((m) => (
                    <div key={m.key}>
                      <dt className="text-xs text-muted-foreground">{m.short}</dt>
                      <dd className={cn("text-sm tabular-nums", metricValueClass(m.tone, r[m.key]))}>{r[m.key]}</dd>
                    </div>
                  ))}
                </dl>
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>

      <div className="flex flex-col items-center gap-2">
        {query.hasNextPage ? (
          <Button variant="outline" onClick={() => void query.fetchNextPage()} disabled={query.isFetchingNextPage} aria-describedby="runs-status" data-testid="runs-load-more">
            {query.isFetchingNextPage ? (
              <>
                <Loader2 className="animate-spin" aria-hidden="true" /> Loading…
              </>
            ) : (
              "Load more runs"
            )}
          </Button>
        ) : runs.length > RUNS_PAGE_SIZE ? (
          <p className="text-xs text-muted-foreground">That is every run.</p>
        ) : null}
      </div>

      <details className="rounded-lg border px-4 py-3 text-sm">
        <summary className="cursor-pointer font-medium">What do these numbers mean?</summary>
        <dl className="mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-2">
          {METRICS.map((m) => (
            <div key={m.key}>
              <dt className="font-medium">{m.short === m.label ? m.label : `${m.short} (${m.label})`}</dt>
              <dd className="text-muted-foreground">{m.description}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 text-xs text-muted-foreground">
          Preparation and submission can finish shortly after a run completes, so the latest run&apos;s numbers may still grow for a few minutes.
        </p>
      </details>
    </div>
  );
}

function LoadError({ error, more = false, onRetry }: { error: unknown; more?: boolean; onRetry: () => void }) {
  return (
    <Alert variant="warning">
      <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
        <span>
          {more ? "Could not load more runs" : "Could not refresh the run history"}: {errorMessage(error)}
        </span>
        <Button size="sm" variant="outline" onClick={onRetry}>
          Try again
        </Button>
      </AlertDescription>
    </Alert>
  );
}
