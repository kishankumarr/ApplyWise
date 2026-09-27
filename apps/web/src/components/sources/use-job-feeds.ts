"use client";

import { useSyncExternalStore } from "react";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@applywise/ui";
import { api, errorMessage } from "@/lib/api";
import type { FeedView, JobFeedsOverview, SyncAllResponse } from "@/lib/client-types";
import { plural } from "@/lib/format";
import { CHECKING_NOW, isCheckable, isFirstCheck, newJobsText, nothingToCheckText } from "./feed-utils";

export const FEEDS_KEY = ["job-feeds"] as const;
const fetchOverview = () => api<JobFeedsOverview>("/api/job-feeds");

/**
 * After the user creates a source, the background check may not have started yet (so no feed
 * reports `syncing`). Poll quickly for a while anyway so results show up without a reload.
 */
let boostUntil = 0;
export function boostFeedPolling(ms = 45_000) {
  boostUntil = Math.max(boostUntil, Date.now() + ms);
}

const busy = (feeds: FeedView[] | undefined) => !!feeds?.some((f) => f.syncing || isFirstCheck(f));

/** The Job sources overview. `poll`: refresh every 4 s while something is syncing, otherwise every 60 s. */
export function useJobFeeds(opts: { poll?: boolean; enabled?: boolean; fresh?: boolean } = {}) {
  return useQuery({
    queryKey: FEEDS_KEY,
    queryFn: fetchOverview,
    enabled: opts.enabled ?? true,
    staleTime: opts.fresh ? 0 : undefined,
    refetchInterval: opts.poll ? (q) => (busy(q.state.data?.feeds) || Date.now() < boostUntil ? 4_000 : 60_000) : false,
  });
}

/** Call after a source was created: refresh everything and tell the user what happens next. */
export function useSourceCreated() {
  const qc = useQueryClient();
  return (message: string | null = CHECKING_NOW) => {
    boostFeedPolling();
    void qc.invalidateQueries({ queryKey: FEEDS_KEY });
    // Jobs from the first check arrive in the background; refresh the inbox a few times.
    for (const delay of [0, 5_000, 15_000, 30_000]) setTimeout(() => void qc.invalidateQueries({ queryKey: ["jobs"] }), delay);
    if (message) toast.success(message);
  };
}

/** The sources as the server sees them right now (the baseline for telling when a check has finished). */
export async function freshFeeds(qc: QueryClient): Promise<FeedView[] | undefined> {
  try {
    return (await qc.fetchQuery({ queryKey: FEEDS_KEY, queryFn: fetchOverview, staleTime: 0 })).feeds;
  } catch {
    return qc.getQueryData<JobFeedsOverview>(FEEDS_KEY)?.feeds;
  }
}

// ---------------------------------------------------------------- checks the user asked for

/** Feed ids being checked because the user asked (reference-counted: a row and "Sync all" may overlap). */
const checking = new Map<string, number>();
let checkingSnapshot: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();
const NONE: ReadonlySet<string> = new Set();

