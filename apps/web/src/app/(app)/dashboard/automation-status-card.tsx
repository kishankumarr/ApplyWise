import Link from "next/link";
import { Bot, TriangleAlert } from "lucide-react";
import { APPLICATION_MODE_DESCRIPTIONS, APPLICATION_MODE_LABELS, type AutomationSettingsView, type DashboardSummary } from "@applywise/types";
import { Badge, buttonVariants, Card, CardContent, CardDescription, CardHeader, CardTitle, cn } from "@applywise/ui";
import { plural, timeAgo, timeUntil } from "@/lib/format";

type AutomationDetails = Pick<AutomationSettingsView, "status" | "readiness">;

function When({ iso, children }: { iso: string; children: React.ReactNode }) {
  return <time dateTime={iso}>{children}</time>;
}

/**
 * Dashboard: automation on/off, mode, last and next run. `details` (the full settings view) is only loaded while
 * automation is on; it adds the running flag, the last run's counts and why Auto mode cannot submit yet.
 */
export function AutomationStatusCard({ automation, details }: { automation: DashboardSummary["automation"]; details: AutomationDetails | null }) {
  const { enabled, mode, lastRunAt, nextRunAt } = automation;
  const status = details?.status ?? null;
  const lastRun = status?.lastRun ?? null;
  const running = !!status?.running;
  const autoBlocked = enabled && mode === "AUTO" && details != null && !details.readiness.canAutoApply;
  const autoBlockers = details?.readiness.blockers ?? [];

  return (
    <Card data-testid="automation-status-card">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 space-y-0">
        <div className="min-w-0 space-y-1.5">
          <CardTitle className="flex flex-wrap items-center gap-2">
            <Bot className="h-5 w-5 text-primary" aria-hidden="true" /> Automation
            <Badge variant={enabled ? "success" : "secondary"}>{enabled ? "On" : "Off"}</Badge>
            {running ? <Badge variant="info">Running now</Badge> : null}
          </CardTitle>
          <CardDescription>
            <span className="font-medium text-foreground">{APPLICATION_MODE_LABELS[mode]} mode</span>
            {enabled ? " · " : " (used when you turn automation on) · "}
            {APPLICATION_MODE_DESCRIPTIONS[mode]}
          </CardDescription>
        </div>
        <Link href="/automation" className={cn(buttonVariants({ size: "sm", variant: enabled ? "outline" : "default" }))}>
          Open automation
        </Link>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {enabled ? (
          <dl className="grid gap-3 sm:grid-cols-3">
            <div>
              <dt className="text-muted-foreground">Last run</dt>
              <dd className="font-medium">
                {lastRunAt ? <When iso={lastRunAt}>{timeAgo(lastRunAt)}</When> : "Not run yet"}
                {lastRun?.status === "FAILED" ? <span className="text-destructive"> · failed</span> : null}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Next run</dt>
              <dd className="font-medium">
                {running ? "Running now" : nextRunAt ? <When iso={nextRunAt}>{timeUntil(nextRunAt)}</When> : "Not scheduled yet"}
                {status?.inQuietHours ? <span className="font-normal text-muted-foreground"> · quiet hours, no submissions</span> : null}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Last run result</dt>
              <dd className="font-medium">
                {lastRun && lastRun.status !== "RUNNING"
                  ? `${plural(lastRun.newJobs, "new job")} · ${lastRun.applicationsPrepared} prepared · ${lastRun.applicationsSubmitted} submitted`
                  : "—"}
              </dd>
            </div>
          </dl>
        ) : (
          <p className="max-w-3xl text-muted-foreground">
            Automation is off. Turn it on and ApplyWise checks your job sources on a schedule, scores every new job against your verified profile and
            prepares applications for the jobs that meet your rules. You choose the mode: in Manual mode nothing is ever submitted for you, and you can turn
            automation off at any time.
          </p>
        )}

        {autoBlocked ? (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100">
            <p className="flex items-center gap-2 font-medium">
              <TriangleAlert className="h-4 w-4 shrink-0" aria-hidden="true" />
              Automatic submission is not active yet
            </p>
            <p className="mt-1">Until this is fixed, prepared applications wait for your review instead of being submitted:</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5">
              {autoBlockers.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
