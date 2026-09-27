import Link from "next/link";
import { notFound } from "next/navigation";
import type { AutomationRunDetail } from "@applywise/types";
import { buttonVariants, cn } from "@applywise/ui";
import { RunBreadcrumbs } from "@/components/automation/run-badges";
import { RunDetail } from "@/components/automation/run-detail";
import { PageHeader } from "@/components/page-header";
import { AppError } from "@/server/errors";
import { requireUserId } from "@/server/http";
import { automationRunsService } from "@/server/services/automation-runs.service";

export const metadata = { title: "Automation run" };

export default async function AutomationRunPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const userId = await requireUserId();
  let run: AutomationRunDetail;
  try {
    run = await automationRunsService.get(userId, runId);
  } catch (e) {
    if (e instanceof AppError && e.status === 404) notFound();
    throw e;
  }
  return (
    <div>
      <RunBreadcrumbs current="Run details" />
      <PageHeader
        title="Automation run"
        description="What the automation did in this run, stage by stage. Open a job or an application from the timeline to act on it."
        actions={
          <Link href="/automation/runs" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
            All runs
          </Link>
        }
      />
      <RunDetail key={run.id} initial={run} />
    </div>
  );
}
