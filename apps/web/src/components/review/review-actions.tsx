"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { Clock, Pencil, Send, ShieldCheck, XCircle } from "lucide-react";
import { MANUAL_ACTION_REASON_LABELS, type ReviewQueueItem } from "@applywise/types";
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
  Label,
  Textarea,
  toast,
} from "@applywise/ui";
import { api } from "@/lib/api";
import { formatDateTime, plural } from "@/lib/format";
import { APP_NAME, EXECUTOR_KIND_LABELS, effectiveMode, submitsAutomatically, useQueueMutation, usesTailoredResume, type ReviewContext } from "./review-shared";

/** Why the primary action is unavailable, or null when the user can approve. */
function approveBlocker(item: ReviewQueueItem): string | null {
  if (item.status === "NEEDS_INFORMATION") return "Answer the questions above first - the automation never guesses answers, so it cannot be approved yet.";
  if (!item.tailored) return "Nothing has been prepared yet. Open Edit to prepare the application.";
  return null;
}

/**
 * Primary action. Manual mode: "Approve" (POST /approve) - nothing is submitted, the user applies on the official
 * page. Review/Auto: "Approve & apply" (POST /apply) when an automatic executor is available, otherwise "Approve"
 * which hands the prepared application to the user (manual handoff). Both open a confirmation that lists exactly
 * what would be sent and how.
 */
