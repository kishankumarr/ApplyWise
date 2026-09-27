import type { CandidateAnswerView } from "@applywise/types";
import { PageHeader } from "@/components/page-header";
import { SettingsNav } from "@/components/settings-nav";
import { AnswersManager } from "@/components/settings/answers-manager";
import { requireUserId } from "@/server/http";
import { candidateAnswersService } from "@/server/services/candidate-answers.service";

export const metadata = { title: "Application answers" };
export const dynamic = "force-dynamic";

export default async function ApplicationAnswersPage() {
  const userId = await requireUserId();
  // A failure here is not fatal: the client component loads the answers itself and shows an error with a retry.
  const answers = await candidateAnswersService.list(userId).catch(() => undefined);
  const initialAnswers = answers ? (JSON.parse(JSON.stringify(answers)) as CandidateAnswerView[]) : undefined;
  return (
    <div>
      <PageHeader title="Settings" />
      <SettingsNav active="answers" />
      <AnswersManager initialAnswers={initialAnswers} />
    </div>
  );
}
