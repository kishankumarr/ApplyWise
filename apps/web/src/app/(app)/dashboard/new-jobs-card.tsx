import Link from "next/link";
import { Radar, TriangleAlert } from "lucide-react";
import { Badge, buttonVariants, Card, CardContent, CardDescription, CardHeader, CardTitle, cn } from "@applywise/ui";
import { ProviderCredit } from "@/components/jobs/provider-credit";
import { GetJobsCta } from "@/components/sources/get-jobs-cta";
import type { JobListItem, JobSourcesSummary } from "@/lib/client-types";
import { plural, scoreVariant, timeAgo } from "@/lib/format";

type NewJob = Pick<JobListItem, "id" | "title" | "company" | "locations" | "score" | "scoreLabel" | "foundAt" | "descriptionLevel" | "attribution" | "attributionUrl">;

/** Dashboard: newest jobs found automatically since the user last looked, or the setup CTA. */
export function NewJobsCard({ items, newCount, sources }: { items: NewJob[]; newCount: number; sources: JobSourcesSummary }) {
  if (sources.total === 0) return <GetJobsCta />;
  return (
    <Card data-testid="new-jobs-card">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 space-y-0">
        <div className="space-y-1.5">
          <CardTitle className="flex items-center gap-2">
            <Radar className="h-5 w-5 text-primary" aria-hidden="true" /> New jobs for you
          </CardTitle>
          <CardDescription>
            {plural(sources.active, "source")} active · last checked {timeAgo(sources.lastSyncAt)}
          </CardDescription>
        </div>
        {newCount > 0 ? <Badge variant="info">{newCount} new</Badge> : null}
      </CardHeader>
      <CardContent className="space-y-4">
        {sources.needsAttention > 0 ? (
          <p className="flex items-center gap-1.5 text-sm text-destructive">
            <TriangleAlert className="h-4 w-4 shrink-0" aria-hidden="true" />
            <Link href="/jobs/sources" className="underline underline-offset-4">
              {sources.needsAttention === 1 ? "1 job source needs your attention" : `${sources.needsAttention} job sources need your attention`}
            </Link>
          </p>
        ) : null}
        {items.length ? (
          <ul className="divide-y">
            {items.map((j) => (
              <li key={j.id} className="flex items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <Link href={`/jobs/${j.id}`} className="font-medium hover:underline">
                    {j.title}
                  </Link>
                  <p className="truncate text-sm text-muted-foreground">
                    {j.company}
                    {j.locations.length ? ` · ${j.locations.join(", ")}` : ""} · found {timeAgo(j.foundAt)}
                    {j.attributionUrl && j.attribution ? (
                      <>
                        {" · "}
                        <ProviderCredit attribution={j.attribution} url={j.attributionUrl} />
                      </>
                    ) : null}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {j.descriptionLevel === "SNIPPET" ? (
                    <Badge variant="outline" className="hidden text-[10px] sm:inline-flex" title="Match based on a short summary only">
                      Summary only
                    </Badge>
                  ) : null}
                  <Badge variant={scoreVariant(j.scoreLabel)} title="Estimated resume-to-job match">
                    {j.score ?? "—"}
                  </Badge>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No new jobs since you last looked. ApplyWise keeps checking your sources and adds new matches automatically.</p>
        )}
        <div className="flex flex-wrap gap-2">
          {newCount > 0 ? (
            <Link href="/jobs?new=true" className={cn(buttonVariants({ size: "sm" }))}>
              Review {plural(newCount, "new job")}
            </Link>
          ) : (
            <Link href="/jobs?sort=found" className={cn(buttonVariants({ size: "sm", variant: "outline" }))}>
              Recently found jobs
            </Link>
          )}
          <Link href="/jobs/sources" className={cn(buttonVariants({ size: "sm", variant: "ghost" }))}>
            Manage sources
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
