import type { JobMatchReport, JobQuestion, NormalizedJob, QuestionOption } from "@applywise/types";

/**
 * Rule-based job-specific questionnaire (also the fallback when Claude is unavailable).
 * Questions are asked only to improve application quality, never to pressure the user
 * into claiming a skill: every skill question offers "No" and "Not sure".
 */

export const QUESTIONNAIRE_RULES_VERSION = "questionnaire-rules-v1";

export interface QuestionnaireCandidateContext {
  noticePeriod: string | null;
  expectedSalaryMin: number | null;
  expectedSalaryMax: number | null;
  preferredLocations: string[];
  openToRelocation: boolean;
  topExperienceBullets: { id: string; text: string }[];
}

const SKILL_OPTIONS: QuestionOption[] = [
  { value: "yes_professional", label: "Yes, in a professional role" },
  { value: "yes_project", label: "Yes, in a personal/side project" },
  { value: "no", label: "No" },
  { value: "not_sure", label: "Not sure" },
];

export function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

export function generateRuleBasedQuestionnaire(
  job: NormalizedJob,
  report: JobMatchReport,
  ctx: QuestionnaireCandidateContext,
): JobQuestion[] {
  const questions: JobQuestion[] = [];
  const push = (q: JobQuestion) => {
    if (questions.length < 8 && !questions.some((x) => x.id === q.id)) questions.push(q);
  };
  const text = job.description.toLowerCase();

  // 1. Employer screening questions detected in the JD come first.
  for (const [i, sq] of job.screeningQuestions.slice(0, 3).entries()) {
    push({
      id: `screening_${i + 1}`,
      type: "SCREENING",
      text: sq.slice(0, 300),
      whyAsked: "The employer asks this in the job posting; your answer is used to draft a truthful response.",
      requiredForJob: true,
      relatedRequirement: null,
      options: null,
      allowFreeText: true,
      showWhen: null,
    });
  }

  // 2. Missing required skills: confirm, then ask for detail only if the user says yes.
  const missing = report.missingMandatoryRequirements.slice(0, 2);
  for (const m of missing) {
    const id = `skill_${slug(m.canonicalName)}`;
    push({
      id,
      type: "SKILL_CONFIRMATION",
      text: `Have you worked with ${m.requirement}?`,
      whyAsked: `${m.requirement} is ${m.mandatory ? "a mandatory" : "a required"} skill for this job and is not in your verified profile. Answer "No" if you have not - that is completely fine.`,
      requiredForJob: m.mandatory,
      relatedRequirement: m.requirement,
      options: SKILL_OPTIONS,
      allowFreeText: false,
      showWhen: null,
    });
    push({
      id: `${id}_detail`,
      type: "EXPERIENCE_DETAIL",
      text: `Briefly, where and how did you use ${m.requirement}?`,
      whyAsked: "A concrete, truthful example lets us add this skill to your tailored resume with a source.",
      requiredForJob: false,
      relatedRequirement: m.requirement,
      options: null,
      allowFreeText: true,
      showWhen: { questionId: id, equalsAny: ["yes_professional", "yes_project"] },
    });
  }

  // 3. Unverified matches: confirm the parsed claim.
  for (const m of report.unverifiedMatches.slice(0, 1)) {
    push({
      id: `confirm_${slug(m.canonicalName)}`,
      type: "SKILL_CONFIRMATION",
      text: `Your CV mentions ${m.requirement}. Is that accurate?`,
      whyAsked: "This claim was parsed from your CV but not yet verified; only verified facts are used in applications.",
      requiredForJob: false,
      relatedRequirement: m.requirement,
      options: [
        { value: "yes_professional", label: "Yes, professionally" },
        { value: "yes_project", label: "Yes, in projects" },
        { value: "no", label: "No, remove it" },
        { value: "not_sure", label: "Not sure" },
      ],
      allowFreeText: false,
      showWhen: null,
    });
  }

  // 4. Location / relocation - only when the job location conflicts with preferences.
  if (report.locationFit.fit === "poor" || report.locationFit.fit === "partial") {
    const where = job.location.join(" / ") || "the job location";
    push({
      id: "pref_location",
      type: "PREFERENCE",
      text: `This role is ${job.workMode === "unknown" ? "based" : job.workMode} in ${where}. Would you work from there?`,
      whyAsked: "The job location differs from your saved preferences.",
      requiredForJob: true,
      relatedRequirement: where,
      options: [
        { value: "yes", label: "Yes" },
        { value: "yes_relocate", label: "Yes, I would relocate" },
        { value: "no", label: "No" },
        { value: "not_sure", label: "Not sure yet" },
      ],
      allowFreeText: false,
      showWhen: null,
    });
  }

  // 5. Notice period - only if the JD cares about joining timelines.
  if (/immediate joiner|notice period|join (within|immediately)|early joiner/.test(text)) {
    push({
      id: "elig_notice",
      type: "ELIGIBILITY",
      text: "What is your current notice period?",
      whyAsked: "The job posting mentions joining timelines.",
      requiredForJob: true,
      relatedRequirement: "Notice period",
      options: [
        { value: "immediate", label: "Immediate" },
        { value: "15", label: "15 days" },
        { value: "30", label: "30 days" },
        { value: "60", label: "60 days" },
        { value: "90", label: "90 days" },
      ],
      allowFreeText: false,
      showWhen: null,
    });
  }

  // 6. Work authorisation - only if the JD mentions it.
  if (/work authori[sz]ation|authori[sz]ed to work|visa|right to work/.test(text)) {
    push({
      id: "elig_work_auth",
      type: "ELIGIBILITY",
      text: "Are you authorised to work in the job's location without sponsorship?",
      whyAsked: "The job posting mentions work authorisation.",
      requiredForJob: true,
      relatedRequirement: "Work authorisation",
      options: [
        { value: "yes", label: "Yes" },
        { value: "no", label: "No" },
        { value: "not_sure", label: "Not sure" },
      ],
      allowFreeText: false,
      showWhen: null,
    });
  }

  // 7. Salary - only if the JD asks for expected CTC.
  if (/expected ctc|current ctc|salary expectation|expected salary|compensation expectation/.test(text)) {
    push({
      id: "pref_salary",
      type: "PREFERENCE",
      text: "What expected CTC (in LPA) should we mention, if any?",
      whyAsked: "The employer asks for salary expectations. Leave blank to skip.",
      requiredForJob: false,
      relatedRequirement: "Expected CTC",
      options: null,
      allowFreeText: true,
      showWhen: null,
    });
  }

  // 8. Metric for the strongest relevant bullet - optional, never invented.
  const bullet = ctx.topExperienceBullets[0];
  if (bullet) {
    push({
      id: "metric_top_bullet",
      type: "METRIC",
      text: `Do you have a real, measurable outcome for: "${bullet.text.slice(0, 140)}"?`,
      whyAsked: "Concrete results strengthen resumes. Leave blank if you do not have a verified number - we never invent metrics.",
      requiredForJob: false,
      relatedRequirement: bullet.id,
      options: null,
      allowFreeText: true,
      showWhen: null,
    });
  }

  // 9. Pad to the minimum of 3 with useful open questions.
  const fillers: JobQuestion[] = [
    {
      id: "open_motivation",
      type: "OPEN_TEXT",
      text: `What interests you about ${job.company}'s ${job.title} role? (optional)`,
      whyAsked: "A genuine reason makes the cover letter and email specific instead of generic.",
      requiredForJob: false,
      relatedRequirement: null,
      options: null,
      allowFreeText: true,
      showWhen: null,
    },
    {
      id: "open_best_project",
      type: "OPEN_TEXT",
      text: "Which of your projects or roles best shows your fit for this job?",
      whyAsked: "We use this to decide what to put first in the tailored resume.",
      requiredForJob: false,
      relatedRequirement: null,
      options: null,
      allowFreeText: true,
      showWhen: null,
    },
    {
      id: "pref_highlight",
      type: "PREFERENCE",
      text: "How should your resume be framed for this role?",
      whyAsked: "Controls emphasis and ordering; it never adds new claims.",
      requiredForJob: false,
      relatedRequirement: null,
      options: [
        { value: "depth", label: "Depth in the core stack" },
        { value: "breadth", label: "Breadth across the stack" },
        { value: "product", label: "Product and user impact" },
        { value: "not_sure", label: "Not sure - you decide" },
      ],
      allowFreeText: false,
      showWhen: null,
    },
  ];
  for (const f of fillers) {
    if (questions.length >= 3) break;
    push(f);
  }
  return questions;
}
