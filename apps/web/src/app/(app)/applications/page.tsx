import Link from "next/link";
import { EmptyState, buttonVariants, cn } from "@applywise/ui";
import { parseApplicationView, type ApplicationListView } from "@/components/applications/application-labels";
import { ApplicationsTable } from "@/components/applications/applications-table";
import { Pager } from "@/components/pager";
import { PageHeader } from "@/components/page-header";
import { requireUserId } from "@/server/http";
import { applicationService } from "@/server/services/application.service";

export const metadata = { title: "Applications" };
export const dynamic = "force-dynamic";

const VIEWS: { key: ApplicationListView; label: string; description: string }[] = [
  { key: "active", label: "Active", description: "Applications being prepared, waiting for you, sent, or with an employer response." },
  {
    key: "pipeline",
    label: "Pipeline",
    description: "Jobs your automation discovered and evaluated that are not prepared yet: matched, auto-eligible, or filtered out by your rules.",
  },
  { key: "all", label: "All", description: "Every application and pipeline job." },
];

const EMPTY: Record<ApplicationListView, { title: string; description: string; href: string; action: string }> = {
  active: {
    title: "No applications yet",
    description: "Open a job and choose “Prepare application”, select several jobs in the inbox, or let your automation prepare the best matches.",
    href: "/jobs",
    action: "Browse jobs",
  },
  pipeline: {
    title: "Nothing in the pipeline",
    description: "When the automation runs, the jobs it discovers and matches wait here until they are prepared - or show why your rules filtered them out.",
    href: "/jobs/sources",
    action: "Set up job sources",
  },
  all: {
    title: "No applications yet",
    description: "Prepared applications and the jobs your automation evaluates appear here.",
    href: "/jobs",
    action: "Browse jobs",
  },
};

const PAGE_SIZE = 25;

/** ?page= (1-based); anything else is page 1. */
function parsePage(raw: string | string[] | undefined): number {
  const n = Number(Array.isArray(raw) ? raw[0] : raw);
  return Number.isInteger(n) && n >= 1 && n <= 10_000 ? n : 1;
}

function viewHref(view: ApplicationListView, page = 1, attention = false): string {
  const p = new URLSearchParams();
  if (view !== "active") p.set("view", view);
  if (attention) p.set("attention", "true");
  if (page > 1) p.set("page", String(page));
  const qs = p.toString();
  return qs ? `/applications?${qs}` : "/applications";
}

export default async function ApplicationsPage({ searchParams }: { searchParams: Promise<{ view?: string | string[]; page?: string | string[]; attention?: string | string[] }> }) {
  const userId = await requireUserId();
  const params = await searchParams;
  const view = parseApplicationView(params.view);
  const onlyAttention = (Array.isArray(params.attention) ? params.attention[0] : params.attention) === "true";
  const requested = parsePage(params.page);
  let list = await applicationService.list(userId, { view, attention: onlyAttention, page: requested, pageSize: PAGE_SIZE });
  // A page past the end (e.g. after applications moved to another view): show the last page instead.
  const lastPage = Math.max(1, Math.ceil(list.total / PAGE_SIZE));
  if (requested > lastPage) list = await applicationService.list(userId, { view, attention: onlyAttention, page: lastPage, pageSize: PAGE_SIZE });
  const { items: apps, counts, attention } = list;
  const current = VIEWS.find((v) => v.key === view)!;
  const empty = EMPTY[view];

  return (
    <div>
      <PageHeader
        title="Applications"
        description="What you and your automation prepared, approved and sent. In Manual mode nothing is ever submitted for you."
        actions={
          <Link href="/jobs" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
            Browse jobs
          </Link>
        }
      />

      <nav aria-label="Application views" className="mb-3 flex gap-1 overflow-x-auto border-b">
        {VIEWS.map((v) => {
          const active = v.key === view;
          return (
            <Link
              key={v.key}
              href={viewHref(v.key)}
              aria-current={active ? "page" : undefined}
              className={cn(
                "-mb-px inline-flex shrink-0 items-center gap-2 border-b-2 px-3 py-2 text-sm",
                active ? "border-primary font-medium" : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {v.label}
              <span className="rounded-full bg-muted px-1.5 text-xs tabular-nums text-muted-foreground">{counts[v.key]}</span>
            </Link>
          );
        })}
      </nav>
      <p className="mb-4 text-sm text-muted-foreground">
        {current.description}
        {attention ? <span className="ml-1 font-medium text-foreground">{attention === 1 ? "1 needs your attention." : `${attention} need your attention.`}</span> : null}{" "}
        {onlyAttention ? (
          <Link href={viewHref(view)} className="font-medium text-primary underline-offset-4 hover:underline" data-testid="attention-filter">
            Show all
          </Link>
        ) : attention ? (
          <Link href={viewHref(view, 1, true)} className="font-medium text-primary underline-offset-4 hover:underline" data-testid="attention-filter">
            Show only these
          </Link>
        ) : null}
      </p>

      {apps.length === 0 && onlyAttention ? (
        <EmptyState
          title="Nothing needs your attention"
          description="Every application in this view is prepared, sent or waiting for the employer."
          action={
            <Link href={viewHref(view)} className={cn(buttonVariants({ size: "sm" }))}>
              Show all
            </Link>
          }
        />
      ) : apps.length === 0 ? (
        <EmptyState
          title={empty.title}
          description={empty.description}
          action={
            <Link href={empty.href} className={cn(buttonVariants({ size: "sm" }))}>
              {empty.action}
            </Link>
          }
        />
      ) : (
        <>
          <ApplicationsTable rows={apps} view={view} />
          <Pager page={list.page} pageSize={list.pageSize} total={list.total} hrefFor={(p) => viewHref(view, p, onlyAttention)} label="Applications pages" />
        </>
      )}
    </div>
  );
}
