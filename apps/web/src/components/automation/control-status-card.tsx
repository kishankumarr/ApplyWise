"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FlaskConical, Loader2, MoonStar, Play } from "lucide-react";
import { APPLICATION_MODE_LABELS, type AutomationRunSummary, type AutomationSettingsView } from "@applywise/types";
import { Alert, AlertDescription, Badge, Button, buttonVariants, Card, CardContent, cn, Progress, toast } from "@applywise/ui";
import { api, ApiClientError, errorMessage } from "@/lib/api";
import { plural, timeAgo, timeUntil } from "@/lib/format";
import { ControlSwitch, frequencyLabel, invalidateAutomationData, SETTINGS_KEY, SETTINGS_URL, TimeText, useTick } from "./control-shared";
import { minutesToTime } from "./settings-form";

const RUN_STATUS: Record<AutomationRunSummary["status"], { label: string; variant: "info" | "success" | "destructive" }> = {
  RUNNING: { label: "Running", variant: "info" },
  COMPLETED: { label: "Completed", variant: "success" },
  FAILED: { label: "Failed", variant: "destructive" },
};

const MODE_EFFECT: Record<AutomationSettingsView["mode"], string> = {
  MANUAL: "Nothing is submitted for you.",
  REVIEW: "Submitted only after you approve.",
  AUTO: "Submits automatically when every check passes.",
};

const RUN_NOW_HINT: Record<AutomationSettingsView["mode"], string> = {
  MANUAL: "Checks your sources and prepares matching applications now. Manual mode: nothing is submitted.",
  REVIEW: "Checks your sources and prepares matching applications now. They wait for your approval in the review queue.",
  AUTO: "Checks your sources now. Applications that pass every check may be submitted automatically, within your daily limit.",
};

function isStatus(e: unknown, status: number): boolean {
  return e instanceof ApiClientError && e.status === status;
}

function Stat({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn("min-w-0 rounded-md border bg-muted/20 p-3", className)}>
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-sm">{children}</dd>
    </div>
  );
}

