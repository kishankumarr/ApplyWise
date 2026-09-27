import { describeAiProvider } from "@applywise/ai";
import { OnboardingWizard } from "@/components/onboarding-wizard";

export const metadata = { title: "Onboarding" };

export const dynamic = "force-dynamic";

export default function OnboardingPage() {
  const ai = describeAiProvider();
  return <OnboardingWizard maxUploadMb={Number(process.env.MAX_UPLOAD_MB ?? 5)} aiLabel={ai.shortLabel} aiExternal={ai.external} />;
}
