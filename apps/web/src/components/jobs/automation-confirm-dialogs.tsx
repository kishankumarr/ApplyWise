"use client";

import Link from "next/link";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, TriangleAlert } from "lucide-react";
import type { ReviewQueueItem } from "@applywise/types";
import {
  Alert,
  AlertDescription,
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
import { api, errorMessage } from "@/lib/api";
import type { ApplicationView } from "@/lib/client-types";

/** The application a row action works on. */
export interface ApplicationTarget {
  applicationId: string;
  jobId: string;
  title: string;
  company: string;
  status: string;
}

function useAfterChange(target: ApplicationTarget | null) {
  const qc = useQueryClient();
  return (app: ApplicationView | null) => {
    if (target && app) qc.setQueryData(["application", target.applicationId], app);
    void qc.invalidateQueries({ queryKey: ["jobs"] });
    void qc.invalidateQueries({ queryKey: ["automation", "review"] });
    void qc.invalidateQueries({ queryKey: ["review-queue"] });
  };
}

/**
 * "Approve" for the manual flow and Manual mode only: the user confirms they reviewed the prepared content and then
 * applies themselves - nothing is submitted by approving. Review/Auto applications use the Approve & apply dialog,
 * because approving them queues their submission.
 * Render with a `key` per target so the confirmation checkbox starts unticked for every application.
 */
export function ApproveConfirmDialog({ target, onClose }: { target: ApplicationTarget | null; onClose: () => void }) {
  const [reviewed, setReviewed] = useState(false);
  const afterChange = useAfterChange(target);
  const approve = useMutation({
    mutationFn: (t: ApplicationTarget) => api<ApplicationView>(`/api/applications/${t.applicationId}/approve`, { body: { reviewedContent: true } }),
    onSuccess: (app) => {
      afterChange(app);
      toast.success("Approved. Nothing has been submitted - open the application when you are ready to apply.");
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <Dialog open={!!target} onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Approve this application?</DialogTitle>
          <DialogDescription>{target ? `${target.title} at ${target.company}` : null}</DialogDescription>
        </DialogHeader>
        <p className="text-sm">
          Approving confirms that you reviewed the prepared resume, cover letter and answers. <strong>Nothing is submitted when you approve.</strong>
        </p>
        {target ? (
          <p className="text-sm">
            <Link href={`/applications/${target.applicationId}`} className="underline underline-offset-4">
              Review the prepared content first
            </Link>
          </p>
        ) : null}
        <label className="flex items-start gap-2 text-sm">
          <Checkbox className="mt-0.5" checked={reviewed} onCheckedChange={(c) => setReviewed(c === true)} aria-label="I reviewed the prepared content" />
          I reviewed the prepared resume, cover letter and answers, and everything in them is true.
        </label>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => target && approve.mutate(target)} disabled={!reviewed || approve.isPending}>
            {approve.isPending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
            Approve
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * "Apply" for an application waiting for approval: approve and ask the automation to submit it. Shows how it
 * would be sent (the review queue's live executor) so a manual handoff is never presented as automatic submission.
 * Render with a `key` per target so the confirmation checkbox starts unticked for every application.
 */
export function ApplyConfirmDialog({ target, onClose, onQueued }: { target: ApplicationTarget | null; onClose: () => void; onQueued?: () => void }) {
  const [confirmed, setConfirmed] = useState(false);
  const afterChange = useAfterChange(target);
  // Only this application's review view (the queue itself is paginated).
  const applicationId = target?.applicationId ?? null;
  const review = useQuery({
    queryKey: ["automation", "review", applicationId],
    queryFn: () => api<ReviewQueueItem>(`/api/automation/review/${applicationId}`),
    enabled: !!applicationId,
    staleTime: 10_000,
  });
  const item = applicationId ? review.data : undefined;
  const executor = item?.executor ?? null;
  const manual = executor?.kind === "MANUAL";
  const confirmText = manual
    ? "I reviewed the prepared content and want to approve it. I will submit the application myself."
    : "I reviewed the prepared content and want ApplyWise to submit this application on my behalf.";

  const apply = useMutation({
    mutationFn: (t: ApplicationTarget) => api<ApplicationView>(`/api/applications/${t.applicationId}/apply`, { body: { userConfirmed: true } }),
    onSuccess: (app) => {
      afterChange(app);
      toast.success(
        manual
          ? "Approved. Automatic submission is not available for this job, so a manual handoff is being prepared - you submit it yourself."
          : "Approved and queued for submission. Follow its progress on the Applications page.",
      );
      onQueued?.();
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <Dialog open={!!target} onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Approve and submit this application?</DialogTitle>
          <DialogDescription>{target ? `${target.title} at ${target.company}` : null}</DialogDescription>
        </DialogHeader>
        <p className="text-sm">
          ApplyWise approves the prepared resume, cover letter and answers and submits this application for you, using only that content. It runs in the background and counts
          toward your daily application limit - if today&apos;s limit is used up, it is sent the next day.
        </p>
        <div aria-live="polite" className="text-sm">
          {review.isLoading ? (
            <p className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Checking how this application would be sent…
            </p>
          ) : manual ? (
            <Alert variant="warning">
              <TriangleAlert className="h-4 w-4" aria-hidden="true" />
              <AlertDescription>
                Automatic submission is not available for this job right now. If you continue, the content is approved and you get a manual handoff: you submit it yourself on
                the official page. Nothing is sent for you.
              </AlertDescription>
            </Alert>
          ) : executor ? (
            <p>
              <span className="font-medium">How it is sent:</span> {executor.label}
            </p>
          ) : (
            <p className="text-muted-foreground">
              If automatic submission turns out not to be available for this job, nothing is sent - you get a manual handoff to submit it yourself instead.
            </p>
          )}
          {item?.warnings.length ? (
            <div className="mt-3">
              <p className="font-medium">Please check before you continue:</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted-foreground">
                {item.warnings.slice(0, 3).map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
        <label className="flex items-start gap-2 text-sm">
          <Checkbox className="mt-0.5" checked={confirmed} disabled={review.isLoading} onCheckedChange={(c) => setConfirmed(c === true)} aria-label={confirmText} />
          {confirmText}
        </label>
        <DialogFooter>
          {target ? (
            <Link href={`/applications/${target.applicationId}`} className={cn(buttonVariants({ variant: "outline" }))}>
              Review first
            </Link>
          ) : null}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => target && apply.mutate(target)} disabled={!confirmed || apply.isPending || review.isLoading}>
            {apply.isPending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
            {manual ? "Approve & get handoff" : "Approve & apply"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
