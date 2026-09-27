"use client";

import Link from "next/link";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bot, CircleAlert, CircleCheck, CircleMinus, CircleX, TriangleAlert } from "lucide-react";
import { APPLICATION_MODE_LABELS, type RuleCheck, type RuleOutcome } from "@applywise/types";
import { Alert, AlertDescription, AlertTitle, Badge, Button, buttonVariants, Card, CardContent, CardDescription, CardHeader, CardTitle, cn, Skeleton } from "@applywise/ui";
import { api, errorMessage } from "@/lib/api";
import type { ApplicationView } from "@/lib/client-types";
import { plural, timeAgo } from "@/lib/format";
import { ApplicationStatusBadge, AutomationDecisionBadge } from "./automation-badges";
import { DECISION_HINT, EXECUTOR_KIND_TEXT, RULE_EFFECT_LABEL, RULE_OUTCOME_LABEL } from "./automation-labels";

const OUTCOME_ORDER: Record<RuleOutcome, number> = { fail: 0, warn: 1, pass: 2, skip: 3 };

function OutcomeIcon({ outcome }: { outcome: RuleOutcome }) {
  const cls = "mt-0.5 h-4 w-4 shrink-0";
  if (outcome === "pass") return <CircleCheck className={cn(cls, "text-emerald-600 dark:text-emerald-400")} aria-hidden="true" />;
  if (outcome === "fail") return <CircleX className={cn(cls, "text-destructive")} aria-hidden="true" />;
  if (outcome === "warn") return <CircleAlert className={cn(cls, "text-amber-600 dark:text-amber-400")} aria-hidden="true" />;
  return <CircleMinus className={cn(cls, "text-muted-foreground")} aria-hidden="true" />;
}

function CheckItem({ check }: { check: RuleCheck }) {
  const effect = RULE_EFFECT_LABEL[check.effect];
  return (
    <li className="flex gap-2" data-outcome={check.outcome}>
      <OutcomeIcon outcome={check.outcome} />
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="font-medium">{check.label}</span>
          <span className="sr-only">: {RULE_OUTCOME_LABEL[check.outcome]}</span>
          {effect ? (
            <Badge variant={check.effect === "ignore" ? "destructive" : check.effect === "raise_review" ? "info" : "warning"} className="px-1.5 py-0 text-[10px]">
              {effect}
            </Badge>
          ) : null}
        </p>
        {check.detail ? <p className="text-xs text-muted-foreground">{check.detail}</p> : null}
      </div>
    </li>
  );
}

function NotEvaluated({ applicationId, prepared }: { applicationId: string | null; prepared: boolean }) {
  return (
    <div className="space-y-3">
      <p>
        <span className="font-medium">Not evaluated by the automation.</span>{" "}
        <span className="text-muted-foreground">The automation evaluates new jobs from your sources on each run and records its decision and rule checks here.</span>
      </p>
      {prepared ? <p className="text-muted-foreground">You started this application yourself: it follows your review, and nothing is submitted for you.</p> : null}
      <div className="flex flex-wrap gap-2">
        {applicationId ? (
          <Link href={`/applications/${applicationId}`} className={cn(buttonVariants({ size: "sm", variant: "outline" }))}>
            Go to application
          </Link>
        ) : null}
        <Link href="/automation" className={cn(buttonVariants({ size: "sm", variant: "ghost" }))}>
          Automation settings
        </Link>
      </div>
    </div>
  );
}

/**
 * Job page: how the automation judged this job - decision, rule checks and where the application stands.
 * Shares the ["application", id] query with the application workspace.
 */
