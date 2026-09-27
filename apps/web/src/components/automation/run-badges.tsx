import Link from "next/link";
import { Badge, cn } from "@applywise/ui";
import { modeDescription, modeLabel, RUN_STATUS_META, runOutcome, triggerDescription, triggerLabel } from "./run-format";

/** Running / Completed / Failed. A pulsing dot marks a run in progress. */
export function RunStatusBadge({ status, className }: { status: string; className?: string }) {
  const meta = RUN_STATUS_META[status as keyof typeof RUN_STATUS_META] ?? { label: status, variant: "outline" as const };
  return (
    <Badge variant={meta.variant} className={cn("gap-1.5 whitespace-nowrap", className)} data-testid="run-status">
      {status === "RUNNING" ? <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" aria-hidden="true" /> : null}
      {meta.label}
    </Badge>
  );
}

/** Outcome of one run item (IGNORE, REVIEW, APPLIED, MANUAL_ACTION_REQUIRED, ...). */
export function RunOutcomeBadge({ outcome, className }: { outcome: string; className?: string }) {
  const meta = runOutcome(outcome);
  return (
    <Badge variant={meta.variant} className={cn("whitespace-nowrap", className)} title={meta.description || undefined} data-outcome={outcome}>
      {meta.label}
    </Badge>
  );
}

export function RunModeBadge({ mode, className }: { mode: string; className?: string }) {
  return (
    <Badge variant="outline" className={cn("whitespace-nowrap", className)} title={modeDescription(mode) || undefined}>
      {modeLabel(mode)} mode
    </Badge>
  );
}

export function RunTriggerLabel({ trigger, className }: { trigger: string; className?: string }) {
  return (
    <span className={className} title={triggerDescription(trigger) || undefined}>
      {triggerLabel(trigger)}
    </span>
  );
}

/** Automation > Runs > (this run). */
export function RunBreadcrumbs({ current }: { current?: string }) {
  return (
    <nav aria-label="Breadcrumb" className="mb-2 text-sm text-muted-foreground">
      <ol className="flex flex-wrap items-center gap-1.5">
        <li>
          <Link href="/automation" className="hover:text-foreground hover:underline">
            Automation
          </Link>
        </li>
        <li aria-hidden="true">/</li>
        <li>
          {current ? (
            <Link href="/automation/runs" className="hover:text-foreground hover:underline">
              Runs
            </Link>
          ) : (
            <span aria-current="page" className="text-foreground">
              Runs
            </span>
          )}
        </li>
        {current ? (
          <>
            <li aria-hidden="true">/</li>
            <li aria-current="page" className="text-foreground">
              {current}
            </li>
          </>
        ) : null}
      </ol>
    </nav>
  );
}
