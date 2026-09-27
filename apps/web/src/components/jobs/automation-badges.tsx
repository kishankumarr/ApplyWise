import { AUTOMATION_DECISION_LABELS, type AutomationDecision } from "@applywise/types";
import { Badge, cn } from "@applywise/ui";
import { statusLabel } from "@/lib/format";
import { applicationStatusVariant, DECISION_HINT, DECISION_VARIANT } from "./automation-labels";

/** "—" with a screen-reader text, for empty table cells. */
export function EmptyValue({ label }: { label: string }) {
  return (
    <span className="text-muted-foreground">
      <span aria-hidden="true">—</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

/** Rule-engine decision; "—" when the automation has not evaluated the job. No hooks: usable from server components. */
export function AutomationDecisionBadge({ decision, className }: { decision: AutomationDecision | null; className?: string }) {
  if (!decision) return <EmptyValue label="Not evaluated by the automation" />;
  return (
    <Badge variant={DECISION_VARIANT[decision]} className={cn("cursor-help whitespace-nowrap", className)} title={DECISION_HINT[decision]}>
      {AUTOMATION_DECISION_LABELS[decision]}
    </Badge>
  );
}

export function ApplicationStatusBadge({ status, className }: { status: string; className?: string }) {
  return (
    <Badge variant={applicationStatusVariant(status)} className={className}>
      {statusLabel(status)}
    </Badge>
  );
}
