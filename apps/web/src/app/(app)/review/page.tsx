import { JOB_PROVIDER_IDS, providerLabel } from "@applywise/job-engine";
import { pageCountOf } from "@/components/pager";
import { REVIEW_PAGE_SIZE, reviewPageParam } from "@/components/review/review-paging";
import { ReviewQueue } from "@/components/review/review-queue";
import { requireUserId } from "@/server/http";
import { reviewQueueService } from "@/server/services/review-queue.service";
import { automationSettingsService } from "@/server/services/automation-settings.service";

export const metadata = { title: "Review queue" };
export const dynamic = "force-dynamic";

export default async function ReviewPage({ searchParams }: { searchParams: Promise<{ page?: string | string[] }> }) {
  const userId = await requireUserId();
  const requested = reviewPageParam((await searchParams).page);
  // Only the visible page of cards is loaded and described; the client pages through the rest.
  const [first, { settings }] = await Promise.all([reviewQueueService.page(userId, { page: requested, pageSize: REVIEW_PAGE_SIZE }), automationSettingsService.ensure(userId)]);
  // A page past the end (the queue shrank since the link was made): show the last page instead.
  const lastPage = pageCountOf(first.total, first.pageSize);
  const queue = requested > lastPage ? await reviewQueueService.page(userId, { page: lastPage, pageSize: REVIEW_PAGE_SIZE }) : first;
  // Provider ids -> display names (static catalogue; safe for the browser).
  const providerLabels = Object.fromEntries(JOB_PROVIDER_IDS.map((id) => [id, providerLabel(id)]));
  return <ReviewQueue initial={queue} settingsMode={settings.mode} tailorResume={settings.tailorResume} providerLabels={providerLabels} />;
}
