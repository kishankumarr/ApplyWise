"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { useIsFetching, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import type { AutomationRunDetail, AutomationRunProviderDetail } from "@applywise/types";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  buttonVariants,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  cn,
  EmptyState,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  toast,
} from "@applywise/ui";
import { errorMessage } from "@/lib/api";
import { plural } from "@/lib/format";
import { RunModeBadge, RunStatusBadge, RunTriggerLabel } from "./run-badges";
import { LATE_RESULTS_POLL_MS, metricValueClass, RUN_METRIC_GROUPS, RUN_METRICS, RUN_POLL_MS, recentlyFinished, runPollInterval } from "./run-format";
import { fetchRun, refetchCachedOnMount, runDetailKey } from "./run-queries";
import { RunDuration, RunTimestamp, useNow } from "./run-time";
import { RunTimeline } from "./run-timeline";

/**
 * /automation/runs/[runId]: status and timing, counters, providers and the timeline. The summary comes with the page; the
 * timeline loads on its own, one page at a time. While the run is live both refresh (the summary and the page on screen).
 */
export function RunDetail({ initial }: { initial: AutomationRunDetail }) {
  const qc = useQueryClient();
  const { data: run, error, isError, refetch } = useQuery({
    queryKey: runDetailKey(initial.id),
    queryFn: () => fetchRun(initial.id),
    initialData: initial,
    refetchOnMount: refetchCachedOnMount,
    refetchInterval: (q) => (q.state.data ? runPollInterval([q.state.data]) : false),
  });
  // The summary or the timeline page on screen (both live under the run's detail key).
  const isFetching = useIsFetching({ queryKey: runDetailKey(initial.id) }) > 0;
  const now = useNow(LATE_RESULTS_POLL_MS);
  const running = run.status === "RUNNING";
  const settling = now != null && recentlyFinished(run, now);

  // Tell the user when a run they are watching finishes, and refresh what it changed (history, control centre, inbox).
  const lastStatus = useRef(run.status);
  useEffect(() => {
    const prev = lastStatus.current;
    lastStatus.current = run.status;
    if (prev !== "RUNNING" || run.status === "RUNNING") return;
    void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === "automation" && q.queryKey[2] !== "detail" });
    void qc.invalidateQueries({ queryKey: ["jobs"] });
    void qc.invalidateQueries({ queryKey: ["dashboard"] });
    if (run.status === "COMPLETED") {
      toast.success("Run finished", { description: `${plural(run.jobsFound, "job")} found, ${run.newJobs} new, ${run.applicationsPrepared} prepared so far.` });
    } else {
      toast.error("The run failed", { description: run.error ?? undefined });
    }
  }, [run, qc]);

  const statusText = running
    ? `In progress - this page updates every ${RUN_POLL_MS / 1000} seconds.`
    : run.status === "FAILED"
      ? "This run failed."
      : settling
        ? "Completed. Preparation and submission tasks may still be finishing, so the numbers can change for a few minutes."
        : "Completed.";

  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="space-y-4 p-5">
          <div className="flex flex-wrap items-center gap-2">
            <RunStatusBadge status={run.status} />
            <RunModeBadge mode={run.mode} />
            <Badge variant="outline" className="whitespace-nowrap">
              <RunTriggerLabel trigger={run.trigger} />
            </Badge>
            <div className="ml-auto flex items-center gap-2">
              {isFetching ? (
                <span className="text-xs text-muted-foreground" aria-hidden="true">
                  updating…
                </span>
              ) : null}
              <Button size="sm" variant="ghost" onClick={() => void qc.invalidateQueries({ queryKey: runDetailKey(run.id) })} disabled={isFetching}>
                <RefreshCw aria-hidden="true" /> Refresh
              </Button>
            </div>
          </div>
          <dl className="grid gap-4 sm:grid-cols-3">
            <div>
              <dt className="text-xs text-muted-foreground">Started</dt>
              <dd className="text-sm font-medium">
                <RunTimestamp iso={run.startedAt} />{" "}
                <RunTimestamp iso={run.startedAt} format="relative" className="text-xs font-normal text-muted-foreground" />
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Finished</dt>
              <dd className="text-sm font-medium">{run.completedAt ? <RunTimestamp iso={run.completedAt} /> : "Not yet"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Duration</dt>
              <dd className="text-sm font-medium tabular-nums">
                <RunDuration run={run} />
              </dd>
            </div>
          </dl>
          <p className="flex items-center gap-2 text-sm" aria-live="polite" data-testid="run-status-text">
            {running ? <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden="true" /> : null}
            {statusText}
          </p>
          {isError ? (
            <Alert variant="warning">
              <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
                <span>Could not refresh this run: {errorMessage(error)}</span>
                <Button size="sm" variant="outline" onClick={() => void refetch()}>
                  Try again
                </Button>
              </AlertDescription>
            </Alert>
          ) : null}
          {run.error ? (
            <Alert variant={run.status === "FAILED" ? "destructive" : "info"} role={run.status === "FAILED" ? "alert" : "note"}>
              <AlertTitle>{run.status === "FAILED" ? "Why the run failed" : "Note"}</AlertTitle>
              <AlertDescription>{run.error}</AlertDescription>
            </Alert>
          ) : null}
          {run.mode === "MANUAL" ? (
            <Alert variant="info" role="note">
              <AlertDescription>
                <strong>Manual mode:</strong> this run discovered, matched and prepared applications only. Nothing was submitted for you - you review each application and apply
                yourself.
              </AlertDescription>
            </Alert>
          ) : null}
        </CardContent>
      </Card>

      <section aria-labelledby="run-metrics-title" className="space-y-3">
        <h2 id="run-metrics-title" className="text-lg font-semibold">
          What happened
        </h2>
        {RUN_METRIC_GROUPS.map((g) => (
          <Card key={g.key}>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">{g.title}</CardTitle>
              <CardDescription>{g.description}</CardDescription>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-3">
                {RUN_METRICS.filter((m) => m.group === g.key).map((m) => (
                  <div key={m.key} className="rounded-md border p-3" data-testid={`run-metric-${m.key}`}>
                    <dt className="text-sm font-medium">{m.label}</dt>
                    <dd className={cn("text-2xl font-semibold tabular-nums", metricValueClass(m.tone, run[m.key]))}>{run[m.key]}</dd>
                    <dd className="mt-1 text-xs text-muted-foreground">{m.description}</dd>
                  </div>
                ))}
              </dl>
            </CardContent>
          </Card>
        ))}
      </section>

      <RunProviders providers={run.providers} running={running} />

      <RunTimeline runId={run.id} running={running} refetchInterval={runPollInterval([run])} />
    </div>
  );
}

