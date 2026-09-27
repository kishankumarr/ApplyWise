"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, RefreshCw, TriangleAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle, Button, Skeleton, toast } from "@applywise/ui";
import { errorMessage } from "@/lib/api";
import type { FeedView } from "@/lib/client-types";
import { plural, timeAgo, timeUntil } from "@/lib/format";
import { PageHeader } from "../page-header";
import { AlertsSection } from "./alerts-section";
import { CompaniesSection } from "./companies-section";
import { sourcesSummary } from "./feed-utils";
import { SearchesSection } from "./searches-section";
import { boostFeedPolling, useJobFeeds, useSyncAll } from "./use-job-feeds";

const EXPLAINER = "ApplyWise checks these sources for you every few hours and adds matching jobs to your inbox. You review and apply yourself - nothing is ever submitted automatically.";

/** Why the Gmail connection failed (the callback sends a fixed reason code; free text from the URL is never shown). */
const GMAIL_FAILED: Record<string, string> = {
  missing_scope: "Google did not give ApplyWise permission to read your job-alert emails. Try again and leave the Gmail permission ticked on Google's screen.",
  no_refresh_token:
    "Google did not give ApplyWise lasting access. Remove ApplyWise under Third-party apps and services in your Google Account (Security), then sign in again.",
  capacity: "You have already connected the maximum number of mailboxes. Remove one below, then connect Gmail again.",
  expired: "The Google sign-in expired or was started in another browser. Please try again.",
  forbidden: "That Google sign-in belongs to a different ApplyWise session. Please try again from this page.",
  other: "Could not connect Gmail. Please try again, or connect with an app password.",
};

function connectError(code: string, reason: string | null): string {
  if (code === "gmail_cancelled") return "Google sign-in was cancelled. Nothing was connected.";
  if (code === "gmail_not_configured") return "Google sign-in is not available on this server yet. Connect Gmail with an app password instead.";
  if (code.startsWith("gmail")) return (reason && Object.hasOwn(GMAIL_FAILED, reason) ? GMAIL_FAILED[reason] : undefined) ?? GMAIL_FAILED.other!;
  return "Could not connect the mailbox. Please try again.";
}

function StatusLine({ feeds }: { feeds: FeedView[] }) {
  if (feeds.length === 0) {
    return <p className="text-sm text-muted-foreground">You have no job sources yet. Start with your job alerts below - it takes about 5 minutes.</p>;
  }
  const last = feeds.reduce<string | null>((m, f) => (f.lastSyncAt && (!m || f.lastSyncAt > m) ? f.lastSyncAt : m), null);
  const next = feeds
    .filter((f) => (f.status === "ACTIVE" || f.status === "ERROR") && f.provider !== "forwarding" && f.nextSyncAt)
    .reduce<string | null>((m, f) => (!m || f.nextSyncAt! < m ? f.nextSyncAt : m), null);
  const syncing = feeds.filter((f) => f.syncing).length;
  const attention = feeds.filter((f) => f.status === "NEEDS_ATTENTION").length;
  const jobs = feeds.reduce((n, f) => n + (f.jobCount ?? 0), 0);
  return (
    <div className="flex flex-col gap-1 rounded-lg border bg-muted/30 px-4 py-3 text-sm sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-3" data-testid="sources-status">
      <span className="font-medium">{sourcesSummary(feeds)}</span>
      {syncing ? (
        <span className="flex items-center gap-1.5 text-sky-700 dark:text-sky-300">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> Checking {plural(syncing, "source")}...
        </span>
      ) : (
        <span className="text-muted-foreground">Last checked {timeAgo(last)}</span>
      )}
      {next && !syncing ? <span className="text-muted-foreground">Next check {timeUntil(next)}</span> : null}
      {jobs ? (
        <Link href="/jobs?sort=found" className="font-medium text-primary underline-offset-4 hover:underline">
          {plural(jobs, "job")} found so far
        </Link>
      ) : null}
      {attention ? (
        <span className="flex items-center gap-1.5 font-medium text-destructive">
          <TriangleAlert className="h-4 w-4" aria-hidden="true" /> {attention === 1 ? "1 source needs your attention" : `${attention} sources need your attention`}
        </span>
      ) : null}
    </div>
  );
}

export function SourcesSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true">
      <Skeleton className="h-10 w-72" />
      <Skeleton className="h-5 w-full max-w-2xl" />
      <Skeleton className="h-12 w-full" />
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} className="h-64 w-full" />
      ))}
    </div>
  );
}

export function JobSourcesPage() {
  const qc = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { data, isLoading, error, refetch, isRefetching } = useJobFeeds({ poll: true });
  const syncAll = useSyncAll();
  const [banner, setBanner] = useState<{ code: string; message: string } | null>(null);
  const handled = useRef(false);

  // Results of the Google sign-in redirect: /jobs/sources?connected=gmail or ?error=...&reason=<code>
  useEffect(() => {
    if (handled.current) return;
    const connected = params.get("connected");
    const err = params.get("error");
    if (!connected && !err) return;
    handled.current = true;
    if (connected) {
      toast.success(`${connected === "gmail" ? "Gmail" : "Mailbox"} connected. Checking your job alerts now - new jobs will appear in your inbox.`);
      boostFeedPolling(60_000);
      void qc.invalidateQueries({ queryKey: ["job-feeds"] });
    }
    if (err) {
      const msg = connectError(err, params.get("reason"));
      setBanner({ code: err, message: msg });
      toast.error(msg);
    }
    router.replace(pathname, { scroll: false });
  }, [params, router, pathname, qc]);

  // When a check finishes, refresh the inbox so new jobs show up everywhere.
  const wasSyncing = useRef(false);
  const syncingNow = !!data?.feeds.some((f) => f.syncing);
  useEffect(() => {
    if (wasSyncing.current && !syncingNow) void qc.invalidateQueries({ queryKey: ["jobs"] });
    wasSyncing.current = syncingNow;
  }, [syncingNow, qc]);

  if (isLoading) return <SourcesSkeleton />;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        title="Find jobs automatically"
        description={EXPLAINER}
        actions={
          <Button onClick={() => syncAll.mutate()} disabled={syncAll.isPending || !data?.feeds.length}>
            {syncAll.isPending ? <Loader2 className="animate-spin" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
            Sync all now
          </Button>
        }
      />

      {banner ? (
        <Alert variant="destructive">
          <AlertTitle>Mailbox not connected</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
            <span>
              {banner.message}
              {banner.code === "gmail_not_configured" && data?.operatorView ? " (Operator: set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env.)" : null}
            </span>
            <Button size="sm" variant="ghost" onClick={() => setBanner(null)}>
              Dismiss
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {error && !data ? (
        <Alert variant="destructive">
          <AlertTitle>Could not load your job sources</AlertTitle>
          <AlertDescription className="space-y-2">
            <p>{errorMessage(error)}</p>
            <Button size="sm" variant="outline" onClick={() => void refetch()} disabled={isRefetching}>
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {data ? (
        <>
          <StatusLine feeds={data.feeds} />
          {!data.hasProfilePrefs ? (
            <Alert variant="info">
              <AlertDescription>
                Tip: set your target roles and preferred cities in your{" "}
                <Link href="/profile" className="font-medium underline">
                  profile
                </Link>{" "}
                for better suggestions and fewer irrelevant jobs.
              </AlertDescription>
            </Alert>
          ) : null}
          <AlertsSection data={data} />
          <CompaniesSection data={data} />
          <SearchesSection data={data} />
        </>
      ) : null}
    </div>
  );
}
