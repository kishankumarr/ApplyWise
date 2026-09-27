import { ControlCenter } from "@/components/automation/control-center";
import { PageHeader } from "@/components/page-header";
import { env } from "@/env";
import { requireUserId } from "@/server/http";
import { automationSettingsService } from "@/server/services/automation-settings.service";
import { demoProviderEnabled } from "@/server/services/job-feeds.service";
import { jobSourcesService } from "@/server/services/job-sources.service";

export const metadata = { title: "Automation" };

export default async function AutomationPage() {
  const userId = await requireUserId();
  // Sequential on purpose: both create the user's settings row on first visit.
  const settings = await automationSettingsService.getView(userId);
  const providers = await jobSourcesService.cards(userId);
  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Automation"
        description="Set it up once: ApplyWise finds, matches and prepares applications in the background - and submits them only if you choose a mode that allows it."
      />
      <ControlCenter initialSettings={settings} initialProviders={providers} demoAvailable={demoProviderEnabled()} maxDailyLimit={env().AUTOMATION_MAX_DAILY_LIMIT} />
    </div>
  );
}
