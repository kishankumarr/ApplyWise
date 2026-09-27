import { notFound } from "next/navigation";
import { AppError } from "@/server/errors";
import { requireUserId } from "@/server/http";
import { jobsService } from "@/server/services/jobs.service";
import { JobDetail } from "@/components/jobs/job-detail";

export const metadata = { title: "Job" };

export default async function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const userId = await requireUserId();
  try {
    const data = await jobsService.get(userId, id);
    return <JobDetail initial={JSON.parse(JSON.stringify(data))} />;
  } catch (e) {
    if (e instanceof AppError && e.status === 404) notFound();
    throw e;
  }
}
