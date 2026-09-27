import { notFound } from "next/navigation";
import { prisma } from "@applywise/database";
import { Alert, AlertDescription, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@applywise/ui";
import { DemoReset } from "@/components/settings/demo-reset";
import { PageHeader } from "@/components/page-header";
import { env } from "@/env";

export const metadata = { title: "Demo data" };
export const dynamic = "force-dynamic";

/** Local development only. Disabled unless ENABLE_DEMO_ADMIN=true and never in production. */
export default async function DemoDataPage() {
  if (!env().ENABLE_DEMO_ADMIN || env().NODE_ENV === "production") notFound();
  const [demoJobs, users, applications] = await Promise.all([prisma.job.count({ where: { isDemo: true } }), prisma.user.count(), prisma.application.count()]);
  return (
    <div className="space-y-6">
      <PageHeader title="Demo data (development only)" />
      <Alert variant="warning">
        <AlertDescription>All demo jobs, companies, URLs and email addresses are fictional. Emails use the reserved .test domain.</AlertDescription>
      </Alert>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Status</CardTitle>
          <CardDescription>
            {demoJobs} demo jobs · {users} users · {applications} applications
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p>Re-seeding recreates the shared demo job catalogue (applications for demo jobs are removed) and recomputes your match scores.</p>
          <p>
            Full reset including the demo user: run <code>pnpm db:seed</code>.
          </p>
          <DemoReset />
        </CardContent>
      </Card>
    </div>
  );
}
