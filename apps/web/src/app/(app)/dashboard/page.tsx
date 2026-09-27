import { Suspense } from "react";
import { redirect } from "next/navigation";
import { prisma } from "@applywise/database";
import { PageHeader } from "@/components/page-header";
import { requireUserId } from "@/server/http";
import {
  AutomationStatusSection,
  AutomationStatusSkeleton,
  JobListSkeleton,
  MetricsSection,
  MetricsSkeleton,
  NewJobsSection,
  ProfileHealthSection,
  ProfileHealthSkeleton,
  TopMatchesSection,
} from "./sections";

export const metadata = { title: "Dashboard" };

/** The shell (header) waits only for the onboarding check; every card streams in on its own as its data arrives. */
export default async function DashboardPage() {
  const userId = await requireUserId();
  const profile = await prisma.candidateProfile.findUnique({ where: { userId }, select: { fullName: true, onboardingCompleted: true } });
  if (!profile?.onboardingCompleted) redirect("/onboarding");

  return (
    <div className="space-y-6">
      <PageHeader title={`Welcome${profile.fullName ? `, ${profile.fullName.split(" ")[0]}` : ""}`} description="Your job search at a glance." />
      <Suspense fallback={<AutomationStatusSkeleton />}>
        <AutomationStatusSection userId={userId} />
      </Suspense>
      <Suspense fallback={<MetricsSkeleton />}>
        <MetricsSection userId={userId} />
      </Suspense>
      <Suspense fallback={<JobListSkeleton />}>
        <NewJobsSection userId={userId} />
      </Suspense>
      <div className="grid gap-4 lg:grid-cols-3">
        <Suspense fallback={<JobListSkeleton title="Top matches" rows={5} className="lg:col-span-2" />}>
          <TopMatchesSection userId={userId} />
        </Suspense>
        <Suspense fallback={<ProfileHealthSkeleton />}>
          <ProfileHealthSection userId={userId} />
        </Suspense>
      </div>
    </div>
  );
}
