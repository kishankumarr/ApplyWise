import { useMutation, useQueryClient, type QueryClient, type QueryKey } from "@tanstack/react-query";
import type { AnswerSource, ApplicationMode, ExecutorKind, Paginated, ReviewQueueItem } from "@applywise/types";
import { toast } from "@applywise/ui";
import { errorMessage } from "@/lib/api";
import { lpa } from "@/lib/format";

/** Prefix of every cached queue page: [...REVIEW_QUEUE_KEY, page]. Also the key of the queue mutations. */
export const REVIEW_QUEUE_KEY = ["review-queue"] as const;
/** One page of the queue, best matches first (ranked by the server across the whole queue). */
export type ReviewQueuePage = Paginated<ReviewQueueItem>;
export const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME ?? "ApplyWise";

export const ANSWER_SOURCE_LABELS: Record<AnswerSource, string> = {
  PROFILE: "Profile",
  PREFERENCE: "Preference",
  TRUTH_BANK: "Truth bank",
  PREVIOUS_ANSWER: "Previous answer",
  CANDIDATE_ANSWER: "Your answer",
  GENERATED: "Drafted from verified facts",
  UNKNOWN: "Unknown",
};

export const ANSWER_SOURCE_VARIANTS: Record<AnswerSource, "secondary" | "success" | "info" | "warning"> = {
  PROFILE: "secondary",
  PREFERENCE: "secondary",
  TRUTH_BANK: "secondary",
  PREVIOUS_ANSWER: "secondary",
  CANDIDATE_ANSWER: "success",
  GENERATED: "info",
  UNKNOWN: "warning",
};

export const EXECUTOR_KIND_LABELS: Record<ExecutorKind, string> = {
  API: "provider application API",
  BROWSER: `browser automation in the ${APP_NAME} worker`,
  MANUAL: "manual handoff",
};

/** Everything a review card needs from the page besides its own item. */
export interface ReviewContext {
  /** The user's current application mode (Settings -> Automation). */
  settingsMode: ApplicationMode;
  /** Automation setting: approved automation applications use the tailored resume (false = the selected resume as-is). */
  tailorResume: boolean;
  providerLabels: Record<string, string>;
  /** Called right before a card leaves the queue, so keyboard focus can move to the next card. */
  onLeave: (applicationId: string) => void;
  /** Poll the queue for a while (an application is being prepared again and will come back). */
  watch: () => void;
}

/**
 * The mode the server will apply when the user acts on this item. Mirrors applicationService.applyNow: an
 * application without a mode follows the current setting (Manual stays Manual, otherwise Review).
 */
export function effectiveMode(item: Pick<ReviewQueueItem, "mode">, settingsMode: ApplicationMode): ApplicationMode {
  return item.mode ?? (settingsMode === "MANUAL" ? "MANUAL" : "REVIEW");
}

/** True when approving hands the application to an automatic executor (API or browser), as reported by the server. */
export function submitsAutomatically(item: Pick<ReviewQueueItem, "executor">, mode: ApplicationMode): boolean {
  return mode !== "MANUAL" && !!item.executor && item.executor.kind !== "MANUAL";
}

/** Whether approving freezes the tailored resume (see applicationService.approveContent). */
export function usesTailoredResume(item: Pick<ReviewQueueItem, "mode" | "tailored">, tailorResume: boolean): boolean {
  return !!item.tailored && (item.mode === null || tailorResume);
}

export function salaryText(min: number | null, max: number | null, currency: string | null): string | null {
  if (min == null && max == null) return null;
  const fmt = (n: number) => (!currency || currency === "INR" ? lpa(n) : `${currency} ${n.toLocaleString("en-IN")}`);
  if (min != null && max != null) return min === max ? fmt(min) : `${fmt(min)} - ${fmt(max)}`;
  return min != null ? `from ${fmt(min)}` : `up to ${fmt(max as number)}`;
}

export const titleIdFor = (applicationId: string) => `review-${applicationId}-title`;

const RELATED_KEYS = new Set(["review-queue", "application", "application-resume", "applications", "jobs", "job", "dashboard", "dashboard-summary"]);

/** Refresh everything that shows application state (queue, application pages, inbox, dashboard counters). */
export function invalidateRelated(qc: QueryClient) {
  return qc.invalidateQueries({ predicate: (q) => RELATED_KEYS.has(String(q.queryKey[0])) });
}

/** Where an item sat in a cached queue page, so a failed request can put it back in place. */
export type QueueSlot = { queryKey: QueryKey; index: number };

/**
 * Takes an application out of every cached queue page right away (and out of the page's total). The refetch after
 * the request (invalidateRelated) brings in the next item from the server, which owns the order.
 */
export function removeFromQueue(qc: QueryClient, applicationId: string): QueueSlot[] {
  const slots: QueueSlot[] = [];
  for (const [queryKey, data] of qc.getQueriesData<ReviewQueuePage>({ queryKey: REVIEW_QUEUE_KEY })) {
    const index = data?.items.findIndex((i) => i.applicationId === applicationId) ?? -1;
    if (!data || index < 0) continue;
    slots.push({ queryKey, index });
    qc.setQueryData<ReviewQueuePage>(queryKey, { ...data, items: data.items.filter((i) => i.applicationId !== applicationId), total: Math.max(0, data.total - 1) });
  }
  return slots;
}

/** Undoes removeFromQueue for a page that does not have the item again yet (a refetch may already have restored it). */
function restoreToQueue(qc: QueryClient, item: ReviewQueueItem, slots: QueueSlot[]) {
  for (const { queryKey, index } of slots) {
    qc.setQueryData<ReviewQueuePage>(queryKey, (data) =>
      data && !data.items.some((i) => i.applicationId === item.applicationId)
        ? { ...data, items: [...data.items.slice(0, index), item, ...data.items.slice(index)], total: data.total + 1 }
        : data,
    );
  }
}

/**
 * A mutation that handles a queue item. With `optimistic`, the card leaves the queue immediately and comes back
 * if the request fails. Callbacks live on the mutation, so they still run after the card unmounts.
 */
export function useQueueMutation<TVars, TData>(
  item: ReviewQueueItem,
  opts: { mutationFn: (vars: TVars) => Promise<TData>; optimistic: boolean; onLeave?: (applicationId: string) => void; onSuccess: (data: TData, vars: TVars) => void },
) {
  const qc = useQueryClient();
  const id = item.applicationId;
  return useMutation({
    // The queue pauses its polling while one of these runs (a poll would bring the card back until the request lands).
    mutationKey: REVIEW_QUEUE_KEY,
    mutationFn: opts.mutationFn,
    onMutate: async (): Promise<QueueSlot[]> => {
      if (!opts.optimistic) return [];
      opts.onLeave?.(id);
      await qc.cancelQueries({ queryKey: REVIEW_QUEUE_KEY });
      return removeFromQueue(qc, id);
    },
    onError: (e, _vars, slots) => {
      if (slots?.length) restoreToQueue(qc, item, slots);
      toast.error(errorMessage(e));
    },
    onSuccess: opts.onSuccess,
    // Refetches the current page, so the next item slides in.
    onSettled: () => invalidateRelated(qc),
  });
}
