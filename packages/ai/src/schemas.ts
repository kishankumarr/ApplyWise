import { z } from "zod";

/**
 * Schemas sent to Claude as structured-output formats. They are deliberately simple
 * (no transforms/refinements) so they convert cleanly to JSON Schema; stricter domain
 * validation runs afterwards.
 */

const nullableString = z.string().nullable();

export const aiParsedCvSchema = z.object({
  fullName: nullableString,
  email: nullableString,
  phone: nullableString,
  location: nullableString,
  headline: nullableString,
  summary: nullableString,
  links: z.object({
    portfolio: nullableString,
    github: nullableString,
    linkedin: nullableString,
    other: z.array(z.string()),
  }),
  totalYearsExperience: z.number().nullable(),
  experience: z.array(
    z.object({
      title: z.string(),
      company: z.string(),
      location: nullableString,
      startDate: nullableString,
      endDate: nullableString,
      isCurrent: z.boolean(),
      bullets: z.array(z.string()),
    }),
  ),
  education: z.array(
    z.object({
      institution: z.string(),
      degree: nullableString,
      field: nullableString,
      startYear: z.number().int().nullable(),
      endYear: z.number().int().nullable(),
    }),
  ),
  projects: z.array(
    z.object({ name: z.string(), description: z.string(), technologies: z.array(z.string()), url: nullableString }),
  ),
  skills: z.array(z.string()),
  certifications: z.array(z.string()),
  achievements: z.array(z.string()),
});

export const aiParsedJobSchema = z.object({
  title: nullableString,
  company: nullableString,
  locations: z.array(z.string()),
  workMode: z.enum(["remote", "hybrid", "onsite", "unknown"]),
  employmentType: z.enum(["full_time", "part_time", "contract", "internship", "unknown"]),
  requiredSkills: z.array(z.object({ name: z.string(), mandatory: z.boolean() })),
  preferredSkills: z.array(z.string()),
  otherRequirements: z.array(z.object({ text: z.string(), mandatory: z.boolean() })),
  responsibilities: z.array(z.string()),
  experienceMinYears: z.number().nullable(),
  experienceMaxYears: z.number().nullable(),
  salaryMinInr: z.number().nullable(),
  salaryMaxInr: z.number().nullable(),
  applyUrl: nullableString,
  hrEmail: nullableString,
  screeningQuestions: z.array(z.string()),
  applicationInstructions: nullableString,
});

export const aiQuestionnaireSchema = z.object({
  questions: z.array(
    z.object({
      id: z.string(),
      type: z.enum(["SKILL_CONFIRMATION", "EXPERIENCE_DETAIL", "METRIC", "SCREENING", "PREFERENCE", "ELIGIBILITY", "OPEN_TEXT"]),
      text: z.string(),
      whyAsked: z.string(),
      requiredForJob: z.boolean(),
      relatedRequirement: nullableString,
      options: z.array(z.object({ value: z.string(), label: z.string() })).nullable(),
      allowFreeText: z.boolean(),
      showWhen: z.object({ questionId: z.string(), equalsAny: z.array(z.string()) }).nullable(),
    }),
  ),
});

const aiClaim = z.object({ text: z.string(), sourceFactIds: z.array(z.string()) });

export const aiTailoredPlanSchema = z.object({
  summary: aiClaim,
  bulletChanges: z.array(
    z.object({
      experienceId: nullableString,
      originalFactId: nullableString,
      proposed: z.string(),
      sourceFactIds: z.array(z.string()),
      rationale: z.string(),
      confidence: z.enum(["high", "medium", "low"]),
    }),
  ),
  selectedSkills: z.array(z.object({ name: z.string(), sourceFactIds: z.array(z.string()) })),
  sectionOrder: z.array(z.enum(["summary", "experience", "projects", "skills", "education", "achievements"])),
  orderingNotes: z.array(z.string()),
  warnings: z.array(z.string()),
});

export const aiScreeningAnswerSchema = z.object({
  answer: z.string(),
  canConfirm: z.boolean(),
  claims: z.array(aiClaim),
});

export const aiEmailSchema = z.object({
  subject: z.string(),
  body: z.string(),
  claims: z.array(aiClaim),
});

export const aiCoverLetterSchema = z.object({
  body: z.string(),
  claims: z.array(aiClaim),
});

export const aiClaimAuditSchema = z.object({
  results: z.array(
    z.object({
      claimIndex: z.number().int(),
      supported: z.boolean(),
      severity: z.enum(["low", "medium", "high"]),
      reason: z.string(),
    }),
  ),
});
