import "server-only";
import { jobRowToNormalized, prisma, toMatchCandidate, verifiedSourceFacts } from "@applywise/database";
import { computeMatchReport } from "@applywise/job-engine";
import type { GenerationContext } from "@applywise/ai";
import { getAiConfig, type AiConfig } from "@applywise/ai";
import { isVerifiedTruthStatus } from "@applywise/types";
import { profileRepo } from "../repositories/profile.repo";
import { jobsService } from "./jobs.service";
import { consentService } from "./consent.service";

/** Assemble the verified-facts-only context used by every generator. */
export async function buildGenerationContext(userId: string, jobId: string): Promise<GenerationContext> {
  const [candidate, jobRow] = await Promise.all([profileRepo.ensure(userId), jobsService.getRow(userId, jobId)]);
  const job = jobRowToNormalized(jobRow);
  const matchReport = computeMatchReport(job, toMatchCandidate(candidate));
  const answers = await prisma.jobAnswer.findMany({
    where: { userId, question: { questionnaire: { jobId, userId } } },
    include: { question: { select: { key: true, text: true } } },
  });
  return {
    job,
    candidate: {
      fullName: candidate.fullName,
      email: candidate.email,
      phone: candidate.phone,
      yoe: candidate.yoe,
      currentTitle: candidate.currentTitle,
      currentCompany: candidate.currentCompany,
      noticePeriod: candidate.preference?.noticePeriod ?? null,
      preferredLocations: candidate.preference?.preferredLocations ?? [],
      openToRelocation: candidate.preference?.openToRelocation ?? false,
      linkedinUrl: candidate.linkedinUrl,
      githubUrl: candidate.githubUrl,
      portfolioUrl: candidate.portfolioUrl,
    },
    facts: verifiedSourceFacts(candidate),
    experiences: candidate.experiences
      .filter((e) => e.status !== "USER_REJECTED")
      .map((e) => ({ id: e.id, title: e.title, company: e.company, bulletFactIds: e.bullets.filter((b) => isVerifiedTruthStatus(b.status)).map((b) => b.id) })),
    answers: answers.map((a) => ({ questionId: a.question.key, questionText: a.question.text, value: a.value, freeText: a.freeText, factId: a.truthBankItemId })),
    matchReport,
  };
}

/** AI config honouring the user's consent: without AI consent, no AI model (Claude or local) is used. */
export async function aiConfigFor(userId: string): Promise<AiConfig> {
  const consents = await consentService.get(userId);
  const base = getAiConfig();
  return consents.aiProcessing ? base : { ...base, disabled: true };
}
