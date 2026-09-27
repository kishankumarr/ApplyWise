"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { AutomationRunItemsPage, AutomationRunItemView } from "@applywise/types";
import { Alert, AlertDescription, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, cn, EmptyState, Input, Label, Skeleton } from "@applywise/ui";
import { Pager } from "@/components/pager";
import { api, errorMessage } from "@/lib/api";
import { plural } from "@/lib/format";
import { useDebouncedValue } from "@/lib/hooks";
import { RunOutcomeBadge } from "./run-badges";
import { type BadgeVariant, orderOutcomes, orderStages, RUN_ITEMS_PAGE_SIZE, runOutcome, runStage } from "./run-format";
import { runDetailKey } from "./run-queries";
import { localTime, useNow } from "./run-time";

const DOT: Record<BadgeVariant, string> = {
  default: "bg-primary",
  secondary: "bg-muted-foreground/50",
  outline: "bg-muted-foreground/50",
  destructive: "bg-destructive",
  success: "bg-emerald-500",
  warning: "bg-amber-500",
  info: "bg-sky-500",
};

interface TimelineFilters {
  page: number;
  stage: string | null;
  outcome: string | null;
  q: string;
}

/** Under the run's detail key, so invalidating the run (Refresh, "Run now") also refreshes the page of steps on screen. */
const runItemsKey = (runId: string, f: TimelineFilters) => [...runDetailKey(runId), "items", f] as const;

function fetchRunItems(runId: string, f: TimelineFilters): Promise<AutomationRunItemsPage> {
  const qs = new URLSearchParams({ page: String(f.page), pageSize: String(RUN_ITEMS_PAGE_SIZE) });
  if (f.stage) qs.set("stage", f.stage);
  if (f.outcome) qs.set("outcome", f.outcome);
  if (f.q) qs.set("q", f.q);
  return api<AutomationRunItemsPage>(`/api/automation/runs/${encodeURIComponent(runId)}/items?${qs.toString()}`);
}

/** Consecutive steps of one stage form a section: a page is in time order, and the stages mostly follow each other. */
function sections(items: AutomationRunItemView[]) {
  const out: { stage: string; items: AutomationRunItemView[] }[] = [];
  for (const i of items) {
    const last = out[out.length - 1];
    if (last?.stage === i.stage) last.items.push(i);
    else out.push({ stage: i.stage, items: [i] });
  }
  return out;
}

const sum = (counts: Record<string, number>) => Object.values(counts).reduce((n, c) => n + c, 0);

/**
 * The steps the run recorded, oldest first, one server page at a time, with stage and outcome filter chips (counted by the
 * server) and a search. It loads after the run summary; while the run is live only the page on screen is refreshed.
 */
