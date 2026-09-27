import type { ProviderSourceCard } from "@applywise/types";
import { PageHeader } from "@/components/page-header";
import { SettingsNav } from "@/components/settings-nav";
import { JobSourceCards } from "@/components/settings/job-source-cards";
import { requireUserId } from "@/server/http";
import { jobSourcesService } from "@/server/services/job-sources.service";

export const metadata = { title: "Job source settings" };
export const dynamic = "force-dynamic";

export default async function JobSourcesSettingsPage() {
  const userId = await requireUserId();
  // A failure here is not fatal: the client component loads the cards itself and shows an error with a retry.
  const cards = await jobSourcesService.cards(userId).catch(() => undefined);
  const initialCards = cards ? (JSON.parse(JSON.stringify(cards)) as ProviderSourceCard[]) : undefined;
  return (
    <div>
      <PageHeader title="Settings" />
      <SettingsNav active="job-sources" />
      <JobSourceCards initialCards={initialCards} />
    </div>
  );
}
