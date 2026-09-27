"use client";

import Link from "next/link";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, KeyRound, Loader2, Pause, Play, RefreshCw, Trash2, TriangleAlert } from "lucide-react";
import {
  Badge,
  Button,
  buttonVariants,
  Checkbox,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  toast,
} from "@applywise/ui";
import { api, ApiClientError, errorMessage } from "@/lib/api";
import type { FeedSyncResponse, FeedView, MailboxOptions } from "@/lib/client-types";
import { plural, timeAgo, timeUntil } from "@/lib/format";
import { CopyButton } from "./copy-button";
import { feedResultText, isFirstCheck } from "./feed-utils";
import { ImapReconnectDialog } from "./imap-reconnect-dialog";
import { OutlookConnectDialog } from "./outlook-connect-dialog";
import { checkAndReport, FEEDS_KEY, freshFeeds, useCheckingFeeds } from "./use-job-feeds";

type DisplayStatus = "syncing" | "active" | "paused" | "error" | "attention";

const STATUS: Record<DisplayStatus, { label: string; variant: "success" | "info" | "secondary" | "warning" | "destructive" }> = {
  syncing: { label: "Syncing...", variant: "info" },
  active: { label: "Active", variant: "success" },
  paused: { label: "Paused", variant: "secondary" },
  error: { label: "Error", variant: "warning" },
  attention: { label: "Needs attention", variant: "destructive" },
};

export function FeedStatusBadge({ status }: { status: DisplayStatus }) {
  const s = STATUS[status];
  return (
    <Badge variant={s.variant} className="gap-1" data-testid="feed-status">
      {status === "syncing" ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> : null}
      {s.label}
    </Badge>
  );
}

function displayStatus(f: FeedView, localSync: boolean): DisplayStatus {
  if (f.status === "PAUSED") return "paused";
  if (f.syncing || localSync || isFirstCheck(f)) return "syncing";
  if (f.status === "NEEDS_ATTENTION") return "attention";
  if (f.status === "ERROR") return "error";
  return "active";
}

type Reconnect = { kind: "imap" | "outlook" } | { kind: "gmail"; href: string } | { kind: "unavailable"; text: string };

/** How a mailbox that needs attention is reconnected in place (jobs, history and settings are kept). */
function reconnectOption(f: FeedView, mailbox: MailboxOptions | undefined): Reconnect | null {
  if (f.kind !== "MAILBOX" || f.provider === "forwarding") return null;
  const email = typeof f.config.email === "string" ? f.config.email : "";
  if (f.provider === "gmail") {
    if (mailbox && !mailbox.gmailAvailable) return { kind: "unavailable", text: "Google sign-in is not available on this server right now. Remove this mailbox and connect it with an app password instead." };
    return { kind: "gmail", href: `/api/job-feeds/mailbox/gmail/start${email ? `?email=${encodeURIComponent(email)}` : ""}` };
  }
  if (f.provider === "outlook") {
    if (mailbox && !mailbox.outlookAvailable) return { kind: "unavailable", text: "Outlook sign-in is not available on this server right now, so this mailbox cannot be reconnected yet." };
    return { kind: "outlook" };
  }
  return { kind: "imap" };
}

function reconnectHint(r: Reconnect | null, f: FeedView): string | null {
  if (!r) return f.kind === "MAILBOX" ? null : "Try again later, or remove this source if it keeps failing.";
  if (r.kind === "unavailable") return r.text;
  if (r.kind === "gmail") return "Click Reconnect and sign in with Google again. Your jobs and settings are kept.";
  if (r.kind === "outlook") return "Click Reconnect and sign in with Microsoft again. Your jobs and settings are kept.";
  return "The app password was probably changed or revoked. Click Reconnect and paste a new one. Your jobs and settings are kept.";
}

