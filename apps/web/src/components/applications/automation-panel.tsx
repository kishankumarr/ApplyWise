import { AlertTriangle, Bot, CheckCircle2, MinusCircle, XCircle } from "lucide-react";
import { APPLICATION_MODE_DESCRIPTIONS, APPLICATION_MODE_LABELS, type RuleCheck } from "@applywise/types";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@applywise/ui";
import type { ApplicationView } from "@/lib/client-types";
import { formatDateTime } from "@/lib/format";
import { RULE_EFFECT_LABELS, RULE_OUTCOME_LABELS, decisionLabel, decisionVariant, executorMethodLabel } from "./application-labels";

/** Where the application came from, how the rules decided, who approved it and how it was (or will be) sent. */
export function AutomationPanel({ app }: { app: ApplicationView }) {
  const a = app.automation;
  const fromAutomation = a.origin === "AUTOMATION";
  const checks = a.decisionChecks ?? [];
  const sentAt = a.appliedAt ?? app.submittedAt ?? app.emailSentAt;

  const approvedBy = a.approvalSource === "policy" ? "Auto policy" : a.approvalSource === "user" || app.approvedAt ? "You" : "Not approved yet";
  const sentVia = a.executorId
    ? `${executorMethodLabel(a.executorId)}${a.executorKind === "MANUAL" ? " - you apply on the official page yourself" : ""}`
    : fromAutomation && (a.mode === "REVIEW" || a.mode === "AUTO")
      ? "Not chosen yet - decided when the application is sent"
      : "You, on the official page or by email";

  return (
    <Card data-testid="automation-panel">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Bot className="h-4 w-4" aria-hidden="true" /> Automation
        </CardTitle>
        <CardDescription>{fromAutomation ? "Found and prepared by your automation." : "You created this application yourself."}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <dl className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-y-2">
          <dt className="text-muted-foreground">Origin</dt>
          <dd>{fromAutomation ? "Automation" : "You"}</dd>

          <dt className="text-muted-foreground">Mode</dt>
          <dd>
            {a.mode ? (
              <>
                <Badge variant="outline">{APPLICATION_MODE_LABELS[a.mode]}</Badge>
                <span className="ml-2 text-muted-foreground">{APPLICATION_MODE_DESCRIPTIONS[a.mode]}</span>
              </>
            ) : (
              "Manual flow - you review, approve and submit it yourself."
            )}
          </dd>

          <dt className="text-muted-foreground">Rule decision</dt>
          <dd>
            {a.decision ? (
              <span className="flex flex-wrap items-center gap-2">
                <Badge variant={decisionVariant(a.decision)}>{decisionLabel(a.decision)}</Badge>
                {a.decisionScore != null ? <span>Match score {Math.round(a.decisionScore)}</span> : null}
                {a.evaluatedAt ? <span className="text-xs text-muted-foreground">evaluated {formatDateTime(a.evaluatedAt)}</span> : null}
              </span>
            ) : (
              <span className="text-muted-foreground">Not evaluated by your rules</span>
            )}
          </dd>

          <dt className="text-muted-foreground">Approved by</dt>
          <dd>{approvedBy}</dd>

          <dt className="text-muted-foreground">Sent via</dt>
          <dd>{sentVia}</dd>

          {a.externalApplicationId ? (
            <>
              <dt className="text-muted-foreground">Confirmation / reference</dt>
              <dd>
                <code className="break-all rounded bg-muted px-1 py-0.5 text-xs">{a.externalApplicationId}</code>
              </dd>
            </>
          ) : null}

          <dt className="text-muted-foreground">Applied</dt>
          <dd>{sentAt ? formatDateTime(sentAt) : <span className="text-muted-foreground">Not sent yet</span>}</dd>

          {a.preparedAt ? (
            <>
              <dt className="text-muted-foreground">Prepared</dt>
              <dd>{formatDateTime(a.preparedAt)}</dd>
            </>
          ) : null}

          {a.failureReason ? (
            <>
              <dt className="text-muted-foreground">Failure</dt>
              <dd className="text-destructive">{a.failureReason}</dd>
            </>
          ) : null}

          <dt className="text-muted-foreground">Next step</dt>
          <dd className="font-medium">{a.nextAction || "Nothing to do right now"}</dd>
        </dl>

        {checks.length ? <RuleChecks checks={checks} /> : null}
      </CardContent>
    </Card>
  );
}

function RuleChecks({ checks }: { checks: RuleCheck[] }) {
  const notable = checks.filter((c) => c.outcome === "fail" || c.outcome === "warn");
  const rest = checks.filter((c) => c.outcome !== "fail" && c.outcome !== "warn");
  return (
    <div className="space-y-2">
      <p className="font-medium">Rule checks</p>
      {notable.length ? (
        <CheckList checks={notable} />
      ) : (
        <p className="text-muted-foreground">Every rule that was checked passed.</p>
      )}
      {rest.length ? (
        <details className="rounded-md border p-2">
          <summary className="cursor-pointer select-none text-muted-foreground">
            {notable.length ? `Show the other ${rest.length} checks` : `Show all ${rest.length} checks`}
          </summary>
          <div className="mt-2">
            <CheckList checks={rest} />
          </div>
        </details>
      ) : null}
    </div>
  );
}

function CheckList({ checks }: { checks: RuleCheck[] }) {
  return (
    <ul className="space-y-2">
      {checks.map((c) => (
        <li key={c.key} className="flex gap-2">
          <OutcomeIcon outcome={c.outcome} />
          <div className="min-w-0">
            <p>
              <span className="font-medium">{c.label}</span>
              <span className="sr-only"> - {RULE_OUTCOME_LABELS[c.outcome]}</span>
            </p>
            {c.detail ? <p className="text-muted-foreground">{c.detail}</p> : null}
            {c.outcome !== "pass" && c.outcome !== "skip" && RULE_EFFECT_LABELS[c.effect] ? <p className="text-xs text-muted-foreground">{RULE_EFFECT_LABELS[c.effect]}</p> : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

function OutcomeIcon({ outcome }: { outcome: RuleCheck["outcome"] }) {
  const cls = "mt-0.5 h-4 w-4 shrink-0";
  if (outcome === "pass") return <CheckCircle2 className={`${cls} text-emerald-600 dark:text-emerald-400`} aria-hidden="true" />;
  if (outcome === "fail") return <XCircle className={`${cls} text-destructive`} aria-hidden="true" />;
  if (outcome === "warn") return <AlertTriangle className={`${cls} text-amber-600 dark:text-amber-400`} aria-hidden="true" />;
  return <MinusCircle className={`${cls} text-muted-foreground`} aria-hidden="true" />;
}
