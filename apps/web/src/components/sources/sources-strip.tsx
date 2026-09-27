"use client";

import Link from "next/link";
import { Loader2, Radar, RefreshCw, TriangleAlert } from "lucide-react";
import { Button, buttonVariants, cn } from "@applywise/ui";
import type { JobSourcesSummary } from "@/lib/client-types";
import { plural, timeAgo } from "@/lib/format";
import { GetJobsCta } from "./get-jobs-cta";
import { useSyncAll } from "./use-job-feeds";

/** Inbox header strip: sources status + "Sync now", or the setup call-to-action when there are none. */
export function SourcesStrip({ sources }: { sources: JobSourcesSummary }) {
  const syncAll = useSyncAll();
  if (sources.total === 0) return <GetJobsCta compact />;
  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-muted/30 px-4 py-3 sm:flex-row sm:items-center sm:justify-between" data-testid="sources-strip">
      <div className="min-w-0 space-y-1 text-sm">
        <p className="flex flex-wrap items-center gap-x-2">
          <Radar className="h-4 w-4 text-primary" aria-hidden="true" />
          <span className="font-medium">{plural(sources.active, "source")} active</span>
          <span className="text-muted-foreground">· last checked {timeAgo(sources.lastSyncAt)}</span>
        </p>
        {sources.needsAttention > 0 ? (
          <p className="flex items-center gap-1.5 text-destructive">
            <TriangleAlert className="h-4 w-4 shrink-0" aria-hidden="true" />
            <Link href="/jobs/sources" className="underline underline-offset-4">
              {sources.needsAttention === 1 ? "1 source needs your attention" : `${sources.needsAttention} sources need your attention`}
            </Link>
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => syncAll.mutate()} disabled={syncAll.isPending}>
          {syncAll.isPending ? <Loader2 className="animate-spin" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
          Sync now
        </Button>
        <Link href="/jobs/sources" className={cn(buttonVariants({ size: "sm", variant: "ghost" }))}>
          Manage sources
        </Link>
      </div>
    </div>
  );
}
