"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Ban, CheckCircle2, ExternalLink, Loader2, Mail, Send, ShieldCheck } from "lucide-react";
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
  Label,
  NativeSelect,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  toast,
} from "@applywise/ui";
import { api, errorMessage } from "@/lib/api";
import type { ApplicationView, EmailPreview } from "@/lib/client-types";
import { formatDateTime, statusLabel } from "@/lib/format";
import { VerifyEmailNotice } from "../verify-email-notice";
import { ANSWER_SOURCE_LABELS, statusBadgeVariant } from "./application-labels";
import { ApplicationTimeline } from "./application-timeline";
import { AutomationPanel } from "./automation-panel";
import { ResumeSelectionPanel } from "./resume-selection-panel";

// Shown in some statuses only (handoff, missing answers, approve & apply, decline): their code loads when first needed.
const panelLoading = () => <Skeleton className="h-40 w-full rounded-lg" />;
const ManualHandoffPanel = dynamic(() => import("./manual-handoff-panel").then((m) => m.ManualHandoffPanel), { loading: panelLoading });
const NeedsInformationForm = dynamic(() => import("./needs-information-form").then((m) => m.NeedsInformationForm), { loading: panelLoading });
const ApproveAndApplyDialog = dynamic(() => import("./review-actions").then((m) => m.ApproveAndApplyDialog));
const DeclineDialog = dynamic(() => import("./review-actions").then((m) => m.DeclineDialog));

type Bullet = { proposed: string; sourceFactIds: string[]; accepted: boolean };

const REVIEWABLE = ["READY_FOR_REVIEW"];
const APPROVED_LIKE = ["APPROVED", "OPENED_APPLY_PAGE", "EMAIL_DRAFT_READY"];
/** The automation handed the application to the user (the extension prefill and "I submitted it" apply too). */
const HANDOFF = ["MANUAL_ACTION_REQUIRED", "FAILED"];
/** Sent, or an employer response arrived. */
const SENT_OR_OUTCOME = ["SUBMITTED", "EMAIL_SENT", "APPLIED", "ASSESSMENT", "INTERVIEW", "OFFER", "REJECTED"];
/** Statuses from which drafts can be (re)generated; FAILED only when preparation itself failed. */
const PREPARABLE = ["SAVED", "READY_FOR_REVIEW", "APPROVED", "WAITING_APPROVAL", "DISCOVERED", "MATCHED", "REJECTED_BY_RULES", "AUTO_ELIGIBLE"];
/** Not sent yet: the user may decline (withdraw and hide the job). */
const DECLINABLE = ["WAITING_APPROVAL", "NEEDS_INFORMATION", "MANUAL_ACTION_REQUIRED", "FAILED", "DISCOVERED", "MATCHED", "REJECTED_BY_RULES", "AUTO_ELIGIBLE"];

/** Poll while the server is working on the application (preparation, queued or running submission). */
function pollInterval(app: ApplicationView | undefined): number | false {
  if (!app) return false;
  if (app.status === "PREPARING") return 1200;
  if (app.status === "APPLYING" || app.status === "MATCHING") return 2500;
  const automated = app.automation.mode === "REVIEW" || app.automation.mode === "AUTO";
  const deferred = app.automation.nextActionAt ? new Date(app.automation.nextActionAt).getTime() > Date.now() : false;
  if (app.status === "APPROVED" && automated && app.automation.executorKind !== "MANUAL" && !deferred) return 4000;
  return false;
}

/** The manual handoff: handed back to the user, or the user opened the apply page from a handoff. */
function handoffShown(app: ApplicationView): boolean {
  const auto = app.automation;
  // Keep the handoff visible after the user opened the page from it (the reason / failure / manual executor stay recorded).
  const handedOff = !!auto.manualActionReason || (auto.origin === "AUTOMATION" && (!!auto.failureReason || auto.executorKind === "MANUAL"));
  return app.status === "MANUAL_ACTION_REQUIRED" || (app.status === "FAILED" && !!app.tailored) || (app.status === "OPENED_APPLY_PAGE" && handedOff);
}