export function FeedRow({ feed, mailbox }: { feed: FeedView; mailbox?: MailboxOptions }) {
  const qc = useQueryClient();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [reconnectOpen, setReconnectOpen] = useState(false);
  // "Sync now" was pressed: the row shows Syncing... until the check finishes (see watchChecks).
  const checking = useCheckingFeeds().has(feed.id);

  const refresh = () => void qc.invalidateQueries({ queryKey: FEEDS_KEY });
  const isForwarding = feed.provider === "forwarding";
  const paused = feed.status === "PAUSED";
  const attention = feed.status === "NEEDS_ATTENTION";
  const reconnect = attention ? reconnectOption(feed, mailbox) : null;

  const openReconnect = () => {
    if (reconnect?.kind === "gmail") window.location.assign(reconnect.href);
    else if (reconnect?.kind === "imap" || reconnect?.kind === "outlook") setReconnectOpen(true);
  };

  const sync = useMutation({
    // `base`: the source as it was before this check (a resume passes the updated source).
    mutationFn: async (base?: FeedView) => {
      const before = base ?? (await freshFeeds(qc))?.find((f) => f.id === feed.id) ?? feed;
      const r = await api<FeedSyncResponse>(`/api/job-feeds/${feed.id}/sync`, { body: {} });
      return { r, before };
    },
    onSuccess: ({ r, before }) => {
      if (!r.queued && !r.alreadyRunning) return;
      if (r.alreadyRunning) toast.info("Already checking this source.", { description: "ApplyWise tells you when it is done." });
      void checkAndReport(qc, before);
    },
    onError: (e) => {
      if (e instanceof ApiClientError && e.status === 409 && /reconnect/i.test(e.message)) {
        refresh();
        toast.error("This source needs to be reconnected first.", reconnect && reconnect.kind !== "unavailable" ? { action: { label: "Reconnect", onClick: openReconnect } } : undefined);
        return;
      }
      toast.error(errorMessage(e));
    },
  });

  const pause = useMutation({
    mutationFn: (next: boolean) => api<FeedView>(`/api/job-feeds/${feed.id}`, { method: "PATCH", body: { paused: next } }),
    onSuccess: (updated, next) => {
      if (next) toast.success("Paused. ApplyWise will not check this source until you resume it.");
      else if (isForwarding) toast.success("Resumed. Forwarded alerts will be picked up again.");
      else if (!paused) toast.info("Trying again now.");
      else toast.success("Resumed. Checking now.");
      if (!next && !isForwarding) sync.mutate(updated);
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const relevance = useMutation({
    mutationFn: (onlyRelevant: boolean) => api<FeedView>(`/api/job-feeds/${feed.id}`, { method: "PATCH", body: { onlyRelevant } }),
    onSuccess: (_r, on) => {
      toast.success(on ? "Only jobs matching your target roles will be added." : "All jobs from this company will be added from the next check.");
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const remove = useMutation({
    mutationFn: () => api(`/api/job-feeds/${feed.id}`, { method: "DELETE" }),
    onSuccess: () => {
      setConfirmRemove(false);
      toast.success("Source removed. Jobs it already found stay in your inbox.");
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const status = displayStatus(feed, checking || sync.isPending);
  const result = feedResultText(feed);
  const address = isForwarding && typeof feed.config.address === "string" ? feed.config.address : null;
  const boardUrl = feed.kind === "COMPANY_BOARD" && typeof feed.config.boardUrl === "string" ? feed.config.boardUrl : null;
  const onlyRelevant = feed.config.onlyRelevant !== false;
  const hint = attention ? reconnectHint(reconnect, feed) : null;
  const busy = status === "syncing" || sync.isPending || pause.isPending;

  const timing: string[] = [];
  if (isForwarding) timing.push(feed.lastSyncAt ? `Last alert received ${timeAgo(feed.lastSyncAt)}` : "Waiting for your first forwarded job alert");
  else if (status === "syncing" && !feed.lastSyncAt) timing.push("Checking for the first time...");
  else timing.push(`Last checked ${timeAgo(feed.lastSyncAt)}`);
  if (result && status !== "syncing") timing.push(result);
  if (!isForwarding && !paused && status !== "syncing" && !attention && feed.nextSyncAt) {
    timing.push(`${feed.status === "ERROR" ? "Retrying" : "Next check"} ${timeUntil(feed.nextSyncAt)}`);
  }

  let primary: React.ReactNode = null;
  if (reconnect?.kind === "gmail") {
    primary = (
      // A full page navigation (not <Link>): the route redirects to Google and must never be prefetched.
      <a href={reconnect.href} className={buttonVariants({ size: "sm" })} aria-label={`Reconnect ${feed.label}`}>
        <KeyRound aria-hidden="true" /> Reconnect
      </a>
    );
  } else if (reconnect?.kind === "imap" || reconnect?.kind === "outlook") {
    primary = (
      <Button size="sm" onClick={openReconnect} aria-label={`Reconnect ${feed.label}`}>
        <KeyRound aria-hidden="true" /> Reconnect
      </Button>
    );
  } else if (attention && feed.kind !== "MAILBOX") {
    // The server refuses a plain sync for sources that need attention; resuming clears the state first.
    primary = (
      <Button size="sm" variant="outline" onClick={() => pause.mutate(false)} disabled={busy} aria-label={`Try ${feed.label} again`}>
        <RefreshCw className={status === "syncing" ? "animate-spin" : undefined} aria-hidden="true" /> Try again
      </Button>
    );
  } else if (!isForwarding && !attention) {
    primary = (
      <Button size="sm" variant="outline" onClick={() => sync.mutate(undefined)} disabled={paused || busy} aria-label={`Sync ${feed.label} now`}>
        <RefreshCw className={status === "syncing" ? "animate-spin" : undefined} aria-hidden="true" />
        {feed.status === "ERROR" ? "Try again" : "Sync now"}
      </Button>
    );
  }

  return (
    <li className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between" data-testid="feed-row">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="break-words font-medium">{feed.label}</p>
          <FeedStatusBadge status={status} />
        </div>
        <p className="text-xs text-muted-foreground">{timing.join(" · ")}</p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          {feed.jobCount != null ? (
            feed.jobCount > 0 ? (
              <Link href={`/jobs?feedId=${encodeURIComponent(feed.id)}`} className="font-medium text-primary underline-offset-4 hover:underline">
                {plural(feed.jobCount, "job")} found
              </Link>
            ) : (
              <span className="text-muted-foreground">No jobs found yet</span>
            )
          ) : null}
          {boardUrl ? (
            <a href={boardUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-muted-foreground underline-offset-4 hover:underline">
              View board <ExternalLink className="h-3 w-3" aria-hidden="true" />
              <span className="sr-only">(opens in a new tab)</span>
            </a>
          ) : null}
        </div>
        {address ? (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <code className="break-all rounded bg-muted px-2 py-1 text-xs">{address}</code>
            <CopyButton value={address} what="forwarding address" size="sm" variant="ghost" />
          </div>
        ) : null}
        {feed.kind === "COMPANY_BOARD" ? (
          <label className="flex items-center gap-2 pt-1 text-xs text-muted-foreground">
            <Checkbox
              checked={onlyRelevant}
              disabled={relevance.isPending}
              onCheckedChange={(c) => relevance.mutate(c === true)}
              aria-label={`Only add jobs from ${feed.label} that match my target roles`}
            />
            Only jobs matching my target roles
          </label>
        ) : null}
        {feed.lastError && (feed.status === "ERROR" || attention) ? (
          <p className={cn("flex items-start gap-1.5 pt-1 text-sm", attention ? "text-destructive" : "text-amber-700 dark:text-amber-300")}>
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>
              {feed.lastError}
              {feed.status === "ERROR" ? " ApplyWise will retry automatically." : null}
              {hint ? <span className="block pt-0.5 text-foreground">{hint}</span> : null}
            </span>
          </p>
        ) : null}
      </div>

      <div className="flex shrink-0 flex-wrap gap-2">
        {primary}
        <Button size="sm" variant="ghost" onClick={() => pause.mutate(!paused)} disabled={pause.isPending} aria-label={`${paused ? "Resume" : "Pause"} ${feed.label}`}>
          {paused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
          {paused ? "Resume" : "Pause"}
        </Button>
        <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => setConfirmRemove(true)} aria-label={`Remove ${feed.label}`}>
          <Trash2 aria-hidden="true" /> Remove
        </Button>
      </div>

      {reconnect?.kind === "imap" ? <ImapReconnectDialog feed={feed} mailbox={mailbox} open={reconnectOpen} onOpenChange={setReconnectOpen} /> : null}
      {reconnect?.kind === "outlook" ? (
        <OutlookConnectDialog open={reconnectOpen} onOpenChange={setReconnectOpen} initialEmail={typeof feed.config.email === "string" ? feed.config.email : undefined} reconnect />
      ) : null}

      <Dialog open={confirmRemove} onOpenChange={(o) => !remove.isPending && setConfirmRemove(o)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Remove this source?</DialogTitle>
            <DialogDescription>
              <strong className="text-foreground">{feed.label}</strong> will no longer be checked. Jobs it already found stay in your inbox.
              {feed.provider === "gmail" ? " ApplyWise's access to your Gmail is revoked." : null}
              {feed.kind === "MAILBOX" && feed.provider !== "gmail" && feed.provider !== "forwarding" ? " The saved sign-in details are deleted." : null}
              {isForwarding ? " Your private address stops working; remove the forwarding filter in Gmail too." : null}
              {reconnect && reconnect.kind !== "unavailable" ? " To fix a connection problem, use Reconnect instead - it keeps the source's history." : null}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmRemove(false)} disabled={remove.isPending}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => remove.mutate()} disabled={remove.isPending}>
              {remove.isPending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
              Remove source
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </li>
  );
}

export function FeedList({ feeds, emptyText, title, mailbox }: { feeds: FeedView[]; emptyText?: string; title?: string; mailbox?: MailboxOptions }) {
  if (feeds.length === 0) return emptyText ? <p className="text-sm text-muted-foreground">{emptyText}</p> : null;
  return (
    <div className="space-y-3">
      {title ? <h3 className="text-sm font-semibold">{title}</h3> : null}
      <ul className="divide-y rounded-md border p-4" aria-label={title}>
        {feeds.map((f) => (
          <FeedRow key={f.id} feed={f} mailbox={mailbox} />
        ))}
      </ul>
    </div>
  );
}