export function ApproveControl({ item, ctx, hintId }: { item: ReviewQueueItem; ctx: ReviewContext; hintId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const id = item.applicationId;
  const mode = effectiveMode(item, ctx.settingsMode);
  const manualMode = mode === "MANUAL";
  const automatic = submitsAutomatically(item, mode);
  const executor = automatic ? item.executor : null;
  const blocker = approveBlocker(item);
  const label = automatic ? "Approve & apply" : "Approve";
  const where = `${item.job.title} at ${item.job.company}`;
  const view = { label: "View", onClick: () => router.push(`/applications/${id}`) };

  const approve = useQueueMutation<void, unknown>(item, {
    optimistic: true,
    onLeave: ctx.onLeave,
    mutationFn: () =>
      manualMode
        ? api(`/api/applications/${id}/approve`, { body: { reviewedContent: true } })
        : api(`/api/applications/${id}/apply`, { body: { userConfirmed: true } }),
    onSuccess: () => {
      if (manualMode) toast.success(`Approved ${where}. Apply on the official page yourself, then mark it as submitted.`, { action: view });
      else if (executor) toast.success(`Approved ${where}. It is queued for submission through ${executor.label}. Follow the result on Applications.`, { action: view });
      else toast.success(`Approved ${where}. Automatic submission is not available, so it is handed to you with everything prepared.`, { action: view });
    },
  });

  const resolvedAnswers = item.answers.filter((a) => a.resolved && a.answer.trim()).length;
  const unresolvedAnswers = item.answers.length - resolvedAnswers;
  const tailored = usesTailoredResume(item, ctx.tailorResume);
  const resumeLabel = item.resume.label ?? "your selected resume";
  const hasCover = !!item.coverLetter?.trim();

  const confirm = () => {
    setOpen(false);
    approve.mutate();
  };

  return (
    <>
      <Button
        onClick={() => {
          setReviewed(false);
          setOpen(true);
        }}
        disabled={!!blocker || approve.isPending}
        aria-describedby={hintId}
      >
        {automatic ? <Send aria-hidden="true" /> : <ShieldCheck aria-hidden="true" />}
        {label}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{automatic ? `Approve and apply to ${where}?` : `Approve ${where}?`}</DialogTitle>
            <DialogDescription>
              {manualMode
                ? "Manual mode: nothing is submitted for you. Approving freezes the prepared content so you can use it when you apply on the official page yourself."
                : executor
                  ? `After you confirm, ${APP_NAME} submits this application through ${executor.label} (${EXECUTOR_KIND_LABELS[executor.kind]}).`
                  : "Automatic submission is not available for this job, so nothing will be sent. Approving hands the prepared application to you and you apply on the official page yourself."}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 text-sm">
            <p className="font-medium">{automatic ? "What will be submitted" : "What you will have ready"}</p>
            <ul className="list-disc space-y-1 pl-5">
              <li>Your contact details from your profile (name, email, phone, city, profile links, current role, years of experience) - only what your profile contains.</li>
              <li>
                Resume (PDF):{" "}
                {tailored
                  ? "the tailored resume built from your verified profile (summary shown on this card)"
                  : `${resumeLabel}, not tailored - as-is if you approved that version yourself, otherwise rebuilt from your verified profile facts (an unreviewed CV parse is never sent)`}
                .
              </li>
              <li>{hasCover ? "The cover letter shown on this card." : "No cover letter."}</li>
              <li>
                {resolvedAnswers ? `${plural(resolvedAnswers, "screening answer")} with a verified source.` : "No screening answers."}
                {unresolvedAnswers ? ` ${plural(unresolvedAnswers, "question")} without a verified answer ${unresolvedAnswers === 1 ? "is" : "are"} never sent.` : ""}
              </li>
            </ul>
            {automatic ? (
              <p className="text-muted-foreground">
                It is sent shortly by the worker and counts towards your daily limit - if today&apos;s limit is used up, it goes out tomorrow. The same job is never submitted twice.
              </p>
            ) : !manualMode && item.manualActionReason ? (
              <p className="text-muted-foreground">
                Why: {MANUAL_ACTION_REASON_LABELS[item.manualActionReason]}
                {item.manualActionDetail ? ` - ${item.manualActionDetail}` : ""}
              </p>
            ) : null}
            {item.tailored && item.tailored.unsupportedClaims > 0 ? (
              <Alert variant="warning" role="note">
                <AlertDescription>
                  {plural(item.tailored.unsupportedClaims, "claim")} in the tailored resume could not be matched to your verified facts. Use Edit to fix {item.tailored.unsupportedClaims === 1 ? "it" : "them"} first.
                </AlertDescription>
              </Alert>
            ) : null}
            <div className="flex items-start gap-2 rounded-md border p-3">
              <Checkbox id={`${id}-reviewed`} checked={reviewed} onCheckedChange={(c) => setReviewed(c === true)} className="mt-0.5" />
              <Label htmlFor={`${id}-reviewed`} className="font-normal leading-snug">
                I reviewed the resume, cover letter and answers, and they are accurate.
              </Label>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={confirm} disabled={!reviewed || approve.isPending}>
              {automatic ? "Approve & apply" : "Approve"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <p id={hintId} className="order-last basis-full text-xs text-muted-foreground">
        {blocker ??
          (manualMode
            ? "Manual mode: approving does not submit anything - you then apply on the official page yourself."
            : executor
              ? `Submits through ${executor.label} after you confirm.`
              : "No automatic submission for this job - approving hands it to you to apply yourself.")}
      </p>
    </>
  );
}

export function EditLink({ item }: { item: ReviewQueueItem }) {
  return (
    <Link href={`/applications/${item.applicationId}`} className={cn(buttonVariants({ variant: "outline" }))} aria-label={`Edit the application for ${item.job.title}`}>
      <Pencil aria-hidden="true" /> Edit
    </Link>
  );
}

/** "Reject" - the application is withdrawn (never sent) and the job hidden from the inbox. */
export function RejectControl({ item, ctx }: { item: ReviewQueueItem; ctx: ReviewContext }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const id = item.applicationId;
  const decline = useQueueMutation<string | undefined, unknown>(item, {
    optimistic: true,
    onLeave: ctx.onLeave,
    mutationFn: (r) => api(`/api/applications/${id}/decline`, { body: r ? { reason: r } : {} }),
    onSuccess: () => toast.success(`Rejected ${item.job.title} at ${item.job.company}. Nothing was sent and the job is hidden from your inbox.`),
  });
  return (
    <>
      <Button
        variant="ghost"
        onClick={() => {
          setReason("");
          setOpen(true);
        }}
        disabled={decline.isPending}
        aria-label={`Reject ${item.job.title}`}
      >
        <XCircle aria-hidden="true" /> Reject
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Reject this application?</DialogTitle>
            <DialogDescription>
              {item.job.title} at {item.job.company}. Nothing is sent; the application is withdrawn and the job is hidden from your inbox.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-reject-reason`}>Reason (optional)</Label>
            <Textarea id={`${id}-reject-reason`} rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Not interested in this company" />
            <p className="text-xs text-muted-foreground">Kept in the application history for you.</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setOpen(false);
                decline.mutate(reason.trim() || undefined);
              }}
            >
              Reject application
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** "Skip" for 1 or 7 days: hidden from the queue without deciding. A small disclosure keeps it keyboard friendly. */
export function SkipControl({ item, ctx }: { item: ReviewQueueItem; ctx: ReviewContext }) {
  const [open, setOpen] = useState(false);
  const groupId = useId();
  const firstRef = useRef<HTMLButtonElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const id = item.applicationId;
  const skip = useQueueMutation<number, { skippedUntil: string }>(item, {
    optimistic: true,
    onLeave: ctx.onLeave,
    mutationFn: (days) => api<{ skippedUntil: string }>(`/api/applications/${id}/skip`, { body: { days } }),
    onSuccess: (r) => toast.success(`Skipped ${item.job.title}. It comes back to this queue ${formatDateTime(r.skippedUntil)}.`),
  });

  useEffect(() => {
    if (open) firstRef.current?.focus();
  }, [open]);

  const close = () => {
    setOpen(false);
    toggleRef.current?.focus();
  };

  return (
    <div className="flex flex-wrap items-center gap-1" onKeyDown={(e) => e.key === "Escape" && open && close()}>
      <Button ref={toggleRef} variant="ghost" aria-expanded={open} aria-controls={open ? groupId : undefined} onClick={() => setOpen((o) => !o)} disabled={skip.isPending}>
        <Clock aria-hidden="true" /> Skip
      </Button>
      {open ? (
        <div id={groupId} role="group" aria-label={`Skip ${item.job.title} for`} className="flex items-center gap-1">
          <Button ref={firstRef} size="sm" variant="outline" onClick={() => skip.mutate(1)}>
            1 day
          </Button>
          <Button size="sm" variant="outline" onClick={() => skip.mutate(7)}>
            7 days
          </Button>
          <Button size="sm" variant="ghost" onClick={close}>
            Cancel
          </Button>
        </div>
      ) : null}
    </div>
  );
}
