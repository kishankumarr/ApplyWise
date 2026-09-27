"use client";

import Link from "next/link";
import { useState } from "react";
import { AlertTriangle, Bot, ExternalLink, Hand } from "lucide-react";
import { APPLICATION_MODE_LABELS, AUTOMATION_DECISION_LABELS, MANUAL_ACTION_REASON_LABELS, type ReviewQueueItem } from "@applywise/types";
import { Alert, AlertDescription, AlertTitle, Badge, Card, CardContent, CardFooter, CardHeader } from "@applywise/ui";
import { platformLabel, plural, relativeDate, statusLabel, WORK_MODE_LABELS, yoeRange } from "@/lib/format";
import { ApproveControl, EditLink, RejectControl, SkipControl } from "./review-actions";
import { AnswersTable, PendingQuestionsForm } from "./review-answers";
import { MatchBreakdown } from "./review-match";
import { ResumeSection } from "./review-resume";
import { EXECUTOR_KIND_LABELS, effectiveMode, salaryText, submitsAutomatically, titleIdFor, usesTailoredResume, type ReviewContext } from "./review-shared";

const STATUS_VARIANT: Record<string, "warning" | "info" | "secondary"> = {
  NEEDS_INFORMATION: "warning",
  WAITING_APPROVAL: "info",
  READY_FOR_REVIEW: "secondary",
};

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-1">
      <dt className="text-muted-foreground">{label}:</dt>
      <dd className="font-medium text-foreground">{children}</dd>
    </div>
  );
}

