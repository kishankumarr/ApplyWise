import Link from "next/link";
import { cache } from "react";
import { prisma } from "@applywise/database";
import { Badge, buttonVariants, Card, CardContent, CardDescription, CardHeader, CardTitle, cn, EmptyState, Skeleton } from "@applywise/ui";
import { ProviderCredit } from "@/components/jobs/provider-credit";
import { platformLabel, scoreVariant, statusLabel } from "@/lib/format";
import { automationSettingsService } from "@/server/services/automation-settings.service";
import { dashboardService } from "@/server/services/dashboard.service";
import { jobsService } from "@/server/services/jobs.service";
import { profileService } from "@/server/services/profile.service";
import { AutomationMetrics } from "./automation-metrics";
import { AutomationStatusCard } from "./automation-status-card";
import { NewJobsCard } from "./new-jobs-card";

/**
 * Dashboard sections: each one loads its own data and is rendered inside its own <Suspense>, so the page shell streams
 * first and every card fills in as soon as its queries finish. Data two sections share is loaded once per request (cache).
 */

const listQuery = (sort: "score" | "found", newOnly: boolean): Parameters<typeof jobsService.list>[1] => ({
  sort,
  newOnly,
  order: "desc",
  page: 1,
  pageSize: 5,
  platform: [],
  workMode: [],
  status: [],
  applyMethod: [],
  includeIgnored: false,
  savedOnly: false,
});

const loadSummary = cache((userId: string) => dashboardService.summary(userId));
const loadTopMatches = cache((userId: string) => jobsService.list(userId, listQuery("score", false)));

export async function AutomationStatusSection({ userId }: { userId: string }) {
  const summary = await loadSummary(userId);
  // Run state, last-run counts and Auto-mode blockers only matter while automation is on. summary() has already
  // created the settings rows, so this read cannot race their creation.
  const details = summary.automation.enabled ? await automationSettingsService.getView(userId) : null;
  return <AutomationStatusCard automation={summary.automation} details={details} />;
}

export async function MetricsSection({ userId }: { userId: string }) {
  const [summary, top] = await Promise.all([loadSummary(userId), loadTopMatches(userId)]);
  return <AutomationMetrics summary={summary} inboxTotal={top.total} />;
}

export async function NewJobsSection({ userId }: { userId: string }) {
  // Newest jobs found automatically since the user last marked the inbox as seen.
  const fresh = await jobsService.list(userId, listQuery("found", true));
  return <NewJobsCard items={fresh.items} newCount={fresh.view.newCount} sources={fresh.sources} />;
}

export async function TopMatchesSection({ userId }: { userId: string }) {
  const top = await loadTopMatches(userId);
  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <CardTitle>Top matches</CardTitle>
        <CardDescription>{top.disclaimer}</CardDescription>
      </CardHeader>
      <CardContent>
        {top.items.length === 0 ? (
          <EmptyState
            title="No jobs yet"
            description="Set up job sources and new jobs arrive here automatically. You can also import a single job from the Jobs page."
            action={
              <Link href="/jobs/sources" className={cn(buttonVariants({ size: "sm" }))}>
                Set up job sources
              </Link>
            }
          />
        ) : (
          <ul className="divide-y">
            {top.items.map((j) => (
              <li key={j.id} className="flex items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <Link href={`/jobs/${j.id}`} className="font-medium hover:underline">
                    {j.title}
                  </Link>
                  <p className="truncate text-sm text-muted-foreground">
                    {j.company} · {j.locations.join(", ")} · {platformLabel(j.platform)}
                    {j.isDemo ? " · Demo" : ""}
                    {j.attributionUrl && j.attribution ? (
                      <>
                        {" · "}
                        <ProviderCredit attribution={j.attribution} url={j.attributionUrl} />
                      </>
                    ) : null}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {j.applicationStatus ? <Badge variant="outline">{statusLabel(j.applicationStatus)}</Badge> : null}
                  <Badge variant={scoreVariant(j.scoreLabel)}>{j.score ?? "—"}</Badge>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function ProfileHealthCard({ children }: { children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Profile health</CardTitle>
        <CardDescription>Only verified facts are used in applications.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">{children}</CardContent>
    </Card>
  );
}

export async function ProfileHealthSection({ userId }: { userId: string }) {
  const [view, notifications] = await Promise.all([
    profileService.getView(userId),
    prisma.notification.findMany({ where: { userId, readAt: null }, orderBy: { createdAt: "desc" }, take: 5 }),
  ]);
  return (
    <ProfileHealthCard>
      <p>
        <strong>{view.verification.verified}</strong> verified · <strong>{view.verification.unverified}</strong> unverified · {view.verification.rejected} rejected
      </p>
      {view.verification.unverified > 0 ? (
        <Link href="/profile" className={cn(buttonVariants({ size: "sm", variant: "outline" }))}>
          Review unverified facts
        </Link>
      ) : null}
      {view.resumeFormatWarnings.length ? (
        <ul className="list-disc pl-5 text-muted-foreground">
          {view.resumeFormatWarnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground">No resume format warnings.</p>
      )}
      {notifications.length ? (
        <div>
          <p className="mt-3 font-medium">Reminders</p>
          <ul className="mt-1 space-y-1">
            {notifications.map((n) => (
              <li key={n.id}>
                <Link href={n.link ?? "/applications"} className="underline">
                  {n.title}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </ProfileHealthCard>
  );
}

// ---------------------------------------------------------------- placeholders while a section streams in

export function AutomationStatusSkeleton() {
  return (
    <Card aria-hidden="true">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 space-y-0">
        <div className="min-w-0 flex-1 space-y-2">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-4 w-full max-w-xl" />
        </div>
        <Skeleton className="h-9 w-36" />
      </CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="space-y-1.5">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-5 w-32" />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

export function MetricsSkeleton() {
  return (
    <ul className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-6" aria-hidden="true">
      {Array.from({ length: 12 }, (_, i) => (
        <li key={i}>
          <Skeleton className="h-[7.25rem] w-full rounded-lg" />
        </li>
      ))}
    </ul>
  );
}

export function JobListSkeleton({ title, rows = 3, className }: { title?: string; rows?: number; className?: string }) {
  return (
    <Card className={className}>
      <CardHeader>
        {title ? <CardTitle>{title}</CardTitle> : <Skeleton className="h-6 w-48" />}
        <Skeleton className="h-4 w-2/3" />
      </CardHeader>
      <CardContent className="divide-y" aria-hidden="true">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="flex items-center justify-between gap-3 py-3">
            <div className="min-w-0 flex-1 space-y-1.5">
              <Skeleton className="h-5 w-1/2" />
              <Skeleton className="h-4 w-3/4" />
            </div>
            <Skeleton className="h-5 w-10 rounded-full" />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

export function ProfileHealthSkeleton() {
  return (
    <ProfileHealthCard>
      <div className="space-y-3" aria-hidden="true">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-9 w-44" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    </ProfileHealthCard>
  );
}
