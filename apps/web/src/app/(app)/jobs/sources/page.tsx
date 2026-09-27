import { Suspense } from "react";
import { JobSourcesPage, SourcesSkeleton } from "@/components/sources/job-sources-page";

export const metadata = { title: "Job sources" };

export default function JobSourcesRoute() {
  return (
    <Suspense fallback={<SourcesSkeleton />}>
      <JobSourcesPage />
    </Suspense>
  );
}