function LastRunNumbers({ run }: { run: AutomationRunSummary }) {
  const numbers: { label: string; value: number; tone?: string }[] = [
    { label: "Jobs found", value: run.jobsFound },
    { label: "New", value: run.newJobs },
    { label: "Matched", value: run.jobsMatched },
    { label: "Prepared", value: run.applicationsPrepared },
    { label: "Submitted", value: run.applicationsSubmitted },
    { label: "Need information", value: run.needsInformation, tone: run.needsInformation ? "text-amber-700 dark:text-amber-300" : undefined },
    { label: "Manual action", value: run.manualActions, tone: run.manualActions ? "text-amber-700 dark:text-amber-300" : undefined },
    { label: "Failures", value: run.failures, tone: run.failures ? "text-destructive" : undefined },
  ];
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4" aria-label="Last run in numbers">
      {numbers.map((n) => (
        <div key={n.label} className="flex items-baseline justify-between gap-2 border-b border-dashed pb-1 sm:block sm:border-0 sm:pb-0">
          <dt className="text-muted-foreground">{n.label}</dt>
          <dd className={cn("font-semibold tabular-nums", n.tone)}>{n.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function ControlStatusCard({
  settings,
  demoAvailable,
  demoAdded,
  unsavedChanges,
  onRunStarted,
}: {
  settings: AutomationSettingsView;
  /** The server has the demo provider enabled (the demo endpoint returns 501 otherwise). */
  demoAvailable: boolean;
  /** The user already added the demo source (the button then re-runs it). */
  demoAdded: boolean;
  /** The settings form below has unsaved edits (runs always use the saved settings). */
  unsavedChanges: boolean;
  /** Poll faster for a while: a run was just started. */
  onRunStarted: () => void;
}) {
  useTick(30_000);
  const qc = useQueryClient();
  const [demoUnavailable, setDemoUnavailable] = useState(!demoAvailable);
  const { status } = settings;

  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api<AutomationSettingsView>(SETTINGS_URL, { method: "PUT", body: { enabled } }),
    onSuccess: (view) => {
      qc.setQueryData(SETTINGS_KEY, view);
      invalidateAutomationData(qc);
      toast.success(
        view.enabled
          ? `Automation is on. It checks your sources every ${frequencyLabel(view.searchFrequencyMinutes)}${view.mode === "MANUAL" ? " - Manual mode, so nothing is submitted" : ""}.`
          : "Automation is off. No scheduled runs until you turn it back on.",
      );
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const runNow = useMutation({
    mutationFn: () => api<AutomationRunSummary>("/api/automation/run", { method: "POST" }),
    onSuccess: (run) => {
      onRunStarted();
      invalidateAutomationData(qc);
      toast.success(run.status === "RUNNING" ? "Automation run started. Progress shows here as it goes." : "Automation run finished.");
    },
    onError: (e) => {
      if (isStatus(e, 409)) {
        onRunStarted();
        void qc.invalidateQueries({ queryKey: SETTINGS_KEY });
        toast.info("A run is already in progress. Its results will show here when it finishes.");
      } else toast.error(errorMessage(e));
    },
  });

  const demo = useMutation({
    mutationFn: () => api<{ feedId: string; connected: boolean; run: AutomationRunSummary | null }>("/api/automation/demo", { method: "POST" }),
    onSuccess: () => {
      onRunStarted();
      invalidateAutomationData(qc);
      toast.success("Demo job provider added and connected (DEMO CONTENT - fictional jobs). The demo run has started.");
    },
    onError: (e) => {
      if (isStatus(e, 501)) {
        setDemoUnavailable(true);
        toast.info("The demo is not available on this server.");
      } else if (isStatus(e, 409)) {
        onRunStarted();
        void qc.invalidateQueries({ queryKey: SETTINGS_KEY });
        toast.info("A run is already in progress. Try the demo again when it finishes.");
      } else toast.error(errorMessage(e));
    },
  });

  const enabled = toggle.isPending && toggle.variables !== undefined ? toggle.variables : settings.enabled;
  const lastRun = status.lastRun;
  const limit = status.dailyLimit;
  const usedPct = limit > 0 ? Math.min(100, Math.round((status.applicationsToday / limit) * 100)) : 0;
  const quietConfigured = settings.quietHoursStart != null && settings.quietHoursEnd != null && settings.quietHoursStart !== settings.quietHoursEnd;
  const busy = status.running || runNow.isPending || demo.isPending;

  return (
    <Card role="region" aria-labelledby="automation-status-title">
      <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1.5">
          <h2 id="automation-status-title" className="text-lg font-semibold leading-none tracking-tight">
            Status
          </h2>
          <p id="automation-switch-desc" className="max-w-xl text-sm text-muted-foreground">
            {enabled
              ? `On: ApplyWise checks your job sources every ${frequencyLabel(settings.searchFrequencyMinutes)} in the background and handles matches according to your mode.`
              : "Off: no scheduled runs. You can still run it once with Run now."}
          </p>
        </div>
        <div className="flex items-center gap-3 rounded-md border px-3 py-2">
          <span id="automation-switch-label" className="text-sm font-medium">
            Automation
          </span>
          <ControlSwitch
            id="automation-switch"
            checked={enabled}
            onCheckedChange={(next) => toggle.mutate(next)}
            disabled={toggle.isPending}
            labelledBy="automation-switch-label"
            describedBy="automation-switch-desc"
          />
          <span className={cn("w-7 text-sm font-semibold", enabled ? "text-primary" : "text-muted-foreground")} aria-hidden="true">
            {enabled ? "On" : "Off"}
          </span>
        </div>
      </div>

      <CardContent className="space-y-5">
        <div role="status" aria-live="polite" className="min-h-5 text-sm">
          {status.running ? (
            <span className="flex items-center gap-2 font-medium text-sky-700 dark:text-sky-300">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Running now - checking sources, matching and preparing applications...
            </span>
          ) : runNow.isPending || demo.isPending ? (
            <span className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Starting a run...
            </span>
          ) : (
            <span className="text-muted-foreground">Not running right now.</span>
          )}
        </div>

        <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Mode">
            <span className="flex flex-wrap items-center gap-2">
              <Badge variant={settings.mode === "AUTO" ? "default" : "secondary"}>{APPLICATION_MODE_LABELS[settings.mode]}</Badge>
              {settings.mode === "AUTO" && !settings.readiness.canAutoApply ? <Badge variant="warning">Not ready</Badge> : null}
            </span>
            <span className="mt-1 block text-xs text-muted-foreground">
              {settings.mode === "AUTO" && !settings.readiness.canAutoApply ? "Auto mode cannot submit yet - see the checklist below." : MODE_EFFECT[settings.mode]}
            </span>
          </Stat>
          <Stat label="Last automation run">
            {lastRun ? (
              <>
                <span className="flex flex-wrap items-center gap-2">
                  <TimeText iso={lastRun.startedAt}>{timeAgo(lastRun.startedAt)}</TimeText>
                  <Badge variant={RUN_STATUS[lastRun.status].variant}>{RUN_STATUS[lastRun.status].label}</Badge>
                </span>
                <Link href={`/automation/runs/${lastRun.id}`} className="mt-1 inline-block text-xs font-medium text-primary underline-offset-4 hover:underline">
                  View run details
                </Link>
              </>
            ) : (
              <span className="text-muted-foreground">No runs yet</span>
            )}
          </Stat>
          <Stat label="Next run">
            {!settings.enabled ? (
              <span className="text-muted-foreground">Off</span>
            ) : status.running ? (
              <span>After the current run</span>
            ) : status.nextRunAt ? (
              <TimeText iso={status.nextRunAt}>{timeUntil(status.nextRunAt)}</TimeText>
            ) : (
              <span className="text-muted-foreground">Being scheduled</span>
            )}
            <span className="mt-1 block text-xs text-muted-foreground">Every {frequencyLabel(settings.searchFrequencyMinutes)}</span>
          </Stat>
          <Stat label="Applications today">
            <span className="font-semibold tabular-nums">
              {status.applicationsToday} / {limit}
            </span>
            <Progress
              value={usedPct}
              className="mt-2"
              aria-label="Automatic applications used today"
              getValueLabel={() => `${status.applicationsToday} of ${limit}`}
            />
            <span className="mt-1 block text-xs text-muted-foreground">
              {limit === 0 ? "Daily limit is 0: nothing is submitted automatically." : status.applicationsToday >= limit ? "Limit reached - the rest wait until tomorrow." : "Automatic submissions, your timezone."}
            </span>
          </Stat>
        </dl>

        {lastRun ? (
          <div className="space-y-2 rounded-md border p-3">
            <p className="text-sm font-medium">
              Last run{" "}
              <span className="font-normal text-muted-foreground">
                ({lastRun.trigger === "schedule" ? "scheduled" : lastRun.trigger === "demo" ? "demo" : "started by you"}, {APPLICATION_MODE_LABELS[lastRun.mode]} mode
                {lastRun.providersChecked ? `, ${plural(lastRun.providersChecked, "source")} checked` : ""})
              </span>
            </p>
            <LastRunNumbers run={lastRun} />
            {lastRun.error ? <p className="text-sm text-destructive">{lastRun.error}</p> : null}
          </div>
        ) : null}

        <p className="flex flex-wrap items-center gap-2 text-sm">
          <MoonStar className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          {status.inQuietHours ? (
            <>
              <Badge variant="warning">Quiet hours now</Badge>
              <span>No automatic submissions or notifications until {minutesToTime(settings.quietHoursEnd ?? 0)} ({settings.timezone}).</span>
            </>
          ) : quietConfigured ? (
            <span className="text-muted-foreground">
              Quiet hours {minutesToTime(settings.quietHoursStart!)}-{minutesToTime(settings.quietHoursEnd!)} ({settings.timezone})
            </span>
          ) : (
            <span className="text-muted-foreground">Quiet hours off</span>
          )}
        </p>

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-2">
            <Button onClick={() => runNow.mutate()} disabled={busy} aria-describedby="run-now-hint">
              {runNow.isPending ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Play aria-hidden="true" />}
              Run now
            </Button>
            <p id="run-now-hint" className="text-xs text-muted-foreground">
              {RUN_NOW_HINT[settings.mode]} {settings.enabled ? "" : "Works even while automation is off."}
            </p>
            {unsavedChanges ? <p className="text-xs font-medium text-amber-800 dark:text-amber-200">Runs use your saved settings - save your changes below first.</p> : null}
          </div>
          {demoAvailable ? (
            <div className="space-y-2">
              {demoUnavailable ? (
                <p className="text-sm text-muted-foreground">The demo is not available on this server.</p>
              ) : (
                <>
                  <Button variant="outline" onClick={() => demo.mutate()} disabled={busy} aria-describedby="demo-hint">
                    {demo.isPending ? <Loader2 className="animate-spin" aria-hidden="true" /> : <FlaskConical aria-hidden="true" />}
                    {demoAdded ? "Run the demo again" : "Try the demo"}
                  </Button>
                  <p id="demo-hint" className="text-xs text-muted-foreground">
                    Adds a fictional demo job provider (<strong>DEMO CONTENT</strong> - made-up companies and jobs; nothing is sent to real employers) and runs the real
                    pipeline once: discovery, matching, rules and preparation. Your mode, rules and consent are not changed.
                  </p>
                </>
              )}
            </div>
          ) : null}
        </div>

        {settings.mode === "MANUAL" ? (
          <Alert variant="info" role="note">
            <AlertDescription>Manual mode: ApplyWise finds, matches and prepares applications, but never submits anything. You apply yourself.</AlertDescription>
          </Alert>
        ) : null}

        <nav aria-label="Automation pages" className="flex flex-wrap gap-2 border-t pt-4">
          <Link href="/automation/runs" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
            View all runs
          </Link>
          <Link href="/review" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
            Review queue
          </Link>
          <Link href="/settings/job-sources" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
            Job sources
          </Link>
        </nav>
      </CardContent>
    </Card>
  );
}
