"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { keepPreviousData, useIsMutating, useQuery } from "@tanstack/react-query";
import { AlertTriangle, Info, RefreshCw } from "lucide-react";
import { APPLICATION_MODE_DESCRIPTIONS, APPLICATION_MODE_LABELS, type ApplicationMode } from "@applywise/types";
import { Alert, AlertDescription, AlertTitle, Button, buttonVariants, cn, EmptyState, Skeleton } from "@applywise/ui";
import { Pager, pageCountOf } from "@/components/pager";
import { api, errorMessage } from "@/lib/api";
import { plural } from "@/lib/format";
import { PageHeader } from "../page-header";
import { ReviewCard } from "./review-card";
import { REVIEW_PAGE_SIZE, reviewPageHref, reviewPageParam } from "./review-paging";
import { REVIEW_QUEUE_KEY, titleIdFor, type ReviewContext, type ReviewQueuePage } from "./review-shared";

/** How long the queue is polled after answers were given (the application is prepared again and returns). */
const WATCH_MS = 90_000;
const QUEUE_ANCHOR_ID = "review-queue";

const MODE_NOTE: Record<ApplicationMode, string> = {
  MANUAL: "Nothing is ever submitted for you: approve the prepared content here, then apply on the official page yourself.",
  REVIEW: "Nothing is submitted before you approve it here. Jobs whose provider does not support automatic submission are handed to you instead.",
  AUTO: "The applications below did not meet every auto-apply condition, so they wait for your decision.",
};

/**
 * The queue, one page of cards at a time (the server ranks the whole queue, best matches first). The page lives in
 * the address (/review?page=2) so refresh and back work; paging updates the address in place (no server render of
 * the page) and loads the new page from the API while the current one stays on screen.
 */
