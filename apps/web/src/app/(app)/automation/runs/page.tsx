import Link from "next/link";
import { buttonVariants, cn } from "@applywise/ui";
import { RunBreadcrumbs } from "@/components/automation/run-badges";
import { RUNS_PAGE_SIZE } from "@/components/automation/run-format";
import { RunsHistory } from "@/components/automation/runs-history";
import { PageHeader } from "@/components/page-header";
import { requireUserId } from "@/server/http";
import { automationRunsService } from "@/server/services/automation-runs.service";

export const metadata = { title: "Automation runs" };

export default async function AutomationRunsPage() {
  const userId = await requireUserId();
  const initial = await automationRunsService.list(userId, { limit: RUNS_PAGE_SIZE });
  return (
    <div>
      <RunBreadcrumbs />
      <PageHeader
        title="Automation runs"
        description="Every discovery run, newest first: what was found, how jobs were matched against your rules, and what happened to each application."
        actions={
          <Link href="/automation" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
            Automation settings
          </Link>
        }
      />
      <RunsHistory initial={initial} />
    </div>
  );
}