function markChecking(ids: string[], delta: 1 | -1) {
  for (const id of ids) {
    const n = (checking.get(id) ?? 0) + delta;
    if (n > 0) checking.set(id, n);
    else checking.delete(id);
  }
  checkingSnapshot = new Set(checking.keys());
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Sources that are being checked on the user's request (rows show "Syncing..." for them). */
export function useCheckingFeeds(): ReadonlySet<string> {
  return useSyncExternalStore(
    subscribe,
    () => checkingSnapshot,
    () => NONE,
  );
}

export type CheckOutcome = { feed: FeedView; kind: "success" | "error" | "paused" | "removed" };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Follow sources the user just asked to check until each check finishes. A check has finished when
 * the source is no longer syncing and something moved: a new lastSyncAt, a different error or
 * status, or a new next-check time (a failed run replaces the lease set when the check was queued,
 * even when it fails with the same error as before). Runs outside React, so it survives navigation.
 */
export async function watchChecks(qc: QueryClient, before: FeedView[], timeoutMs = 120_000): Promise<{ done: CheckOutcome[]; unfinished: FeedView[] }> {
  const ids = before.map((f) => f.id);
  const pending = new Map(before.map((f) => [f.id, { base: f, first: null as FeedView | null, sawSyncing: false }]));
  const done: CheckOutcome[] = [];
  const started = Date.now();
  markChecking(ids, 1);
  try {
    let delay = 0; // first look right away (the lease is visible), then every 2 s, later every 4 s
    while (pending.size && Date.now() - started < timeoutMs) {
      await sleep(delay);
      delay = Date.now() - started < 20_000 ? 2_000 : 4_000;
      let data: JobFeedsOverview;
      try {
        data = await qc.fetchQuery({ queryKey: FEEDS_KEY, queryFn: fetchOverview, staleTime: 0 });
      } catch {
        continue;
      }
      for (const [id, w] of pending) {
        const f = data.feeds.find((x) => x.id === id);
        if (!f) {
          pending.delete(id);
          done.push({ feed: w.base, kind: "removed" });
          continue;
        }
        if (f.syncing) {
          w.sawSyncing = true;
          w.first ??= f;
          continue;
        }
        const b = w.base;
        const finished = w.sawSyncing || f.lastSyncAt !== b.lastSyncAt || f.lastError !== b.lastError || f.status !== b.status || (w.first !== null && f.nextSyncAt !== w.first.nextSyncAt);
        w.first ??= f;
        if (!finished) continue;
        pending.delete(id);
        const failed = !!f.lastError && (f.status === "ERROR" || f.status === "NEEDS_ATTENTION");
        done.push({ feed: f, kind: f.status === "PAUSED" ? "paused" : failed ? "error" : "success" });
      }
    }
  } finally {
    markChecking(ids, -1);
  }
  if (done.some((d) => d.kind === "success")) void qc.invalidateQueries({ queryKey: ["jobs"] });
  return { done, unfinished: [...pending.values()].map((w) => w.base) };
}

/** What to do about a source that failed. */
export function fixHint(f: FeedView): string {
  if (f.status === "ERROR") return "ApplyWise will retry automatically.";
  if (f.kind === "MAILBOX" && f.provider !== "forwarding") return "Use Reconnect on the Job sources page to fix it.";
  return "Try again later, or remove this source on the Job sources page.";
}

/** Watch one source's check and toast the outcome ("12 new jobs found" / "No new jobs" / the error). */
export async function checkAndReport(qc: QueryClient, before: FeedView): Promise<void> {
  const { done } = await watchChecks(qc, [before]);
  const o = done[0];
  if (!o) {
    toast.info(`Still checking ${before.label}. New jobs will appear in your inbox when it finishes.`);
    return;
  }
  if (o.kind === "success") {
    const created = o.feed.lastResult?.created ?? 0;
    if (created) toast.success(`${newJobsText(o.feed)} - ${o.feed.label}`, { description: "They are in your job inbox now." });
    else toast.info(`No new jobs - ${o.feed.label}`, { description: "ApplyWise keeps checking and adds new matches automatically." });
  } else if (o.kind === "error") {
    toast.error(`${o.feed.label}: ${o.feed.lastError}`, { description: fixHint(o.feed) });
  }
}

/** Watch several checks ("Sync all") and toast one summary. */
async function reportAll(qc: QueryClient, before: FeedView[]): Promise<void> {
  const { done, unfinished } = await watchChecks(qc, before);
  const ok = done.filter((d) => d.kind === "success");
  const failed = done.filter((d) => d.kind === "error");
  if (!ok.length && !failed.length) {
    if (unfinished.length) toast.info("Still checking your sources. New jobs will appear in your inbox when they finish.");
    return;
  }
  const created = ok.reduce((n, d) => n + (d.feed.lastResult?.created ?? 0), 0);
  const title = created ? `Check finished: ${plural(created, "new job")} found` : ok.length ? "Check finished: no new jobs" : "Check finished";
  const notes: string[] = [];
  if (failed.length === 1) notes.push(`${failed[0]!.feed.label} could not be checked: ${failed[0]!.feed.lastError}`);
  else if (failed.length > 1) notes.push(`${failed.length} sources could not be checked - see Job sources.`);
  if (unfinished.length) notes.push(`${plural(unfinished.length, "source")} still being checked.`);
  const description = notes.join(" ") || undefined;
  if (failed.length) toast.warning(title, { description });
  else if (created) toast.success(title, { description });
  else toast.info(title, { description });
}

/** "Sync all now" / "Sync now" in the inbox strip: check every source that can be checked, then report. */
export function useSyncAll() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const before = await freshFeeds(qc);
      const r = await api<SyncAllResponse>("/api/job-feeds/sync-all", { body: {} });
      return { r, before };
    },
    onSuccess: ({ r, before }) => {
      const queued = r.queued ?? 0;
      const running = r.alreadyRunning ?? 0;
      if (queued + running === 0) {
        toast.info(nothingToCheckText(before));
        return;
      }
      if (queued) {
        toast.success(`Checking ${plural(queued, "source")} now${running ? ` (${running} already being checked)` : ""}.`, { description: "ApplyWise tells you when it is done. New jobs go to your inbox." });
      } else {
        toast.info(`Already checking ${plural(running, "source")}.`, { description: "ApplyWise tells you when it is done. New jobs go to your inbox." });
      }
      const targets = (before ?? []).filter(isCheckable);
      if (targets.length) void reportAll(qc, targets);
      else void qc.invalidateQueries({ queryKey: FEEDS_KEY });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
}
