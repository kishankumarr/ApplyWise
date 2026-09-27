"use client";

import { useState } from "react";
import { useMutation, type UseQueryResult } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Download, ExternalLink, Hand, RotateCw, ShieldCheck } from "lucide-react";
import type { ManualHandoffPackage } from "@applywise/types";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Skeleton,
  Spinner,
  buttonVariants,
  cn,
  toast,
} from "@applywise/ui";
import { CopyButton } from "@/components/sources/copy-button";
import { api, downloadFile, errorMessage } from "@/lib/api";
import type { ApplicationView } from "@/lib/client-types";
import { formatDateTime } from "@/lib/format";
import { ANSWER_SOURCE_LABELS, safeHttpUrl } from "./application-labels";

const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME ?? "ApplyWise";
const shorten = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * Manual handoff for MANUAL_ACTION_REQUIRED / FAILED applications (and the apply page opened from here):
 * everything the user needs to finish the application themselves, plus an explicit retry of the automation.
 * A retry only ever resends approved content: content that was never approved (handed off right after preparation)
 * or edited since is reviewed and approved first ("Review & approve", which queues the submission again).
 * The workspace loads the handoff package (`handoff`) only while this panel is shown; this code is loaded on demand too.
 */
export function ManualHandoffPanel({
  app,
  handoff,
  onChanged,
  onMarkSubmitted,
}: {
  app: ApplicationView;
  handoff: Pick<UseQueryResult<ManualHandoffPackage>, "data" | "isLoading" | "error">;
  onChanged: (a?: ApplicationView) => void;
  onMarkSubmitted: () => void;
}) {
  const [retryOpen, setRetryOpen] = useState(false);
  const [retryChecked, setRetryChecked] = useState(false);
  const [approveOpen, setApproveOpen] = useState(false);
  const [approveChecked, setApproveChecked] = useState(false);
  const [prefill, setPrefill] = useState<{ code: string; expiresAt: string } | null>(null);

  const markOpened = useMutation({
    mutationFn: () => api<{ applyUrl: string }>(`/api/applications/${app.id}/mark-opened`, { body: {} }),
    onSuccess: () => onChanged(),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const retry = useMutation({
    mutationFn: () => api<ApplicationView>(`/api/applications/${app.id}/apply`, { body: { userConfirmed: true, retry: true, acknowledgeUncertain: uncertain && retryChecked } }),
    onSuccess: (a) => {
      setRetryOpen(false);
      onChanged(a);
      toast.success("Retry queued. Follow the progress on this page.");
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const approve = useMutation({
    mutationFn: () => api<ApplicationView>(`/api/applications/${app.id}/approve`, { body: { reviewedContent: true } }),
    onSuccess: (a) => {
      setApproveOpen(false);
      onChanged(a);
      toast.success("Approved and queued for submission. Follow the progress on this page.");
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const issuePrefill = useMutation({
    mutationFn: () => api<{ code: string; expiresAt: string }>(`/api/applications/${app.id}/prefill`, { body: {} }),
    onSuccess: setPrefill,
    onError: (e) => toast.error(errorMessage(e)),
  });
  const download = async (path: string, method: "GET" | "POST") => {
    try {
      await downloadFile(path, method);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const status = app.status;
  const a = app.automation;
  const reason = handoff.data?.reason ?? a.manualActionReason;
  const reasonLabel = handoff.data?.reasonLabel ?? a.manualActionLabel;
  const reasonDetail = handoff.data?.reasonDetail ?? a.manualActionDetail;
  const uncertain = reason === "SUBMISSION_UNCERTAIN";
  const automated = a.mode === "REVIEW" || a.mode === "AUTO";
  const handedBack = status === "MANUAL_ACTION_REQUIRED" || status === "FAILED";
  // An automatic retry is scheduled (the server sets nextActionAt only then): the automation still submits it.
  const retryPending = (status === "FAILED" || status === "MANUAL_ACTION_REQUIRED") && automated && !!a.nextActionAt;
  // A retry resends approved content only; never-approved or edited content is reviewed and approved first.
  const approved = !!app.approvedAt;
  const canRetry = handedBack && automated && !!app.tailored && approved && !retryPending;
  const canApprove = handedBack && automated && !!app.tailored && !approved && !uncertain;
  const canMarkSubmitted = ["MANUAL_ACTION_REQUIRED", "FAILED", "OPENED_APPLY_PAGE"].includes(status);
  const applyUrl = safeHttpUrl(handoff.data?.job.applyUrl ?? app.job.applyUrl);
  const hrEmail = handoff.data?.job.hrEmail ?? app.job.hrEmail;

  return (
    <Card className="border-amber-300 dark:border-amber-800" data-testid="manual-handoff">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Hand className="h-4 w-4" aria-hidden="true" /> {retryPending ? "Automatic retry scheduled" : "Manual handoff"}
        </CardTitle>
        <CardDescription>
          {status === "OPENED_APPLY_PAGE"
            ? "You opened the application page. Finish it there with the material below, then confirm that you submitted it."
            : retryPending
              ? `The last attempt failed, and the automation tries again after ${formatDateTime(a.nextActionAt)} - you do not need to do anything. If you prefer to apply yourself, open the application page from here: that stops the automation for this application.`
              : "The automation could not finish this application, so it is handed over to you. Everything you need to apply yourself is below."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5 text-sm">
        {reasonLabel || a.failureReason ? (
          <Alert variant={uncertain || status === "FAILED" ? "destructive" : "warning"}>
            <AlertTriangle className="h-4 w-4" aria-hidden="true" />
            <AlertTitle>{reasonLabel ?? "The automatic attempt failed"}</AlertTitle>
            <AlertDescription className="space-y-1">
              {reasonDetail ? <p>{reasonDetail}</p> : null}
              {a.failureReason && a.failureReason !== reasonDetail ? <p>{a.failureReason}</p> : null}
              {uncertain ? (
                <p className="font-medium">The previous attempt may already have reached the employer. Check your email and the employer&apos;s page before applying again.</p>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : null}

        <div className="flex flex-wrap gap-2">
          {applyUrl ? (
            <a
              href={applyUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={cn(buttonVariants())}
              data-testid="handoff-open-apply-page"
              onClick={() => {
                // The browser opens the official page in a new tab; we only record that the user opened it.
                if (!markOpened.isPending) markOpened.mutate();
              }}
            >
              <ExternalLink aria-hidden="true" /> Open application page
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          ) : null}
          {canMarkSubmitted ? (
            <Button variant="outline" onClick={onMarkSubmitted}>
              <CheckCircle2 aria-hidden="true" /> I submitted it myself
            </Button>
          ) : null}
          {canRetry ? (
            <Button
              variant="outline"
              onClick={() => {
                setRetryChecked(false);
                setRetryOpen(true);
              }}
            >
              <RotateCw aria-hidden="true" /> Retry automation
            </Button>
          ) : null}
          {canApprove ? (
            <Button
              variant="outline"
              onClick={() => {
                setApproveChecked(false);
                setApproveOpen(true);
              }}
            >
              <ShieldCheck aria-hidden="true" /> Review & approve
            </Button>
          ) : null}
        </div>
        {canApprove ? (
          <p className="text-muted-foreground">
            The prepared content is not approved in its current form. Check the tailored resume, cover letter and answers in the tabs below: the automation only submits content you
            approved.
          </p>
        ) : null}
        {!applyUrl ? (
          <p className="text-muted-foreground">
            {hrEmail ? `This job is applied to by email: send your application to ${hrEmail} (see the Email tab for the prepared draft).` : "This job has no application link. Follow the employer's instructions below."}
          </p>
        ) : null}

        {handoff.isLoading ? (
          <div className="space-y-2" aria-hidden="true">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-20 w-full" />
          </div>
        ) : handoff.error ? (
          <p className="text-destructive" role="alert">
            Could not load the handoff package: {errorMessage(handoff.error)}
          </p>
        ) : handoff.data ? (
          <HandoffContent pkg={handoff.data} onDownload={download} />
        ) : null}

        <div className="rounded-md border p-3">
          <p className="font-medium">Browser extension (optional)</p>
          <p className="text-muted-foreground">
            The {APP_NAME} extension can prefill the fields you choose on the application page with the material above. It never submits the form - you review everything and send it yourself.
          </p>
          <Button className="mt-2" variant="outline" size="sm" onClick={() => issuePrefill.mutate()} disabled={issuePrefill.isPending || retryPending}>
            Create extension prefill code
          </Button>
          {retryPending ? <p className="mt-1 text-xs text-muted-foreground">Available once the automatic retry is finished (or after you open the application page yourself).</p> : null}
          {prefill ? (
            <div className="mt-2 space-y-1">
              <div className="flex gap-2">
                <Input readOnly value={prefill.code} aria-label="Extension prefill code" onFocus={(e) => e.currentTarget.select()} />
                <CopyButton value={prefill.code} what="prefill code" />
              </div>
              <p className="text-xs text-muted-foreground">Expires {formatDateTime(prefill.expiresAt)}.</p>
            </div>
          ) : null}
        </div>
      </CardContent>

      <Dialog open={retryOpen} onOpenChange={setRetryOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Retry the automation?</DialogTitle>
            <DialogDescription>
              The automation tries to submit this application again with the prepared content, within your daily limit. A retry only helps if the cause above is fixed (for example, you reconnected the provider). If the
              provider does not allow automatic submission, the application comes back here for you to finish.
            </DialogDescription>
          </DialogHeader>
          {uncertain ? (
            <>
              <Alert variant="destructive">
                <AlertTriangle className="h-4 w-4" aria-hidden="true" />
                <AlertTitle>Risk of a duplicate application</AlertTitle>
                <AlertDescription>The last attempt was interrupted and may already have been sent. Retry only if you checked that the employer did not receive it.</AlertDescription>
              </Alert>
              <label className="flex items-start gap-2 text-sm">
                <Checkbox checked={retryChecked} onCheckedChange={(c) => setRetryChecked(c === true)} aria-label="I checked that it was not submitted" />
                I checked that it was not submitted, and I want the automation to try again.
              </label>
            </>
          ) : null}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRetryOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => retry.mutate()} disabled={retry.isPending || (uncertain && !retryChecked)}>
              {retry.isPending ? <Spinner label="Queuing retry" /> : <RotateCw aria-hidden="true" />}
              Yes, retry
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={approveOpen} onOpenChange={setApproveOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Approve and submit again?</DialogTitle>
            <DialogDescription>
              This approves the tailored resume, cover letter and answers exactly as they are now, and the automation then tries to submit the application with them, within your daily limit. A
              retry only helps if the cause above is fixed; otherwise the application comes back here for you to finish.
            </DialogDescription>
          </DialogHeader>
          <label className="flex items-start gap-2 text-sm">
            <Checkbox checked={approveChecked} onCheckedChange={(c) => setApproveChecked(c === true)} aria-label="I reviewed the content and approve it" />
            I reviewed the tailored resume, cover letter and answers, everything is true, and I want {APP_NAME} to submit this application on my behalf.
          </label>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setApproveOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => approve.mutate()} disabled={approve.isPending || !approveChecked}>
              {approve.isPending ? <Spinner label="Approving" /> : <ShieldCheck aria-hidden="true" />}
              Approve and submit
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function HandoffContent({ pkg, onDownload }: { pkg: ManualHandoffPackage; onDownload: (path: string, method: "GET" | "POST") => Promise<void> }) {
  const selectedId = pkg.resume.versionId ?? pkg.resume.resumeId;
  return (
    <div className="space-y-5">
      {pkg.match.score != null || pkg.match.summary ? (
        <p className="text-muted-foreground">
          {pkg.match.score != null ? <span className="font-medium text-foreground">Match score {Math.round(pkg.match.score)}. </span> : null}
          {pkg.match.summary}
        </p>
      ) : null}

      <section aria-labelledby="handoff-resume" className="space-y-2">
        <h3 id="handoff-resume" className="font-medium">
          Resume to attach
        </h3>
        {pkg.tailoredResume ? (
          <div className="flex flex-wrap items-center gap-2 rounded-md border p-3">
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{pkg.tailoredResume.label}</span>
              <span className="text-xs text-muted-foreground">Approved tailored version - recommended</span>
            </span>
            <Button size="sm" variant="outline" onClick={() => void onDownload(`/api/resumes/${pkg.tailoredResume!.versionId}/export/pdf`, "POST")} aria-label="Download tailored resume as PDF">
              <Download aria-hidden="true" /> PDF
            </Button>
            <Button size="sm" variant="outline" onClick={() => void onDownload(`/api/resumes/${pkg.tailoredResume!.versionId}/export/docx`, "POST")} aria-label="Download tailored resume as DOCX">
              <Download aria-hidden="true" /> DOCX
            </Button>
          </div>
        ) : null}
        {selectedId ? (
          <div className="flex flex-wrap items-center gap-2 rounded-md border p-3">
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{pkg.resume.label ?? "Selected resume"}</span>
              <span className="text-xs text-muted-foreground">{pkg.resume.reason ?? "Selected resume for this job"}</span>
            </span>
            <Button size="sm" variant="outline" onClick={() => void onDownload(`/api/resumes/${selectedId}/export/pdf`, "POST")} aria-label="Download selected resume as PDF">
              <Download aria-hidden="true" /> PDF
            </Button>
            <Button size="sm" variant="outline" onClick={() => void onDownload(`/api/resumes/${selectedId}/export/docx`, "POST")} aria-label="Download selected resume as DOCX">
              <Download aria-hidden="true" /> DOCX
            </Button>
            {pkg.resume.resumeId ? (
              <Button size="sm" variant="ghost" onClick={() => void onDownload(`/api/resumes/${pkg.resume.resumeId}/download`, "GET")} aria-label="Download the original uploaded resume file">
                <Download aria-hidden="true" /> Original file
              </Button>
            ) : null}
          </div>
        ) : null}
        {!pkg.tailoredResume && !selectedId ? (
          <p className="text-muted-foreground">
            No resume was selected for this job. Download one from the{" "}
            <a className="underline" href="/resume">
              Resume
            </a>{" "}
            page.
          </p>
        ) : null}
      </section>

      <section aria-labelledby="handoff-cover" className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id="handoff-cover" className="font-medium">
            Cover letter
          </h3>
          {pkg.coverLetter ? <CopyButton value={pkg.coverLetter} what="cover letter" /> : null}
        </div>
        {pkg.coverLetter ? (
          <pre role="region" aria-label="Cover letter text" tabIndex={0} className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/40 p-3 font-sans text-sm">
            {pkg.coverLetter}
          </pre>
        ) : (
          <p className="text-muted-foreground">No cover letter was prepared.</p>
        )}
      </section>

      <section aria-labelledby="handoff-answers" className="space-y-2">
        <h3 id="handoff-answers" className="font-medium">
          Prepared answers
        </h3>
        {pkg.screeningAnswers.length === 0 ? (
          <p className="text-muted-foreground">No verified answers were prepared for this job.</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {pkg.screeningAnswers.map((s, i) => (
              <li key={i} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-start">
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="font-medium">{s.question}</p>
                  <p className="whitespace-pre-wrap break-words">{s.answer}</p>
                  <Badge variant="outline">{ANSWER_SOURCE_LABELS[s.source] ?? s.source}</Badge>
                </div>
                <CopyButton value={s.answer} what={`answer to “${shorten(s.question)}”`} />
              </li>
            ))}
          </ul>
        )}
      </section>

      {pkg.instructions.length ? (
        <section aria-labelledby="handoff-steps" className="space-y-2">
          <h3 id="handoff-steps" className="font-medium">
            How to finish
          </h3>
          <ol className="list-decimal space-y-1 pl-5">
            {pkg.instructions.map((step, i) => (
              <li key={i}>{step}</li>
            ))}
          </ol>
        </section>
      ) : null}
    </div>
  );
}
