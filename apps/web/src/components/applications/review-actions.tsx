"use client";

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, Send } from "lucide-react";
import type { ReviewQueueItem } from "@applywise/types";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Label,
  Spinner,
  Textarea,
  toast,
} from "@applywise/ui";
import { api, errorMessage } from "@/lib/api";
import type { ApplicationView } from "@/lib/client-types";

const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME ?? "ApplyWise";

interface DialogProps {
  app: ApplicationView;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: (a: ApplicationView) => void;
}

/**
 * "Approve & apply" for WAITING_APPROVAL applications: approves the content as it is and queues the executor.
 * Before confirming, the dialog shows which executor would send it (the review view of this one application) - when
 * the provider does not support automatic submission, approving leads to a manual handoff and the dialog says so.
 */
export function ApproveAndApplyDialog(props: DialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      {/* The body remounts on every open, so the confirmation always starts unticked. */}
      <DialogContent data-testid="approve-and-apply-dialog">{props.open ? <ApproveAndApplyBody {...props} /> : null}</DialogContent>
    </Dialog>
  );
}

function ApproveAndApplyBody({ app, onOpenChange, onDone }: DialogProps) {
  const [confirmed, setConfirmed] = useState(false);
  // Only this application's review view (the workspace invalidates the ["automation", "review"] prefix after changes).
  const review = useQuery({
    queryKey: ["automation", "review", app.id],
    queryFn: () => api<ReviewQueueItem>(`/api/automation/review/${app.id}`),
    staleTime: 30_000,
  });
  const executor = review.data?.executor ?? null;
  const manualOnly = executor?.kind === "MANUAL";

  const apply = useMutation({
    mutationFn: () => api<ApplicationView>(`/api/applications/${app.id}/apply`, { body: { userConfirmed: true } }),
    onSuccess: (a) => {
      onOpenChange(false);
      onDone(a);
      toast.success(manualOnly ? "Approved. This job has to be finished by you - use the manual handoff." : "Approved. The automation submits it shortly - follow the progress on this page.");
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const unresolved = app.screeningAnswers.filter((s) => s.required && !s.resolved).length;
  const claims = app.tailored?.validation.unsupportedClaims?.filter((u) => u.severity !== "low").length ?? 0;

  return (
    <>
      <DialogHeader>
        <DialogTitle>Approve and apply</DialogTitle>
        <DialogDescription>
          This approves the tailored resume, cover letter and answers exactly as they are now and hands the application to the automation. Edit anything first if needed.
        </DialogDescription>
      </DialogHeader>

      <div aria-live="polite" className="text-sm">
        {review.isLoading ? (
          <span className="flex items-center gap-2 text-muted-foreground">
            <Spinner label="Checking how this application would be sent" /> Checking how this application would be sent…
          </span>
        ) : executor && !manualOnly ? (
          <Alert variant="info">
            <Send className="h-4 w-4" aria-hidden="true" />
            <AlertTitle>Sent automatically via {executor.label}</AlertTitle>
            <AlertDescription>After you approve, the automation submits it within your daily limit, using only your verified information.</AlertDescription>
          </Alert>
        ) : manualOnly ? (
          <Alert variant="warning">
            <AlertTriangle className="h-4 w-4" aria-hidden="true" />
            <AlertTitle>Automatic submission is not available for this job</AlertTitle>
            <AlertDescription>Approving prepares a manual handoff: you then apply on the official page yourself. Nothing is submitted for you.</AlertDescription>
          </Alert>
        ) : (
          <p className="text-muted-foreground">
            Where this job&apos;s provider supports automatic submission, the automation submits it within your daily limit. Otherwise the application is handed over to you to finish on the official page.
          </p>
        )}
      </div>

      {unresolved || claims ? (
        <Alert variant="warning">
          <AlertTriangle className="h-4 w-4" aria-hidden="true" />
          <AlertTitle>Before you approve</AlertTitle>
          <AlertDescription>
            <ul className="list-disc pl-4">
              {unresolved ? <li>{unresolved === 1 ? "1 required question has" : `${unresolved} required questions have`} no verified answer yet - the application pauses and asks you before anything is sent.</li> : null}
              {claims ? <li>{claims === 1 ? "1 claim" : `${claims} claims`} in the tailored resume should be double-checked.</li> : null}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}

      <label className="flex items-start gap-2 text-sm">
        <Checkbox className="mt-0.5" checked={confirmed} onCheckedChange={(c) => setConfirmed(c === true)} aria-label="I reviewed the content and approve it" />
        {manualOnly
          ? "I reviewed the tailored resume, cover letter and answers, and everything is true."
          : `I reviewed the tailored resume, cover letter and answers, everything is true, and I want ${APP_NAME} to submit this application on my behalf.`}
      </label>

      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button onClick={() => apply.mutate()} disabled={!confirmed || apply.isPending || review.isLoading} data-testid="confirm-approve-and-apply">
          {apply.isPending ? <Spinner label="Approving" /> : null}
          {manualOnly ? "Approve (manual handoff)" : "Approve and submit"}
        </Button>
      </DialogFooter>
    </>
  );
}

/** Decline an application that was not sent: it is withdrawn and the job hidden from the inbox. */
export function DeclineDialog(props: DialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent>{props.open ? <DeclineBody {...props} /> : null}</DialogContent>
    </Dialog>
  );
}

function DeclineBody({ app, onOpenChange, onDone }: DialogProps) {
  const [reason, setReason] = useState("");
  const decline = useMutation({
    mutationFn: () => api<ApplicationView>(`/api/applications/${app.id}/decline`, { body: reason.trim() ? { reason: reason.trim() } : {} }),
    onSuccess: (a) => {
      onOpenChange(false);
      onDone(a);
      toast.success("Application declined.");
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const id = `decline-reason-${app.id}`;
  return (
    <>
      <DialogHeader>
        <DialogTitle>Decline this application?</DialogTitle>
        <DialogDescription>The application is withdrawn and this {app.job.company} job is hidden from your inbox. Nothing is sent to the employer.</DialogDescription>
      </DialogHeader>
      <div className="space-y-1">
        <Label htmlFor={id}>Reason (optional)</Label>
        <Textarea id={id} rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} aria-describedby={`${id}-hint`} />
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          Kept only in this application&apos;s timeline.
        </p>
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button variant="destructive" onClick={() => decline.mutate()} disabled={decline.isPending}>
          {decline.isPending ? <Spinner label="Declining" /> : null}
          Decline application
        </Button>
      </DialogFooter>
    </>
  );
}
