import { redirect } from "next/navigation";
import { prisma } from "@applywise/database";
import { VerifyEmailNotice } from "@/components/verify-email-notice";
import { auth } from "@/auth";
import { AppNav } from "@/components/app-nav";
import { env } from "@/env";
import { verificationDeliveryInfo } from "@/server/services/email-verification.service";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user?.id) redirect("/sign-in");
  const account = await prisma.user.findUnique({ where: { id: session.user.id }, select: { email: true, emailVerifiedAt: true } });
  return (
    <div className="min-h-screen md:flex">
      <AppNav userName={session.user.name ?? session.user.email ?? "You"} showAdmin={!!env().ENABLE_DEMO_ADMIN} />
      <main id="main" className="min-w-0 flex-1 px-4 py-6 md:px-8">
        {account && !account.emailVerifiedAt ? <VerifyEmailNotice email={account.email} {...verificationDeliveryInfo()} /> : null}
        {children}
      </main>
    </div>
  );
}
