import { PageHeader } from "@/components/page-header";
import { SettingsNav } from "@/components/settings-nav";
import { describeAiProvider } from "@applywise/ai";
import { PrivacySettings } from "@/components/settings/privacy-settings";

export const metadata = { title: "Privacy settings" };

export const dynamic = "force-dynamic";

export default function PrivacySettingsPage() {
  const ai = describeAiProvider();
  return (
    <div>
      <PageHeader title="Settings" />
      <SettingsNav active="privacy" />
      <PrivacySettings aiLabel={ai.shortLabel} aiExternal={ai.external} />
    </div>
  );
}
