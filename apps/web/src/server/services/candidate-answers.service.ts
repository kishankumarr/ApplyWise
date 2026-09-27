import "server-only";
import { prisma, verifiedSourceFacts } from "@applywise/database";
import { classifyQuestion, questionKeyFor, type AnswerSources } from "@applywise/job-engine";
import { isVerifiedTruthStatus, type CandidateAnswerView } from "@applywise/types";
import type { CandidateAnswerUpsertInput } from "@applywise/validation";
import { audit } from "../audit";
import { Errors } from "../errors";
import { profileRepo } from "../repositories/profile.repo";

/**
 * Reusable application answers (CandidateAnswer). Every row is written by the user - either directly in
 * Settings, or when they answer a NEEDS_INFORMATION question - and is reused by the answer resolver for every
 * later application. Nothing here is generated.
 */

/** Answers the user gave for one application only ("save for future applications" unticked). */
const SCOPE_PREFIX = "app:";
export function applicationScopedKey(applicationId: string, key: string): string {
  return `${SCOPE_PREFIX}${applicationId}:${key}`;
}

function view(a: { id: string; questionKey: string; question: string; answer: string; source: CandidateAnswerView["source"]; status: CandidateAnswerView["status"]; updatedAt: Date }): CandidateAnswerView {
  return { id: a.id, questionKey: a.questionKey, question: a.question, answer: a.answer, source: a.source, status: a.status, updatedAt: a.updatedAt.toISOString() };
}

/** Questionnaire answers are stored as option values; show them as the user meant them. */
function readableAnswer(value: string, freeText: string | null): string {
  if (freeText?.trim()) return freeText.trim();
  if (value === "yes_professional" || value === "yes_project" || value === "yes") return "Yes";
  if (value === "no") return "No";
  return value;
}

export const candidateAnswersService = {
  async list(userId: string): Promise<CandidateAnswerView[]> {
    const rows = await prisma.candidateAnswer.findMany({ where: { userId, NOT: { questionKey: { startsWith: SCOPE_PREFIX } } }, orderBy: { updatedAt: "desc" } });
    return rows.map(view);
  },

  async upsert(userId: string, input: CandidateAnswerUpsertInput, requestId?: string): Promise<CandidateAnswerView> {
    const profile = await profileRepo.ensure(userId);
    const questionKey = input.questionKey ?? questionKeyFor(input.question);
    const row = await prisma.candidateAnswer.upsert({
      where: { userId_questionKey: { userId, questionKey } },
      create: { userId, profileId: profile.id, questionKey, question: input.question, answer: input.answer, source: "CANDIDATE_ANSWER", status: "USER_VERIFIED" },
      update: { question: input.question, answer: input.answer, status: "USER_VERIFIED" },
    });
    // Sensitivity is recorded (not the answer itself): answers are PII and never go to the audit log.
    await audit(userId, "candidate_answer.saved", { requestId, entityType: "CandidateAnswer", entityId: row.id, metadata: { questionKey, sensitive: classifyQuestion(input.question).sensitive } });
    return view(row);
  },

  async remove(userId: string, id: string, requestId?: string): Promise<{ removed: boolean }> {
    const res = await prisma.candidateAnswer.deleteMany({ where: { id, userId } });
    if (res.count === 0) throw Errors.notFound("Answer");
    await audit(userId, "candidate_answer.deleted", { requestId, entityType: "CandidateAnswer", entityId: id });
    return { removed: true };
  },

  /**
   * Everything the answer resolver may use, in the resolver's order: verified profile and preferences,
   * TruthBank (verified facts + skills), previous questionnaire answers, the user's reusable answers and this
   * application's own answers (`applicationScoped`: "save for future applications" unticked, or a work-authorisation /
   * sponsorship answer whose country was unknown - see provideInformation).
   */
  async answerSources(userId: string, applicationId: string | null = null): Promise<AnswerSources> {
    const c = await profileRepo.ensure(userId);
    const [previous, reusable] = await Promise.all([
      prisma.jobAnswer.findMany({ where: { userId }, orderBy: { updatedAt: "desc" }, take: 500, include: { question: { select: { text: true } } } }),
      prisma.candidateAnswer.findMany({
        where: {
          userId,
          status: { in: ["USER_VERIFIED", "USER_EDITED"] },
          OR: [{ NOT: { questionKey: { startsWith: SCOPE_PREFIX } } }, ...(applicationId ? [{ questionKey: { startsWith: `${SCOPE_PREFIX}${applicationId}:` } }] : [])],
        },
      }),
    ]);
    const facts = verifiedSourceFacts(c);
    const education = c.educations.filter((e) => isVerifiedTruthStatus(e.status)).sort((a, b) => (b.endYear ?? 0) - (a.endYear ?? 0))[0];
    const pref = c.preference;
    return {
      profile: {
        fullName: c.fullName,
        email: c.email,
        phone: c.phone,
        currentTitle: c.currentTitle,
        currentCompany: c.currentCompany,
        yoe: c.yoe,
        linkedinUrl: c.linkedinUrl,
        githubUrl: c.githubUrl,
        portfolioUrl: c.portfolioUrl,
        // Preferred locations are not the candidate's current city: current location only comes from an answer.
        location: null,
        highestEducation: education ? [education.degree, education.field, education.institution].filter(Boolean).join(", ") : null,
      },
      preference: {
        noticePeriod: pref?.noticePeriod ?? null,
        expectedSalaryMin: pref?.expectedSalaryMin ?? null,
        expectedSalaryMax: pref?.expectedSalaryMax ?? null,
        currency: pref?.currency ?? "INR",
        openToRelocation: pref?.openToRelocation ?? null,
        workModePreference: pref?.workModePreference ?? null,
      },
      verifiedSkills: c.skills.filter((s) => isVerifiedTruthStatus(s.status)).map((s) => ({ id: s.id, name: s.name, canonicalName: s.canonicalName, yearsUsed: s.yearsUsed })),
      verifiedFacts: facts,
      previousAnswers: previous
        .filter((a) => a.value || a.freeText)
        .map((a) => ({ id: a.id, question: a.question.text, questionKey: questionKeyFor(a.question.text), answer: readableAnswer(a.value, a.freeText) })),
      // This application's own answers win over reusable ones for the same question. `applicationScoped` tells the
      // resolver which answers were given for this application only: for a work-authorisation / sponsorship question
      // whose country is unknown, only those count.
      candidateAnswers: reusable
        .map((a) => ({
          id: a.id,
          questionKey: a.questionKey.startsWith(SCOPE_PREFIX) ? a.questionKey.split(":").slice(2).join(":") : a.questionKey,
          question: a.question,
          answer: a.answer,
          applicationScoped: a.questionKey.startsWith(SCOPE_PREFIX),
        }))
        .sort((x, y) => Number(y.applicationScoped) - Number(x.applicationScoped)),
    };
  },
};
