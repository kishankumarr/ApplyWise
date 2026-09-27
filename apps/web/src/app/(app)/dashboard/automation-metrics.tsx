import Link from "next/link";
import {
  CalendarCheck,
  CalendarDays,
  CircleHelp,
  CircleX,
  ClipboardCheck,
  Hand,
  ListChecks,
  Radar,
  Send,
  Sparkles,
  Target,
  Trophy,
  type LucideIcon,
} from "lucide-react";
import type { DashboardSummary } from "@applywise/types";
import { Card, cn } from "@applywise/ui";

interface Metric {
  key: string;
  label: string;
  value: number;
  /** Shown next to the value, e.g. "of 10". */
  suffix?: string;
  hint: string;
  href: string;
  icon: LucideIcon;
  /** The user has something to do when the count is above zero: highlight the card. */
  attention?: boolean;
  /** 0-100: a small usage bar under the value (daily limit). */
  usage?: number;
}

function metricsFrom(s: DashboardSummary, inboxTotal: number | null): Metric[] {
  const limit = s.automation.dailyLimit;
  return [
    {
      key: "discovered",
      label: "Jobs discovered today",
      value: s.jobsDiscoveredToday,
      hint: inboxTotal == null ? "Found by your job sources" : `${inboxTotal} in your inbox`,
      href: "/jobs?sort=found",
      icon: Radar,
    },
    { key: "new-matches", label: "New matches", value: s.newMatches, hint: "Found today, at or above your minimum match score", href: "/jobs?new=true", icon: Sparkles },
    { key: "strong", label: "90%+ matches", value: s.strongMatches, hint: "Strong matches in your inbox", href: "/jobs?sort=score", icon: Target },
    {
      key: "today",
      label: "Applications today",
      value: s.applicationsToday,
      suffix: `of ${limit}`,
      hint: limit === 0 ? "Daily limit is 0: nothing is sent automatically" : "Sent today, against your daily limit",
      href: "/applications",
      icon: Send,
      usage: limit > 0 ? Math.min(100, Math.round((s.applicationsToday / limit) * 100)) : undefined,
    },
    { key: "week", label: "Applications this week", value: s.applicationsThisWeek, hint: "Sent in the last 7 days", href: "/applications", icon: CalendarDays },
    { key: "waiting", label: "Waiting approval", value: s.waitingApproval, hint: "Prepared and ready for your review", href: "/review", icon: ListChecks, attention: true },
    { key: "needs-info", label: "Needs information", value: s.needsInformation, hint: "Questions only you can answer", href: "/review", icon: CircleHelp, attention: true },
    {
      key: "manual",
      label: "Manual action required",
      value: s.manualActionRequired,
      hint: "Finish these yourself (includes failed attempts)",
      href: "/applications",
      icon: Hand,
      attention: true,
    },
    { key: "interviews", label: "Interviews", value: s.interviews, hint: "Invitations to interview", href: "/applications", icon: CalendarCheck },
    { key: "assessments", label: "Assessments", value: s.assessments, hint: "Tests or assignments to complete", href: "/applications", icon: ClipboardCheck },
    { key: "offers", label: "Offers", value: s.offers, hint: "Offers received", href: "/applications", icon: Trophy },
    { key: "rejections", label: "Rejections", value: s.rejections, hint: "Employers not moving forward", href: "/applications", icon: CircleX },
  ];
}

/** Dashboard: the DashboardSummary counts as a responsive grid of link cards. */
export function AutomationMetrics({ summary, inboxTotal = null }: { summary: DashboardSummary; inboxTotal?: number | null }) {
  const metrics = metricsFrom(summary, inboxTotal);
  return (
    <section aria-labelledby="dashboard-metrics-heading" data-testid="dashboard-metrics">
      <h2 id="dashboard-metrics-heading" className="sr-only">
        Key numbers
      </h2>
      <ul className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-6">
        {metrics.map((m) => {
          const flagged = !!m.attention && m.value > 0;
          return (
            <li key={m.key}>
              <Link
                href={m.href}
                className="group block h-full rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                <Card className={cn("flex h-full flex-col p-4 transition-colors group-hover:bg-accent/40", flagged && "border-amber-300 dark:border-amber-800")}>
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm font-medium text-muted-foreground">{m.label}</p>
                    <m.icon className={cn("h-4 w-4 shrink-0", flagged ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground")} aria-hidden="true" />
                  </div>
                  <p className="mt-2 text-3xl font-semibold tabular-nums tracking-tight">
                    {m.value}
                    {m.suffix ? <span className="ml-1.5 text-sm font-normal text-muted-foreground">{m.suffix}</span> : null}
                  </p>
                  {m.usage != null ? (
                    <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-secondary" aria-hidden="true">
                      <div className={cn("h-full rounded-full", m.usage >= 100 ? "bg-amber-500" : "bg-primary")} style={{ width: `${m.usage}%` }} />
                    </div>
                  ) : null}
                  <p className="mt-auto pt-1 text-xs text-muted-foreground">{m.hint}</p>
                </Card>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