export function JobAutomationPanel({ applicationId }: { applicationId: string | null }) {
  const [showSkipped, setShowSkipped] = useState(false);
  const { data: app, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["application", applicationId],
    queryFn: () => api<ApplicationView>(`/api/applications/${applicationId}`),
    enabled: !!applicationId,
  });

  let body: React.ReactNode;
  if (!applicationId) {
    body = <NotEvaluated applicationId={null} prepared={false} />;
  } else if (isLoading) {
    body = (
      <div className="space-y-2" aria-busy="true">
        <span className="sr-only">Loading the automation decision…</span>
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-3/4" />
      </div>
    );
  } else if (error || !app) {
    body = (
      <div role="alert" className="space-y-2">
        <p className="text-destructive">Could not load the automation details: {errorMessage(error)}</p>
        <Button size="sm" variant="outline" onClick={() => void refetch()} disabled={isFetching}>
          Try again
        </Button>
      </div>
    );
  } else if (!app.automation.decision) {
    body = <NotEvaluated applicationId={app.id} prepared={app.automation.origin === "USER"} />;
  } else {
    const a = app.automation;
    const decision = a.decision!;
    const checks = [...a.decisionChecks].sort((x, y) => OUTCOME_ORDER[x.outcome] - OUTCOME_ORDER[y.outcome]);
    const applied = checks.filter((c) => c.outcome !== "skip");
    const skipped = checks.filter((c) => c.outcome === "skip");
    body = (
      <div className="space-y-4">
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <AutomationDecisionBadge decision={decision} className="text-sm" />
            {a.decisionScore != null ? <span className="tabular-nums">Match score {a.decisionScore}</span> : null}
            {a.evaluatedAt ? (
              <span className="text-muted-foreground">
                · evaluated <time dateTime={a.evaluatedAt}>{timeAgo(a.evaluatedAt)}</time>
              </span>
            ) : null}
          </div>
          <p className="text-muted-foreground">{DECISION_HINT[decision]}</p>
        </div>

        <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
          <div>
            <dt className="text-muted-foreground">Application</dt>
            <dd className="mt-0.5" aria-live="polite">
              <ApplicationStatusBadge status={app.status} />
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Mode</dt>
            <dd className="mt-0.5 font-medium">{a.mode ? `${APPLICATION_MODE_LABELS[a.mode]} mode` : "Your own review"}</dd>
          </div>
          {a.executorKind ? (
            <div className="sm:col-span-2 xl:col-span-1 2xl:col-span-2">
              <dt className="text-muted-foreground">How it is sent</dt>
              <dd className="mt-0.5">{EXECUTOR_KIND_TEXT[a.executorKind]}</dd>
            </div>
          ) : null}
          {a.appliedAt ? (
            <div>
              <dt className="text-muted-foreground">Applied</dt>
              <dd className="mt-0.5">
                <time dateTime={a.appliedAt}>{timeAgo(a.appliedAt)}</time>
              </dd>
            </div>
          ) : null}
        </dl>

        {a.nextAction ? (
          <p>
            <span className="font-medium">Next: </span>
            {a.nextAction}
          </p>
        ) : null}

        {a.manualActionLabel ? (
          <Alert variant="warning">
            <TriangleAlert className="h-4 w-4" aria-hidden="true" />
            <AlertTitle>{a.manualActionLabel}</AlertTitle>
            {a.manualActionDetail ? <AlertDescription>{a.manualActionDetail}</AlertDescription> : null}
          </Alert>
        ) : null}
        {a.failureReason ? <p className="text-destructive">{a.failureReason}</p> : null}
        {a.pendingQuestions.length ? (
          <p className="text-amber-700 dark:text-amber-300">
            {plural(a.pendingQuestions.length, "required question")} {a.pendingQuestions.length === 1 ? "needs" : "need"} your answer before it can continue.
          </p>
        ) : null}

        {checks.length ? (
          <div>
            <h3 className="text-sm font-semibold">Rule checks</h3>
            <ul className="mt-2 space-y-2" aria-label="Rule checks">
              {applied.map((c) => (
                <CheckItem key={c.key} check={c} />
              ))}
            </ul>
            {skipped.length ? (
              <>
                <Button variant="link" size="sm" className="mt-1 h-auto px-0" aria-expanded={showSkipped} aria-controls="automation-skipped-checks" onClick={() => setShowSkipped((v) => !v)}>
                  {showSkipped ? "Hide" : "Show"} {plural(skipped.length, "check")} that did not apply
                </Button>
                <ul id="automation-skipped-checks" className="mt-1 space-y-2" aria-label="Checks that did not apply" hidden={!showSkipped}>
                  {skipped.map((c) => (
                    <CheckItem key={c.key} check={c} />
                  ))}
                </ul>
              </>
            ) : null}
          </div>
        ) : null}

        <Link href={`/applications/${app.id}`} className={cn(buttonVariants({ size: "sm", variant: "outline" }))}>
          Go to application
        </Link>
      </div>
    );
  }

  return (
    <Card data-testid="job-automation">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Bot className="h-4 w-4 text-primary" aria-hidden="true" /> Automation
        </CardTitle>
        <CardDescription>How your automation rules judged this job.</CardDescription>
      </CardHeader>
      <CardContent className="text-sm">
        {body}
      </CardContent>
    </Card>
  );
}
