"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Bot, TriangleAlert } from "lucide-react";
import { APPLICATION_MODE_DESCRIPTIONS, APPLICATION_MODE_LABELS, type AutomationSettingsView } from "@applywise/types";
import { buttonVariants, cn } from "@applywise/ui";
import { api } from "@/lib/api";

export const AUTOMATION_SETTINGS_KEY = ["automation-settings"] as const;

/** The automation control centre view (mode, readiness). Used for honest wording on the job matches page. */
export function useAutomationSettings() {
  return useQuery({
    queryKey: AUTOMATION_SETTINGS_KEY,
    queryFn: () => api<AutomationSettingsView>("/api/automation/settings"),
    staleTime: 30_000,
  });
}

/** One-line automation status above the job matches table: what the automation does (and does not do) for these jobs. */
export function AutomationModeNote({ settings }: { settings: AutomationSettingsView | undefined }) {
  if (!settings) return null;
  const { enabled, mode, readiness, status } = settings;
  const autoBlocked = enabled && mode === "AUTO" && !readiness.canAutoApply;
  return (
    <div className="flex flex-col gap-2 rounded-lg border px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between" data-testid="automation-mode-note">
      <div className="min-w-0 space-y-1">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Bot className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
          {enabled ? (
            <>
              <span className="font-medium">Automation: {APPLICATION_MODE_LABELS[mode]} mode</span>
              <span className="text-muted-foreground">{APPLICATION_MODE_DESCRIPTIONS[mode]}</span>
              {mode !== "MANUAL" ? (
                <span className="text-muted-foreground">
                  · {status.applicationsToday}/{status.dailyLimit} applications today
                </span>
              ) : null}
            </>
          ) : (
            <>
              <span className="font-medium">Automation is off</span>
              <span className="text-muted-foreground">Match scores are shown for every job. Turn the automation on to have new jobs from your sources checked against your rules on each run.</span>
            </>
          )}
        </p>
        {autoBlocked ? (
          <p className="flex items-start gap-1.5 text-amber-700 dark:text-amber-300">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>
              Nothing is submitted automatically yet{readiness.blockers[0] ? `: ${readiness.blockers[0]}` : "."}
              {readiness.blockers.length > 1 ? ` (+${readiness.blockers.length - 1} more)` : ""}
            </span>
          </p>
        ) : null}
      </div>
      <Link href="/automation" className={cn(buttonVariants({ size: "sm", variant: enabled ? "ghost" : "outline" }), "shrink-0 self-start sm:self-auto")}>
        {enabled ? "Automation settings" : "Set up automation"}
      </Link>
    </div>
  );
}
