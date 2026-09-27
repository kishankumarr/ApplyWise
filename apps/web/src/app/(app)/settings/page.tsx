import { Badge, Card, CardContent, CardHeader, CardTitle } from "@applywise/ui";
import { AccountSettings } from "@/components/settings/account-settings";
import { requireUserId } from "@/server/http";
import { emailVerificationService } from "@/server/services/email-verification.service";
import { PageHeader } from "@/components/page-header";
import { SettingsNav } from "@/components/settings-nav";

export const metadata = { title: "Settings" };

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const status = await emailVerificationService.status(await requireUserId());
  return (
    <div>
      <PageHeader title="Settings" />
      <SettingsNav active="account" />
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-base">Account email</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-2 text-sm" data-testid="account-email-status">
          <span>{status.email}</span>
          <Badge variant={status.verified ? "success" : "warning"}>{status.verified ? "Confirmed" : "Not confirmed"}</Badge>
          {!status.verified ? <span className="text-muted-foreground">Use the banner above to resend the confirmation link.</span> : null}
        </CardContent>
      </Card>
      <AccountSettings />
    </div>
  );
}
