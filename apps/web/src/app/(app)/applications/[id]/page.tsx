import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { prisma } from "@applywise/database";
import { buttonVariants, cn } from "@applywise/ui";
import { ApplicationWorkspace } from "@/components/applications/application-workspace";
import { PageHeader } from "@/components/page-header";
import { requireUserId } from "@/server/http";

export const metadata = { title: "Application" };

export default async function ApplicationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const userId = await requireUserId();
  const app = await prisma.application.findFirst({ where: { id, userId }, include: { job: { select: { id: true, title: true, company: true } } } });
  if (!app) notFound();
  return (
    <div>
      <PageHeader
        title={`${app.job.title}`}
        description={
          <>
            {app.job.company} ·{" "}
            <Link href={`/jobs/${app.job.id}`} className="underline">
              View job and match report
            </Link>
          </>
        }
        actions={
          <Link href="/applications" className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}>
            <ArrowLeft aria-hidden="true" /> All applications
          </Link>
        }
      />
      <ApplicationWorkspace applicationId={app.id} />
    </div>
  );
}