export function RunTimeline({ runId, running, refetchInterval }: { runId: string; running: boolean; refetchInterval: number | false }) {
  const [stage, setStage] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const q = useDebouncedValue(search.trim());
  // A page number belongs to one combination of filters: changing a filter starts again at page 1.
  const filterKey = JSON.stringify([stage, outcome, q]);
  const [paging, setPaging] = useState({ filterKey, page: 1 });
  const page = paging.filterKey === filterKey ? paging.page : 1;
  const filters: TimelineFilters = { page, stage, outcome, q };
  const query = useQuery({
    queryKey: runItemsKey(runId, filters),
    queryFn: () => fetchRunItems(runId, filters),
    placeholderData: keepPreviousData,
    refetchInterval,
  });
  const data = query.data;
  const now = useNow();
  const top = useRef<HTMLDivElement>(null);

  const filtering = !!(stage || outcome || q);
  const goTo = (p: number) => {
    setPaging({ filterKey, page: p });
    top.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  };
  const clear = () => {
    setStage(null);
    setOutcome(null);
    setSearch("");
  };
  const retry = () => void query.refetch();

  return (
    <Card ref={top} className="scroll-mt-4">
      <CardHeader>
        <CardTitle>Timeline</CardTitle>
        <CardDescription>Every step the automation recorded in this run, oldest first, grouped by stage.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {!data ? (
          query.isError ? (
            <LoadError error={query.error} onRetry={retry} />
          ) : (
            <TimelineSkeleton />
          )
        ) : data.runTotal === 0 ? (
          <EmptyState
            title={running ? "Nothing recorded yet" : "No steps were recorded"}
            description={running ? "Steps appear here as the run checks your sources and evaluates jobs." : "This run did not check any source or evaluate any job."}
          />
        ) : (
          <>
            <div className="space-y-3">
              <div role="group" aria-label="Filter by stage" className="flex flex-wrap gap-2">
                <Chip label="All stages" count={sum(data.stages)} active={!stage} onClick={() => setStage(null)} />
                {orderStages([...Object.keys(data.stages), ...(stage ? [stage] : [])]).map((s) => {
                  const meta = runStage(s);
                  return <Chip key={s} label={meta.label} count={data.stages[s] ?? 0} active={stage === s} onClick={() => setStage(stage === s ? null : s)} title={meta.description} />;
                })}
              </div>
              <div role="group" aria-label="Filter by outcome" className="flex flex-wrap gap-2">
                <Chip label="All outcomes" count={sum(data.outcomes)} active={!outcome} onClick={() => setOutcome(null)} />
                {orderOutcomes([...Object.keys(data.outcomes), ...(outcome ? [outcome] : [])]).map((o) => {
                  const meta = runOutcome(o);
                  return (
                    <Chip
                      key={o}
                      label={meta.label}
                      count={data.outcomes[o] ?? 0}
                      active={outcome === o}
                      onClick={() => setOutcome(outcome === o ? null : o)}
                      title={meta.description}
                      dot={DOT[meta.variant]}
                    />
                  );
                })}
              </div>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <div className="sm:w-80">
                  <Label htmlFor="run-timeline-search" className="sr-only">
                    Search the timeline
                  </Label>
                  <Input id="run-timeline-search" type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search job, company or message" />
                </div>
                <p className="text-xs text-muted-foreground">{filtering ? `${plural(data.total, "matching step")} of ${data.runTotal}` : plural(data.runTotal, "step")}</p>
                {filtering ? (
                  <Button size="sm" variant="ghost" onClick={clear}>
                    Clear filters
                  </Button>
                ) : null}
              </div>
              <p className="sr-only" aria-live="polite">
                {filtering && !query.isPlaceholderData ? `${plural(data.total, "matching step")} of ${data.runTotal}.` : ""}
              </p>
            </div>

            {query.isError ? <LoadError error={query.error} onRetry={retry} refresh /> : null}

            <div className={cn("space-y-5 transition-opacity", query.isPlaceholderData && "opacity-60")} aria-busy={query.isPlaceholderData}>
              {data.items.length === 0 ? (
                data.total > 0 ? (
                  <EmptyState
                    title="No steps on this page"
                    action={
                      <Button size="sm" variant="outline" onClick={() => goTo(1)}>
                        First page
                      </Button>
                    }
                  />
                ) : (
                  <EmptyState
                    title="No steps match these filters"
                    description="Choose another stage or outcome, or change the search."
                    action={
                      <Button size="sm" variant="outline" onClick={clear}>
                        Clear filters
                      </Button>
                    }
                  />
                )
              ) : (
                <TimelineSections items={data.items} now={now} />
              )}
            </div>

            <Pager page={page} pageSize={data.pageSize} total={data.total} onPageChange={goTo} busy={query.isPlaceholderData} label="Timeline pages" />

            <details className="rounded-lg border px-4 py-3 text-sm">
              <summary className="cursor-pointer font-medium">What do these outcomes mean?</summary>
              <dl className="mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-2">
                {orderOutcomes(Object.keys(data.outcomes)).map((o) => {
                  const meta = runOutcome(o);
                  return (
                    <div key={o}>
                      <dt>
                        <RunOutcomeBadge outcome={o} />
                      </dt>
                      <dd className="mt-1 text-muted-foreground">{meta.description || "Recorded by the automation - see the message."}</dd>
                    </div>
                  );
                })}
              </dl>
            </details>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function TimelineSections({ items, now }: { items: AutomationRunItemView[]; now: number | null }) {
  const described = new Set<string>();
  return sections(items).map(({ stage: key, items: stageItems }, idx) => {
    const stage = runStage(key);
    const headingId = `run-stage-${idx}-${key.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
    // The stage's explanation once per page, not on every section of it.
    const describe = !!stage.description && !described.has(key);
    described.add(key);
    return (
      <section key={`${idx}:${key}`} aria-labelledby={headingId} className="space-y-2" data-testid="run-stage" data-stage={key}>
        <div>
          <h3 id={headingId} className="font-semibold">
            {stage.label}
          </h3>
          {describe ? <p className="text-xs text-muted-foreground">{stage.description}</p> : null}
        </div>
        <ol className="ml-1.5 border-l">
          {stageItems.map((i) => (
            <TimelineItem key={i.id} item={i} now={now} />
          ))}
        </ol>
      </section>
    );
  });
}

function TimelineSkeleton() {
  return (
    <div className="space-y-4" role="status">
      <span className="sr-only">Loading the timeline…</span>
      <div className="flex flex-wrap gap-2">
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-7 w-24 rounded-full" />
        ))}
      </div>
      <Skeleton className="h-10 w-full sm:w-80" />
      <div className="space-y-4">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="space-y-1.5 pl-5">
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-4 w-3/4" />
          </div>
        ))}
      </div>
    </div>
  );
}

function LoadError({ error, onRetry, refresh = false }: { error: unknown; onRetry: () => void; refresh?: boolean }) {
  return (
    <Alert variant="warning">
      <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
        <span>
          {refresh ? "Could not refresh the timeline" : "Could not load the timeline"}: {errorMessage(error)}
        </span>
        <Button size="sm" variant="outline" onClick={onRetry}>
          Try again
        </Button>
      </AlertDescription>
    </Alert>
  );
}

function Chip({ label, count, active, onClick, title, dot }: { label: string; count: number; active: boolean; onClick: () => void; title?: string; dot?: string }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      title={title || undefined}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        active ? "border-primary bg-primary text-primary-foreground" : "bg-background hover:bg-accent hover:text-accent-foreground",
      )}
    >
      {dot ? <span className={cn("h-2 w-2 rounded-full", dot)} aria-hidden="true" /> : null}
      {label}
      <span className={cn("rounded-full px-1.5 tabular-nums", active ? "bg-primary-foreground/20" : "bg-muted text-muted-foreground")}>{count}</span>
    </button>
  );
}

function TimelineItem({ item: i, now }: { item: AutomationRunItemView; now: number | null }) {
  const meta = runOutcome(i.outcome);
  const jobName = i.job ? `${i.job.title} at ${i.job.company}` : null;
  return (
    <li className="relative py-2.5 pl-5" data-testid="run-item" data-outcome={i.outcome}>
      <span className={cn("absolute -left-[5px] top-4 h-2.5 w-2.5 rounded-full ring-2 ring-card", DOT[meta.variant])} aria-hidden="true" />
      <div className="flex flex-wrap items-center gap-2">
        <RunOutcomeBadge outcome={i.outcome} />
        <time dateTime={i.createdAt} className="text-xs tabular-nums text-muted-foreground">
          {localTime(i.createdAt, now)}
        </time>
      </div>
      <p className="mt-1 break-words text-sm">{i.message}</p>
      {i.jobId || i.applicationId ? (
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs">
          {i.jobId ? (
            <Link href={`/jobs/${i.jobId}`} className="font-medium text-primary underline-offset-4 hover:underline">
              View job{jobName ? <span className="sr-only">: {jobName}</span> : null}
            </Link>
          ) : null}
          {i.applicationId ? (
            <Link href={`/applications/${i.applicationId}`} className="font-medium text-primary underline-offset-4 hover:underline">
              Open application{jobName ? <span className="sr-only"> for {jobName}</span> : null}
            </Link>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