function RunProviders({ providers, running }: { providers: AutomationRunProviderDetail[]; running: boolean }) {
  const total = providers.reduce(
    (t, p) => ({ fetched: t.fetched + p.fetched, created: t.created + p.created, merged: t.merged + p.merged, skipped: t.skipped + p.skipped, errors: t.errors + (p.error ? 1 : 0) }),
    { fetched: 0, created: 0, merged: 0, skipped: 0, errors: 0 },
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle>Providers</CardTitle>
        <CardDescription>
          Each job source checked in this run. Fetched: listings returned. Created: new jobs added to your inbox. Merged: the same job you already had, from this or another
          provider. Skipped: not relevant to your search.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {providers.length === 0 ? (
          <EmptyState
            title={running ? "Checking your job sources" : "No job sources were checked"}
            description={
              running ? "Provider results appear here when discovery finishes." : "None of your sources were due for a check in this run, or no sources are set up yet."
            }
            action={
              running ? undefined : (
                <Link href="/jobs/sources" className={cn(buttonVariants({ size: "sm", variant: "outline" }))}>
                  Manage job sources
                </Link>
              )
            }
          />
        ) : (
          <Table data-testid="run-providers">
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Provider</TableHead>
                <TableHead scope="col" className="text-right">
                  Fetched
                </TableHead>
                <TableHead scope="col" className="text-right">
                  Created
                </TableHead>
                <TableHead scope="col" className="text-right">
                  Merged
                </TableHead>
                <TableHead scope="col" className="text-right">
                  Skipped
                </TableHead>
                <TableHead scope="col">Result</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {providers.map((p, idx) => (
                <TableRow key={`${p.feedId ?? p.providerId}:${idx}`}>
                  <TableCell>
                    <div className="font-medium">{p.label}</div>
                    <div className="font-mono text-xs text-muted-foreground">{p.providerId}</div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{p.fetched}</TableCell>
                  <TableCell className={cn("text-right tabular-nums", p.created ? "font-semibold" : "text-muted-foreground")}>{p.created}</TableCell>
                  <TableCell className="text-right tabular-nums">{p.merged}</TableCell>
                  <TableCell className="text-right tabular-nums">{p.skipped}</TableCell>
                  <TableCell className="min-w-[10rem]">
                    {p.error ? (
                      <span className="text-sm text-destructive">
                        <span className="sr-only">Error: </span>
                        {p.error}
                      </span>
                    ) : (
                      <Badge variant="success">OK</Badge>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {providers.length > 1 ? (
                <TableRow className="bg-muted/30 font-medium hover:bg-muted/30">
                  <TableCell>Total ({plural(providers.length, "source")})</TableCell>
                  <TableCell className="text-right tabular-nums">{total.fetched}</TableCell>
                  <TableCell className="text-right tabular-nums">{total.created}</TableCell>
                  <TableCell className="text-right tabular-nums">{total.merged}</TableCell>
                  <TableCell className="text-right tabular-nums">{total.skipped}</TableCell>
                  <TableCell className={total.errors ? "text-destructive" : "text-muted-foreground"}>{total.errors ? `${plural(total.errors, "error")}` : "No errors"}</TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