export function ApplicationWorkspace({ applicationId }: { applicationId: string }) {
  const qc = useQueryClient();
  const key = ["application", applicationId];
  const { data: app, isLoading, error } = useQuery({
    queryKey: key,
    queryFn: () => api<ApplicationView>(`/api/applications/${applicationId}`),
    refetchInterval: (q) => pollInterval(q.state.data),
  });
  // The handoff package is loaded only while the manual handoff is shown, alongside the panel's code.
  const handoff = useQuery({
    queryKey: [...key, "handoff"],
    queryFn: () => api<ManualHandoffPackage>(`/api/applications/${applicationId}/handoff`),
    enabled: !!app && handoffShown(app),
  });
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: key });
    void qc.invalidateQueries({ queryKey: ["jobs"] });
    void qc.invalidateQueries({ queryKey: ["automation", "review"] });
  };
  /** Mutations that return the fresh ApplicationView update the cache immediately, then refetch the rest. */
  const applied = (a?: ApplicationView) => {
    if (a) qc.setQueryData(key, a);
    invalidate();
  };

  // ---- editable state
  const [summary, setSummary] = useState("");
  const [bullets, setBullets] = useState<Bullet[]>([]);
  const [cover, setCover] = useState("");
  const [screening, setScreening] = useState<Record<string, string>>({});
  const [approveOpen, setApproveOpen] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [submittedOpen, setSubmittedOpen] = useState(false);
  const [submittedConfirm, setSubmittedConfirm] = useState(false);
  const [prefill, setPrefill] = useState<{ code: string; expiresAt: string } | null>(null);
  const [approveApplyOpen, setApproveApplyOpen] = useState(false);
  const [declineOpen, setDeclineOpen] = useState(false);

  useEffect(() => {
    if (!app) return;
    if (app.tailored) {
      setSummary(app.tailored.editedSummary ?? app.tailored.plan.summary.text);
      setBullets(app.tailored.editedBullets ?? app.tailored.plan.bulletChanges.map((b) => ({ proposed: b.proposed, sourceFactIds: b.sourceFactIds, accepted: true })));
    }
    if (app.coverLetter) setCover(app.coverLetter.body);
    setScreening(Object.fromEntries(app.screeningAnswers.map((s) => [s.id, s.answer])));
  }, [app]);

  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<{ application: ApplicationView; warnings: string[] }>(`/api/applications/${applicationId}`, { method: "PATCH", body }),
    onSuccess: (r) => {
      qc.setQueryData(key, r.application);
      invalidate();
      if (r.warnings.length) toast.warning(`Saved. Please double-check: ${r.warnings[0]}`);
      else toast.success("Saved.");
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const approve = useMutation({
    mutationFn: () => api<ApplicationView>(`/api/applications/${applicationId}/approve`, { body: { reviewedContent: true } }),
    onSuccess: (a) => {
      qc.setQueryData(key, a);
      invalidate();
      setApproveOpen(false);
      // Review/Auto: approving is the Review-mode approval, so the server also queued the submission.
      const automatedNow = a.automation.mode === "REVIEW" || a.automation.mode === "AUTO";
      toast.success(
        !automatedNow
          ? "Approved. Next: open the official page or prepare the email."
          : a.status === "PREPARING"
            ? "The drafts are prepared again with verified answers first - review and approve them once they are ready."
            : "Approved and queued for submission. Follow the progress on this page.",
      );
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const prepare = useMutation({
    mutationFn: () => api(`/api/jobs/${app!.job.id}/prepare-application`, { body: {} }),
    onSuccess: () => invalidate(),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const markOpened = useMutation({
    mutationFn: () => api<{ applyUrl: string }>(`/api/applications/${applicationId}/mark-opened`, { body: {} }),
    onSuccess: (r) => {
      // The user opens the official page themselves; we never submit anything on their behalf.
      window.open(r.applyUrl, "_blank", "noopener,noreferrer");
      invalidate();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const markSubmitted = useMutation({
    mutationFn: () => api<ApplicationView>(`/api/applications/${applicationId}/mark-submitted`, { body: { submittedByUser: true } }),
    onSuccess: (a) => {
      qc.setQueryData(key, a);
      invalidate();
      setSubmittedOpen(false);
      toast.success("Marked as submitted.");
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const issuePrefill = useMutation({
    mutationFn: () => api<{ code: string; expiresAt: string }>(`/api/applications/${applicationId}/prefill`, { body: {} }),
    onSuccess: setPrefill,
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading application…</p>;
  if (error || !app) return <p className="text-sm text-destructive">{errorMessage(error)}</p>;

  const approvedLike = APPROVED_LIKE.includes(app.status);
  const canApprove = REVIEWABLE.includes(app.status) && !!app.tailored;
  const isEmailJob = !!app.job.hrEmail;
  const auto = app.automation;
  const fromAutomation = auto.origin === "AUTOMATION";
  const automatedMode = auto.mode === "REVIEW" || auto.mode === "AUTO";
  const canPrepare = PREPARABLE.includes(app.status) || (app.status === "FAILED" && !app.tailored);
  // The automation will still submit it (queued, or an automatic retry is scheduled): no extension prefill meanwhile.
  const automationPending = automatedMode && (app.status === "APPROVED" || (app.status === "FAILED" && !!auto.nextActionAt));
  const showHandoff = handoffShown(app);
  const showNeedsInfo = app.status === "NEEDS_INFORMATION";
  const sentOrOutcome = SENT_OR_OUTCOME.includes(app.status);
  const showReasonLine = !!auto.manualActionLabel && (HANDOFF.includes(app.status) || app.status === "OPENED_APPLY_PAGE");

  const contextPanels = (
    <div className="grid gap-4 @3xl:grid-cols-2">
      <AutomationPanel app={app} />
      <ResumeSelectionPanel app={app} onChanged={applied} />
    </div>
  );

  const timelineCard = (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Activity</CardTitle>
      </CardHeader>
      <CardContent>
        <ApplicationTimeline events={app.events} messages={app.messages} />
        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="reminder">Follow-up reminder</Label>
            <Input
              id="reminder"
              type="datetime-local"
              defaultValue={toLocalInput(app.reminderAt)}
              onBlur={(e) => {
                // datetime-local is in the user's time zone; only save real changes.
                if (e.target.value === toLocalInput(app.reminderAt)) return;
                patch.mutate({ reminderAt: e.target.value ? new Date(e.target.value).toISOString() : null });
              }}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="notes">Notes</Label>
            <Textarea id="notes" rows={2} defaultValue={app.notes ?? ""} onBlur={(e) => e.target.value !== (app.notes ?? "") && patch.mutate({ notes: e.target.value })} />
          </div>
        </div>
      </CardContent>
    </Card>
  );

  return (
    <div className="@container space-y-4" data-testid="application-workspace">
      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <CardDescription>Application status</CardDescription>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <Badge data-testid="application-status" variant={approvedLike ? "success" : statusBadgeVariant(app.status)}>
                {statusLabel(app.status)}
              </Badge>
              {app.status === "PREPARING" ? (
                <span className="flex items-center gap-1 text-sm text-muted-foreground" role="status">
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Generating drafts for your review…
                </span>
              ) : null}
              {app.status === "APPLYING" ? (
                <span className="flex items-center gap-1 text-sm text-muted-foreground" role="status">
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> The automation is submitting this application…
                </span>
              ) : null}
            </div>
            {showReasonLine ? <p className="mt-1 text-sm text-amber-700 dark:text-amber-300">{auto.manualActionLabel}</p> : null}
            {auto.nextAction ? (
              <p className="mt-1 text-sm text-muted-foreground" aria-live="polite" data-testid="application-next-action">
                Next: {auto.nextAction}
              </p>
            ) : null}
            {app.preparationError ? <p className="mt-1 text-sm text-destructive">Preparation failed: {app.preparationError}</p> : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {canPrepare ? (
              <Button variant="outline" onClick={() => prepare.mutate()} disabled={prepare.isPending}>
                {app.tailored ? "Regenerate drafts" : app.status === "REJECTED_BY_RULES" ? "Prepare anyway" : "Prepare application"}
              </Button>
            ) : null}
            <Button onClick={() => { setReviewed(false); setApproveOpen(true); }} disabled={!canApprove}>
              <ShieldCheck /> Review & approve
            </Button>
            {app.status === "WAITING_APPROVAL" ? (
              <Button onClick={() => setApproveApplyOpen(true)} disabled={!app.tailored} data-testid="approve-and-apply">
                <Send aria-hidden="true" /> Approve & apply
              </Button>
            ) : null}
            {DECLINABLE.includes(app.status) ? (
              <Button variant="outline" onClick={() => setDeclineOpen(true)}>
                <Ban aria-hidden="true" /> Decline
              </Button>
            ) : null}
            {app.trackingOptions.length ? (
              <NativeSelect
                aria-label="Update tracking status"
                className="w-44"
                value=""
                onChange={(e) => e.target.value && patch.mutate({ status: e.target.value })}
              >
                <option value="">Update status…</option>
                {app.trackingOptions.map((s) => (
                  <option key={s} value={s}>
                    {statusLabel(s)}
                  </option>
                ))}
              </NativeSelect>
            ) : null}
          </div>
        </CardHeader>
      </Card>

      {showNeedsInfo ? (
        auto.pendingQuestions.length ? (
          <NeedsInformationForm key={auto.pendingQuestions.map((q) => q.key).join("|")} app={app} onSaved={applied} />
        ) : (
          <Alert variant="warning">
            <AlertTriangle className="h-4 w-4" aria-hidden="true" />
            <AlertTitle>Information needed</AlertTitle>
            <AlertDescription>
              <p>No open questions are recorded for this application any more. Prepare it again to continue.</p>
              <Button className="mt-2" size="sm" variant="outline" onClick={() => prepare.mutate()} disabled={prepare.isPending}>
                Prepare again
              </Button>
            </AlertDescription>
          </Alert>
        )
      ) : null}

      {showHandoff ? <ManualHandoffPanel app={app} handoff={handoff} onChanged={applied} onMarkSubmitted={() => { setSubmittedConfirm(false); setSubmittedOpen(true); }} /> : null}

      {fromAutomation ? contextPanels : null}

      {!app.tailored && app.status !== "PREPARING" ? (
        <Alert variant="info">
          <AlertTitle>Nothing generated yet</AlertTitle>
          <AlertDescription>Answer the job questions first for better results, then prepare the application. Drafts are proposals only.</AlertDescription>
        </Alert>
      ) : null}

      {app.tailored ? (
        <Tabs defaultValue="resume">
          <TabsList>
            <TabsTrigger value="resume">Tailored resume</TabsTrigger>
            <TabsTrigger value="cover">Cover letter</TabsTrigger>
            <TabsTrigger value="screening">Screening answers ({app.screeningAnswers.length})</TabsTrigger>
            {isEmailJob ? <TabsTrigger value="email">Email</TabsTrigger> : null}
            <TabsTrigger value="apply">Apply</TabsTrigger>
            <TabsTrigger value="timeline">Timeline</TabsTrigger>
          </TabsList>

          <TabsContent value="resume" className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Proposal</CardTitle>
                <CardDescription>
                  {generatedWith(app.tailored.provider, app.tailored.modelId)} · {app.tailored.promptVersion}. Every claim cites your verified facts.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-1">
                  <Label htmlFor="tailored-summary">Professional summary</Label>
                  <Textarea id="tailored-summary" rows={4} value={summary} onChange={(e) => setSummary(e.target.value)} />
                  <p className="text-xs text-muted-foreground">Sources: {app.tailored.plan.summary.sourceFactIds.join(", ") || "none"}</p>
                </div>
                <div className="space-y-3">
                  <p className="text-sm font-medium">Bullet suggestions</p>
                  {app.tailored.plan.bulletChanges.map((b, i) => (
                    <div key={i} className="space-y-1 rounded-md border p-3" data-testid="bullet-change">
                      <label className="flex items-center gap-2 text-sm">
                        <Checkbox
                          checked={bullets[i]?.accepted ?? true}
                          onCheckedChange={(c) => setBullets((bs) => bs.map((x, j) => (j === i ? { ...x, accepted: c === true } : x)))}
                          aria-label={`Use suggestion ${i + 1}`}
                        />
                        Use this bullet <Badge variant="outline">{b.confidence}</Badge>
                      </label>
                      <Textarea
                        rows={2}
                        aria-label={`Bullet ${i + 1}`}
                        value={bullets[i]?.proposed ?? b.proposed}
                        onChange={(e) => setBullets((bs) => bs.map((x, j) => (j === i ? { ...x, proposed: e.target.value } : x)))}
                      />
                      <p className="text-xs text-muted-foreground">{b.rationale}</p>
                    </div>
                  ))}
                </div>
                {app.tailored.plan.warnings.length ? (
                  <Alert variant="warning">
                    <AlertTriangle className="h-4 w-4" />
                    <AlertTitle>Not added (no verified evidence)</AlertTitle>
                    <AlertDescription>
                      <ul className="list-disc pl-4">
                        {app.tailored.plan.warnings.map((w) => (
                          <li key={w}>{w}</li>
                        ))}
                      </ul>
                    </AlertDescription>
                  </Alert>
                ) : null}
                {app.tailored.validation.unsupportedClaims?.filter((u) => u.severity !== "low").length ? (
                  <Alert variant="warning">
                    <AlertTitle>Claims to double-check</AlertTitle>
                    <AlertDescription>
                      <ul className="list-disc pl-4">
                        {app.tailored.validation.unsupportedClaims.filter((u) => u.severity !== "low").slice(0, 5).map((u, i) => (
                          <li key={i}>{u.reason}</li>
                        ))}
                      </ul>
                    </AlertDescription>
                  </Alert>
                ) : null}
                <Button onClick={() => patch.mutate({ tailoredSummary: summary, tailoredBullets: bullets })} disabled={patch.isPending}>
                  Save resume edits
                </Button>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Preview (ATS-readable, single column)</CardTitle>
                <CardDescription>Plain headings, no tables or graphics. No ATS compatibility is guaranteed.</CardDescription>
              </CardHeader>
              <CardContent>
                {/* Rendered server-side from escaped content by the resume engine. */}
                <div className="max-h-[640px] overflow-auto rounded-md border bg-white p-4 text-black" dangerouslySetInnerHTML={{ __html: app.tailored.previewHtml ?? "" }} />
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="cover">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Cover letter</CardTitle>
                <CardDescription>
                  Edit freely. Keep every statement true.
                  {app.coverLetter ? ` ${generatedWith(app.coverLetter.provider, app.coverLetter.modelId)}.` : null}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <Textarea aria-label="Cover letter" rows={16} value={cover} onChange={(e) => setCover(e.target.value)} />
                <Button onClick={() => patch.mutate({ coverLetter: cover })} disabled={patch.isPending}>
                  Save cover letter
                </Button>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="screening">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Employer screening answers</CardTitle>
                <CardDescription>
                  Drafted only from your verified facts and answers.
                  {app.screeningAnswers[0] ? ` ${generatedWith(app.screeningAnswers[0].provider, app.screeningAnswers[0].modelId)}.` : null}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {app.screeningAnswers.length === 0 ? <p className="text-sm text-muted-foreground">This job has no screening questions.</p> : null}
                {app.screeningAnswers.map((s) => (
                  <div key={s.id} className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Label htmlFor={`sa-${s.id}`}>{s.question}</Label>
                      {s.required ? <Badge variant="outline">Required</Badge> : null}
                      {s.resolved ? <Badge variant="secondary">{ANSWER_SOURCE_LABELS[s.source] ?? s.source}</Badge> : <Badge variant="warning">No verified answer yet</Badge>}
                    </div>
                    {!s.resolved ? (
                      <p className="flex items-center gap-1 text-xs text-amber-700 dark:text-amber-300">
                        <AlertTriangle className="h-3 w-3" aria-hidden="true" /> No verified answer yet - write your own answer. The automation never sends guessed answers.
                      </p>
                    ) : !s.canConfirm ? (
                      <p className="flex items-center gap-1 text-xs text-amber-700 dark:text-amber-300">
                        <AlertTriangle className="h-3 w-3" /> No verified evidence - answer this yourself.
                      </p>
                    ) : null}
                    <Textarea id={`sa-${s.id}`} rows={3} value={screening[s.id] ?? ""} onChange={(e) => setScreening({ ...screening, [s.id]: e.target.value })} />
                  </div>
                ))}
                {app.screeningAnswers.length ? (
                  <Button onClick={() => patch.mutate({ screeningAnswers: Object.entries(screening).map(([id, answer]) => ({ id, answer })) })} disabled={patch.isPending}>
                    Save answers
                  </Button>
                ) : null}
              </CardContent>
            </Card>
          </TabsContent>

          {isEmailJob ? (
            <TabsContent value="email">
              <EmailComposer app={app} onChanged={invalidate} />
            </TabsContent>
          ) : null}

          <TabsContent value="apply">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Apply on the official page</CardTitle>
                {automatedMode ? (
                  <CardDescription>
                    In {auto.mode === "AUTO" ? "Auto" : "Review"} mode, approved applications are submitted by the automation only where the provider supports it - everything else is handed over to you. You can always apply
                    on the official page yourself instead.
                  </CardDescription>
                ) : (
                  <CardDescription>You complete and submit the application yourself. {`${process.env.NEXT_PUBLIC_APP_NAME ?? "ApplyWise"}`} never clicks Submit.</CardDescription>
                )}
              </CardHeader>
              <CardContent className="space-y-4 text-sm">
                {app.job.applicationInstructions ? <p className="text-muted-foreground">Instructions: {app.job.applicationInstructions}</p> : null}
                {!approvedLike && !HANDOFF.includes(app.status) && !sentOrOutcome && app.status !== "APPLYING" ? (
                  <Alert variant="info">
                    <AlertDescription>Approve the application content first.</AlertDescription>
                  </Alert>
                ) : null}
                {app.status === "APPROVED" && automatedMode && auto.executorKind !== "MANUAL" ? (
                  <Alert variant="info">
                    <AlertDescription>This application is queued for automatic submission. If you open the official page and apply yourself, the automation stops for it.</AlertDescription>
                  </Alert>
                ) : null}
                {app.job.applyUrl ? (
                  <div className="flex flex-wrap gap-2">
                    <Button onClick={() => markOpened.mutate()} disabled={!(approvedLike || HANDOFF.includes(app.status)) || markOpened.isPending} data-testid="open-apply-page">
                      <ExternalLink /> Open official apply page
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => { setSubmittedConfirm(false); setSubmittedOpen(true); }}
                      disabled={![...APPROVED_LIKE, ...HANDOFF].includes(app.status)}
                    >
                      <CheckCircle2 /> I submitted it myself
                    </Button>
                  </div>
                ) : (
                  <p className="text-muted-foreground">This job has no apply URL{isEmailJob ? " - use the Email tab." : "."}</p>
                )}
                {app.job.applyUrl ? (
                  <div className="rounded-md border p-3">
                    <p className="font-medium">Browser-extension prefill (optional)</p>
                    <p className="text-muted-foreground">
                      Create a 10-minute code, paste it into the {process.env.NEXT_PUBLIC_APP_NAME ?? "ApplyWise"} extension on the official form, review the field list and choose what to fill. Files are never uploaded automatically and Submit is never clicked.
                    </p>
                    <Button
                      className="mt-2"
                      variant="outline"
                      size="sm"
                      onClick={() => issuePrefill.mutate()}
                      disabled={!["APPROVED", "OPENED_APPLY_PAGE", ...HANDOFF].includes(app.status) || automationPending || issuePrefill.isPending}
                    >
                      Create prefill code
                    </Button>
                    {prefill ? (
                      <div className="mt-2 space-y-1">
                        <Input readOnly value={prefill.code} aria-label="Prefill code" onFocus={(e) => e.currentTarget.select()} />
                        <p className="text-xs text-muted-foreground">Expires {formatDateTime(prefill.expiresAt)}.</p>
                      </div>
                    ) : null}
                  </div>
                ) : null}
                {app.resumeVersions.length ? (
                  <p className="text-xs text-muted-foreground">
                    Approved resume: attach it yourself on the form - download from the <a className="underline" href="/resume">Resume</a> page.
                  </p>
                ) : null}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="timeline">{timelineCard}</TabsContent>
        </Tabs>
      ) : (
        timelineCard
      )}

      {!fromAutomation ? contextPanels : null}

      {/* Mounted while their button is shown (so they are ready when clicked) or while open. */}
      {app.status === "WAITING_APPROVAL" || approveApplyOpen ? <ApproveAndApplyDialog app={app} open={approveApplyOpen} onOpenChange={setApproveApplyOpen} onDone={applied} /> : null}
      {DECLINABLE.includes(app.status) || declineOpen ? <DeclineDialog app={app} open={declineOpen} onOpenChange={setDeclineOpen} onDone={applied} /> : null}

      <Dialog open={approveOpen} onOpenChange={setApproveOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{automatedMode ? "Approve and submit this application?" : "Approve application content"}</DialogTitle>
            <DialogDescription>
              {automatedMode
                ? `${auto.mode === "AUTO" ? "Auto" : "Review"} mode: your approval also queues this application for automatic submission with exactly this content, within your daily limit. Where automatic submission is not available for this job, it is handed back to you to finish on the official page instead.`
                : "Approval creates a tailored resume version from your accepted edits. Nothing is sent or submitted."}
            </DialogDescription>
          </DialogHeader>
          <label className="flex items-start gap-2 text-sm">
            <Checkbox checked={reviewed} onCheckedChange={(c) => setReviewed(c === true)} aria-label="I reviewed all content" />
            {automatedMode
              ? `I reviewed the tailored resume, cover letter and screening answers, everything is true, and I want ${process.env.NEXT_PUBLIC_APP_NAME ?? "ApplyWise"} to submit this application on my behalf.`
              : "I reviewed the tailored resume, cover letter and screening answers, and everything is true."}
          </label>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setApproveOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => approve.mutate()} disabled={!reviewed || approve.isPending}>
              {automatedMode ? "Approve and submit" : "Approve"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={submittedOpen} onOpenChange={setSubmittedOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Mark as submitted</DialogTitle>
            <DialogDescription>Only do this after you clicked the final submit button on the official page yourself.</DialogDescription>
          </DialogHeader>
          <label className="flex items-start gap-2 text-sm">
            <Checkbox checked={submittedConfirm} onCheckedChange={(c) => setSubmittedConfirm(c === true)} aria-label="I submitted it myself" />
            I submitted this application myself on {app.job.company}&apos;s official page.
          </label>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setSubmittedOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => markSubmitted.mutate()} disabled={!submittedConfirm || markSubmitted.isPending}>
              Mark submitted
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** ISO timestamp -> "YYYY-MM-DDTHH:mm" in the browser's time zone (datetime-local value). */
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

/** Where a draft came from, for the "Generated with ..." captions. */
function generatedWith(provider: string, modelId: string | null): string {
  if (provider === "fallback") return "Deterministic draft (no AI model used)";
  if (provider === "user") return "Written by you";
  return `Generated with ${modelId ?? provider}`;
}

function EmailComposer({ app, onChanged }: { app: ApplicationView; onChanged: () => void }) {
  const qc = useQueryClient();
  const draft = app.emailDraft;
  const approvedVersions = app.resumeVersions.filter((v) => v.approvedAt);
  const [form, setForm] = useState({
    to: draft?.to ?? app.job.hrEmail ?? "",
    cc: (draft?.cc ?? []).join(", "),
    subject: draft?.subject ?? "",
    body: draft?.body ?? "",
    resumeVersionId: draft?.resumeVersionId ?? approvedVersions[0]?.id ?? "",
    attachCoverLetter: draft?.attachCoverLetter ?? false,
  });
  const [preview, setPreview] = useState<EmailPreview | null>(null);
  const [confirmSend, setConfirmSend] = useState(false);
  const canPreview = ["APPROVED", "EMAIL_DRAFT_READY"].includes(app.status);

  const previewM = useMutation({
    mutationFn: () =>
      api<EmailPreview>(`/api/applications/${app.id}/email/preview`, {
        body: {
          to: form.to.trim(),
          cc: form.cc.split(",").map((c) => c.trim()).filter(Boolean),
          subject: form.subject,
          body: form.body,
          resumeVersionId: form.resumeVersionId || null,
          attachCoverLetter: form.attachCoverLetter,
        },
      }),
    onSuccess: (p) => {
      setConfirmSend(false);
      setPreview(p);
      onChanged();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const send = useMutation({
    mutationFn: () => api(`/api/applications/${app.id}/email/send`, { body: { confirmationToken: preview!.confirmationToken, userConfirmed: true, consentToSend: true } }),
    onSuccess: () => {
      setPreview(null);
      toast.success("Email queued for sending.");
      for (const d of [800, 2000, 4000]) setTimeout(() => void qc.invalidateQueries({ queryKey: ["application", app.id] }), d);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (draft?.status === "SENT") {
    return (
      <Alert variant="info">
        <Mail className="h-4 w-4" />
        <AlertTitle>Email sent</AlertTitle>
        <AlertDescription>Sent {formatDateTime(draft.sentAt)} to {draft.to}.</AlertDescription>
      </Alert>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Email application</CardTitle>
        <CardDescription>
          Edit everything. Nothing is sent without the final confirmation screen.
          {draft ? ` ${generatedWith(draft.provider, draft.modelId)}.` : null}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {!canPreview ? (
          <Alert variant="info">
            <AlertDescription>Approve the application content before previewing the final email.</AlertDescription>
          </Alert>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="em-to">To</Label>
            <Input id="em-to" type="email" value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="em-cc">Cc (optional, comma separated)</Label>
            <Input id="em-cc" value={form.cc} onChange={(e) => setForm({ ...form, cc: e.target.value })} />
          </div>
        </div>
        <div className="space-y-1">
          <Label htmlFor="em-subject">Subject</Label>
          <Input id="em-subject" value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="em-body">Body</Label>
          <Textarea id="em-body" rows={12} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} />
          <p className="text-xs text-muted-foreground">{form.body.split(/\s+/).filter(Boolean).length} words (aim for 120-180)</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="em-resume">Attach resume version</Label>
            <NativeSelect id="em-resume" value={form.resumeVersionId} onChange={(e) => setForm({ ...form, resumeVersionId: e.target.value })}>
              <option value="">No resume</option>
              {approvedVersions.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                </option>
              ))}
            </NativeSelect>
          </div>
          <label className="flex items-center gap-2 pt-6 text-sm">
            <Checkbox checked={form.attachCoverLetter} onCheckedChange={(c) => setForm({ ...form, attachCoverLetter: c === true })} aria-label="Attach cover letter" />
            Attach the approved cover letter
          </label>
        </div>
        <div>
          <Button onClick={() => previewM.mutate()} disabled={!canPreview || previewM.isPending} data-testid="email-preview">
            Preview final email
          </Button>
        </div>
      </CardContent>

      <Dialog open={!!preview} onOpenChange={(o) => !o && setPreview(null)}>
        <DialogContent data-testid="email-confirmation">
          <DialogHeader>
            <DialogTitle>Final check before sending</DialogTitle>
            <DialogDescription>This is exactly what will be sent. Confirm every detail.</DialogDescription>
          </DialogHeader>
          {preview ? (
            <div className="space-y-3 text-sm">
              <dl className="grid grid-cols-[6rem_1fr] gap-1">
                <dt className="text-muted-foreground">From</dt>
                <dd>{preview.from}{preview.replyTo ? ` (replies to ${preview.replyTo})` : ""}</dd>
                <dt className="text-muted-foreground">To</dt>
                <dd data-testid="confirm-to">{preview.to}{!preview.recipientMatchesJob ? <Badge variant="warning" className="ml-2">Differs from job posting</Badge> : null}</dd>
                {preview.cc.length ? (
                  <>
                    <dt className="text-muted-foreground">Cc</dt>
                    <dd>{preview.cc.join(", ")}</dd>
                  </>
                ) : null}
                <dt className="text-muted-foreground">Subject</dt>
                <dd data-testid="confirm-subject">{preview.subject}</dd>
                <dt className="text-muted-foreground">Attachments</dt>
                <dd data-testid="confirm-attachments">
                  {preview.attachments.length ? preview.attachments.map((a) => `${a.filename} (${Math.ceil(a.sizeBytes / 1024)} KB)`).join(", ") : "None"}
                </dd>
              </dl>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/40 p-3 font-sans" data-testid="confirm-body">
                {preview.body}
              </pre>
              <p className="text-xs text-muted-foreground">Provider: {preview.provider.label}. Confirmation expires {formatDateTime(preview.expiresAt)}.</p>
              {!preview.senderVerified ? (
                <VerifyEmailNotice email={preview.senderEmail} {...preview.senderVerification} compact />
              ) : !preview.emailSendingConsent ? (
                <Alert variant="warning">
                  <AlertDescription>
                    Sending from the app is off. Enable “Email sending” in <a className="underline" href="/settings/privacy">Settings → Privacy</a>, or open the draft in your own email client (attach the resume yourself).
                  </AlertDescription>
                </Alert>
              ) : (
                <label className="flex items-start gap-2">
                  <Checkbox checked={confirmSend} onCheckedChange={(c) => setConfirmSend(c === true)} aria-label="I confirm and consent to send" />
                  I have reviewed the recipient, subject, body and attachments, and I consent to sending this email now.
                </label>
              )}
            </div>
          ) : null}
          <DialogFooter>
            {preview ? (
              <a className="inline-flex h-10 items-center justify-center rounded-md border px-4 text-sm font-medium hover:bg-accent" href={preview.mailtoUrl}>
                Open in my email client
              </a>
            ) : null}
            <Button onClick={() => send.mutate()} disabled={!preview?.canSendFromApp || !confirmSend || send.isPending} data-testid="confirm-send">
              Send from {process.env.NEXT_PUBLIC_APP_NAME ?? "ApplyWise"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