export function ReviewQueue({
  initial,
  settingsMode,
  tailorResume,
  providerLabels,
}: {
  /** The page the server rendered (the last page when the address asked for one past the end). */
  initial: ReviewQueuePage;
  settingsMode: ApplicationMode;
  tailorResume: boolean;
  providerLabels: Record<string, string>;
}) {
  const params = useSearchParams();
  const urlPage = reviewPageParam(params.get("page"));
  // The server may serve another page than the address asks for (one past the end -> the last page). `at`: the
  // server data counts as fresh from when it arrived, not from whenever its cache entry is created again.
  const [served] = useState(() => ({ asked: urlPage, page: initial.page, at: Date.now() }));
  const page = urlPage === served.asked ? served.page : urlPage;

  const [watching, setWatching] = useState(false);
  const watchTimer = useRef<number | undefined>(undefined);
  // A poll while a card's request is in flight would bring the card back until the request lands.
  const acting = useIsMutating({ mutationKey: REVIEW_QUEUE_KEY }) > 0;
  const query = useQuery({
    queryKey: [...REVIEW_QUEUE_KEY, page],
    queryFn: () => api<ReviewQueuePage>(`/api/automation/review?page=${page}&pageSize=${REVIEW_PAGE_SIZE}`),
    initialData: page === initial.page ? initial : undefined,
    initialDataUpdatedAt: served.at,
    placeholderData: keepPreviousData,
    refetchOnWindowFocus: true,
    // Only the page on screen is polled; TanStack pauses the interval while the tab is hidden.
    refetchInterval: acting ? false : watching ? 4_000 : 60_000,
  });
  const data = query.data;
  const items = useMemo(() => data?.items ?? [], [data]);
  const total = data?.total ?? 0;
  const pageSize = data?.pageSize ?? REVIEW_PAGE_SIZE;
  const switching = query.isPlaceholderData;

  const goTo = useCallback((next: number, how: "push" | "replace" = "push") => {
    // Next.js syncs useSearchParams with the native History API, without rendering the server page again.
    if (how === "push") window.history.pushState(null, "", reviewPageHref(next));
    else window.history.replaceState(null, "", reviewPageHref(next));
  }, []);
  const onPageChange = (next: number) => {
    goTo(next);
    const top = document.getElementById(QUEUE_ANCHOR_ID);
    top?.focus({ preventScroll: true });
    top?.scrollIntoView({ block: "start" });
  };

  // Correct the address when the server served another page than asked (past the end, or not a page number).
  useEffect(() => {
    const raw = new URLSearchParams(window.location.search).get("page");
    if (raw !== null && raw !== String(served.page)) goTo(served.page, "replace");
  }, [served.page, goTo]);

  // The page ran out (its last cards were handled, or the queue shrank): go back to the last page that has cards.
  useEffect(() => {
    if (!data || switching || data.items.length > 0 || page <= 1) return;
    const lastPage = pageCountOf(data.total, data.pageSize);
    if (page > lastPage) goTo(lastPage, "replace");
  }, [data, switching, page, goTo]);

  // Keyboard focus follows the queue: when a card leaves, focus the next card's title on this page (or the queue itself).
  const itemsRef = useRef(items);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);
  useEffect(() => () => window.clearTimeout(watchTimer.current), []);
  const onLeave = useCallback((applicationId: string) => {
    const list = itemsRef.current;
    const idx = list.findIndex((i) => i.applicationId === applicationId);
    const next = idx >= 0 ? (list[idx + 1] ?? list[idx - 1]) : undefined;
    // After the dialog that triggered the action has closed and restored focus.
    window.setTimeout(() => document.getElementById(next ? titleIdFor(next.applicationId) : QUEUE_ANCHOR_ID)?.focus(), 80);
  }, []);
  const watch = useCallback(() => {
    setWatching(true);
    window.clearTimeout(watchTimer.current);
    watchTimer.current = window.setTimeout(() => setWatching(false), WATCH_MS);
  }, []);
  const ctx: ReviewContext = useMemo(() => ({ settingsMode, tailorResume, providerLabels, onLeave, watch }), [settingsMode, tailorResume, providerLabels, onLeave, watch]);

  return (
    <div>
      <PageHeader
        title="Review queue"
        description={
          <span aria-live="polite" data-testid="review-count">
            {query.isPending
              ? "Loading…"
              : total === 0
                ? "Nothing waiting for your decision."
                : `${plural(total, "application")} waiting for your decision - best matches first.`}
          </span>
        }
        actions={
          <Button variant="outline" size="sm" onClick={() => void query.refetch()} disabled={query.isFetching} aria-label="Refresh the review queue">
            <RefreshCw className={cn(query.isFetching && "animate-spin")} aria-hidden="true" /> Refresh
          </Button>
        }
      />

      <div id={QUEUE_ANCHOR_ID} tabIndex={-1} className="scroll-mt-4 space-y-6 focus:outline-none">
        <Alert variant="info" role="note">
          <Info className="h-4 w-4" />
          <AlertTitle>{APPLICATION_MODE_LABELS[settingsMode]} mode</AlertTitle>
          <AlertDescription>
            {APPLICATION_MODE_DESCRIPTIONS[settingsMode]} {MODE_NOTE[settingsMode]}
          </AlertDescription>
        </Alert>

        {query.isError && query.data ? (
          <p role="status" className="text-sm text-destructive">
            Could not refresh the queue: {errorMessage(query.error)}
          </p>
        ) : null}

        {query.isPending ? (
          <div className="space-y-4" aria-busy="true">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-64 w-full" />
            ))}
          </div>
        ) : query.isError && !query.data ? (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>The review queue could not be loaded</AlertTitle>
            <AlertDescription className="flex flex-wrap items-center gap-2">
              {errorMessage(query.error)}
              <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
                Try again
              </Button>
            </AlertDescription>
          </Alert>
        ) : total === 0 ? (
          <EmptyState
            title="Nothing to review"
            description={
              watching
                ? "Your answers are being used to prepare the application again - it appears here when it is ready."
                : "The automation will add prepared applications here as it finds and prepares matching jobs."
            }
            action={
              <Link href="/jobs" className={cn(buttonVariants({ size: "sm", variant: "outline" }))}>
                Browse jobs
              </Link>
            }
          />
        ) : items.length === 0 ? (
          // Every card on this page was handled: the next ones are on their way from the server.
          <div className="space-y-4" aria-busy="true">
            <p className="sr-only">Loading the next applications…</p>
            <Skeleton className="h-64 w-full" />
          </div>
        ) : (
          <>
            {/* While another page loads, the current cards stay visible but cannot be acted on. */}
            <ul className={cn("space-y-6 transition-opacity", switching && "opacity-60")} aria-label="Applications to review" aria-busy={switching || undefined} inert={switching}>
              {items.map((item) => (
                <li key={item.applicationId}>
                  <ReviewCard item={item} ctx={ctx} />
                </li>
              ))}
            </ul>
            <Pager page={page} pageSize={pageSize} total={total} onPageChange={onPageChange} busy={switching} label="Review queue pages" />
          </>
        )}
      </div>
    </div>
  );
}