/** One prepared application with everything needed to decide: job, match, decision, content, answers and actions. */
export function ReviewCard({ item, ctx }: { item: ReviewQueueItem; ctx: ReviewContext }) {
  const id = item.applicationId;
  const h = (part: string) => `review-${id}-${part}`;
  const { job } = item;
  const mode = effectiveMode(item, ctx.settingsMode);
  const automatic = submitsAutomatically(item, mode);
  const salary = salaryText(job.salaryMin, job.salaryMax, job.currency);
  const experience = yoeRange(job.experienceMinYears, job.experienceMaxYears);
  const source = ctx.providerLabels[job.providerId] ?? platformLabel(job.platform);
  const needsInfo = item.status === "NEEDS_INFORMATION";
  const tailoredUsed = usesTailoredResume(item, ctx.tailorResume);
  const requiredPending = item.pendingQuestions.filter((q) => q.required).length;

  return (
    <Card>
      <article aria-labelledby={titleIdFor(id)} data-testid="review-card">
        <CardHeader className="gap-3 space-y-0 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={STATUS_VARIANT[item.status] ?? "outline"}>{statusLabel(item.status)}</Badge>
              <Badge variant="outline">{APPLICATION_MODE_LABELS[mode]} mode</Badge>
              {job.isDemo ? <Badge variant="info">Demo</Badge> : null}
            </div>
            <h2 id={titleIdFor(id)} tabIndex={-1} className="text-lg font-semibold leading-tight focus:outline-none focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring">
              <Link href={`/jobs/${job.id}`} className="hover:underline">
                {job.title}
              </Link>
            </h2>
            <p className="text-sm text-muted-foreground">
              <span className="font-medium text-foreground">{job.company}</span>
              {" · "}
              {job.locations.length ? job.locations.join(", ") : "Location not stated"}
              {" · "}
              {WORK_MODE_LABELS[job.workMode] ?? job.workMode}
            </p>
            <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
              <Meta label="Salary">{salary ?? "Not stated"}</Meta>
              <Meta label="Experience">{experience === "—" ? "Not stated" : experience}</Meta>
              <Meta label="Source">{source}</Meta>
              <Meta label="Posted">{job.postedAt ? relativeDate(job.postedAt) : "Not stated"}</Meta>
            </dl>
          </div>
          {job.applyUrl ? (
            <a href={job.applyUrl} target="_blank" rel="noopener noreferrer" className="inline-flex shrink-0 items-center gap-1 text-sm text-primary underline-offset-4 hover:underline">
              Official job page <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              <span className="sr-only">(opens in a new tab)</span>
            </a>
          ) : null}
        </CardHeader>

        <CardContent className="space-y-6">
          {needsInfo ? (
            <Alert variant="warning" role="note">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Needs your answers</AlertTitle>
              <AlertDescription>
                {item.pendingQuestions.length
                  ? `${plural(item.pendingQuestions.length, "question")} ${item.pendingQuestions.length === 1 ? "has" : "have"} no verified answer${requiredPending ? ` (${requiredPending} required)` : ""}. Answer below to continue.`
                  : "A required question has no verified answer. Open Edit to answer it."}
              </AlertDescription>
            </Alert>
          ) : null}
          {item.warnings.length ? (
            <Alert variant="warning" role="note">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Check before approving</AlertTitle>
              <AlertDescription>
                <ul className="list-disc space-y-0.5 pl-4">
                  {item.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          ) : null}

          <div className="grid gap-6 lg:grid-cols-2">
            <div className="space-y-6">
              <MatchBreakdown match={item.match} headingId={h("match")} />
              <section aria-labelledby={h("decision")} className="space-y-2">
                <h3 id={h("decision")} className="text-sm font-semibold">
                  Automation decision
                </h3>
                {item.decision.decision ? (
                  <Badge variant={item.decision.decision === "AUTO_ELIGIBLE" ? "success" : "outline"}>{AUTOMATION_DECISION_LABELS[item.decision.decision]}</Badge>
                ) : (
                  <p className="text-sm text-muted-foreground">Not evaluated by your rules (you prepared this application yourself).</p>
                )}
                {item.decision.reasons.length ? (
                  <ul className="list-disc space-y-0.5 pl-5 text-sm text-muted-foreground" aria-label="Reasons">
                    {item.decision.reasons.map((r) => (
                      <li key={r}>{r}</li>
                    ))}
                  </ul>
                ) : item.decision.decision ? (
                  <p className="text-sm text-muted-foreground">Every rule check passed.</p>
                ) : null}
              </section>
            </div>

            <div className="space-y-6">
              <ResumeSection item={item} headingId={h("resume")} />
              <section aria-labelledby={h("tailored")} className="space-y-2">
                <h3 id={h("tailored")} className="text-sm font-semibold">
                  Tailored resume summary
                </h3>
                {item.tailored ? (
                  <>
                    {item.tailored.summary ? <p className="whitespace-pre-wrap text-sm">{item.tailored.summary}</p> : <p className="text-sm text-muted-foreground">No summary.</p>}
                    <p className="text-xs text-muted-foreground">
                      {tailoredUsed
                        ? "Approving uses this tailored resume, built only from your verified profile."
                        : "Resume tailoring is off in your automation settings - the selected resume is used as-is."}
                    </p>
                    {item.tailored.unsupportedClaims > 0 ? (
                      <Alert variant="warning" role="note">
                        <AlertTriangle className="h-4 w-4" />
                        <AlertDescription>
                          {plural(item.tailored.unsupportedClaims, "claim")} could not be matched to your verified facts. Use Edit to fix or remove{" "}
                          {item.tailored.unsupportedClaims === 1 ? "it" : "them"} before approving.
                        </AlertDescription>
                      </Alert>
                    ) : null}
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">Not prepared yet.</p>
                )}
              </section>
              <section aria-labelledby={h("cover")} className="space-y-2">
                <h3 id={h("cover")} className="text-sm font-semibold">
                  Cover letter
                </h3>
                {item.coverLetter?.trim() ? (
                  <CoverLetterDetails text={item.coverLetter} />
                ) : (
                  <p className="text-sm text-muted-foreground">No cover letter prepared.</p>
                )}
              </section>
              <SubmissionSection item={item} mode={mode} automatic={automatic} headingId={h("submit")} />
            </div>
          </div>

          <AnswersTable answers={item.answers} headingId={h("answers")} />
          {needsInfo && item.pendingQuestions.length ? <PendingQuestionsForm item={item} ctx={ctx} headingId={h("pending")} /> : null}
        </CardContent>

        <CardFooter className="flex-wrap gap-2 border-t pt-5">
          <ApproveControl item={item} ctx={ctx} hintId={h("approve-hint")} />
          <EditLink item={item} />
          <RejectControl item={item} ctx={ctx} />
          <SkipControl item={item} ctx={ctx} />
        </CardFooter>
      </article>
    </Card>
  );
}

/** Collapsed by default; the letter itself is only rendered once it is opened (a page shows up to 10 cards). */
function CoverLetterDetails({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="rounded-md border" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="cursor-pointer rounded-md px-3 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        Show cover letter <span className="font-normal text-muted-foreground">({plural(text.trim().split(/\s+/).length, "word")})</span>
      </summary>
      {open ? <div className="max-h-96 overflow-auto whitespace-pre-wrap border-t px-3 py-2 text-sm">{text}</div> : null}
    </details>
  );
}

function SubmissionSection({ item, mode, automatic, headingId }: { item: ReviewQueueItem; mode: ReturnType<typeof effectiveMode>; automatic: boolean; headingId: string }) {
  return (
    <section aria-labelledby={headingId} className="space-y-2">
      <h3 id={headingId} className="text-sm font-semibold">
        How it would be submitted
      </h3>
      {mode === "MANUAL" ? (
        <p className="flex items-start gap-2 text-sm">
          <Hand className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span>Manual mode - nothing is submitted for you. After you approve, you apply on the official page yourself and mark it as submitted.</span>
        </p>
      ) : automatic && item.executor ? (
        <p className="flex items-start gap-2 text-sm">
          <Bot className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span>
            After you approve: submitted through <strong>{item.executor.label}</strong> ({EXECUTOR_KIND_LABELS[item.executor.kind]}). Nothing is sent before you confirm.
          </span>
        </p>
      ) : (
        <div className="space-y-1 text-sm">
          <p className="flex items-start gap-2">
            <Hand className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span>No automatic submission for this job - after you approve, it is handed to you with everything prepared and you apply yourself.</span>
          </p>
          {item.manualActionReason ? (
            <p className="text-xs text-muted-foreground">
              {MANUAL_ACTION_REASON_LABELS[item.manualActionReason]}
              {item.manualActionDetail ? ` - ${item.manualActionDetail}` : ""}
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}
