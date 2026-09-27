import { z } from "zod";
import {
  cuidSchema,
  factKindSchema,
  nonEmptyString,
  optionalEmailSchema,
  optionalUrlSchema,
  skillSourceSchema,
  stringList,
  trimmedString,
  truthStatusSchema,
  workModePreferenceSchema,
} from "./common";

export const truthBankItemSchema = z.object({
  id: cuidSchema,
  kind: factKindSchema,
  text: nonEmptyString(2000),
  status: truthStatusSchema,
  section: z.string().nullable().optional(),
  experienceId: z.string().nullable().optional(),
  projectId: z.string().nullable().optional(),
  educationId: z.string().nullable().optional(),
});

export const candidateSkillSchema = z.object({
  id: cuidSchema,
  name: nonEmptyString(80),
  canonicalName: nonEmptyString(80),
  source: skillSourceSchema,
  status: truthStatusSchema,
  yearsUsed: z.number().min(0).max(50).nullable().optional(),
});

export const experienceSchema = z.object({
  id: cuidSchema,
  title: nonEmptyString(160),
  company: nonEmptyString(160),
  location: z.string().max(160).nullable().optional(),
  startDate: z.string().max(32).nullable().optional(),
  endDate: z.string().max(32).nullable().optional(),
  isCurrent: z.boolean(),
  status: truthStatusSchema,
  bullets: z.array(truthBankItemSchema),
});

export const educationSchema = z.object({
  id: cuidSchema,
  institution: nonEmptyString(200),
  degree: z.string().max(160).nullable().optional(),
  field: z.string().max(160).nullable().optional(),
  startYear: z.number().int().min(1950).max(2100).nullable().optional(),
  endYear: z.number().int().min(1950).max(2100).nullable().optional(),
  status: truthStatusSchema,
});

export const projectSchema = z.object({
  id: cuidSchema,
  name: nonEmptyString(160),
  description: z.string().max(3000),
  url: z.string().max(2048).nullable().optional(),
  technologies: z.array(z.string().max(80)).max(40),
  status: truthStatusSchema,
});

/** Full candidate profile - the shared, validated shape of the domain type. */
export const candidateProfileSchema = z.object({
  id: cuidSchema,
  userId: cuidSchema,
  fullName: z.string().max(160).nullable(),
  email: z.string().max(320).nullable(),
  phone: z.string().max(32).nullable(),
  yoe: z.number().min(0).max(60).nullable(),
  preferredLocations: z.array(z.string().max(120)),
  workModePreference: workModePreferenceSchema,
  openToRelocation: z.boolean(),
  targetRoles: z.array(z.string().max(120)),
  noticePeriod: z.string().max(60).nullable(),
  expectedSalaryMin: z.number().nonnegative().nullable(),
  expectedSalaryMax: z.number().nonnegative().nullable(),
  currentTitle: z.string().max(160).nullable(),
  currentCompany: z.string().max(160).nullable(),
  portfolioUrl: z.string().max(2048).nullable(),
  githubUrl: z.string().max(2048).nullable(),
  linkedinUrl: z.string().max(2048).nullable(),
  summary: z.string().max(3000).nullable(),
  skills: z.array(candidateSkillSchema),
  experience: z.array(experienceSchema),
  education: z.array(educationSchema),
  projects: z.array(projectSchema),
  truthBankItems: z.array(truthBankItemSchema),
});

export const NOTICE_PERIOD_OPTIONS = [
  "Immediate",
  "15 days",
  "30 days",
  "45 days",
  "60 days",
  "90 days",
] as const;

/** PATCH /api/profile - partial update of editable profile + preferences. */
export const profileUpdateSchema = z
  .object({
    fullName: trimmedString(160).nullable(),
    email: optionalEmailSchema,
    phone: z
      .union([z.literal(""), z.null(), z.string().trim().regex(/^[+0-9 ()-]{7,20}$/, "Invalid phone")])
      .optional()
      .transform((v) => (v ? v : null)),
    yoe: z.number().min(0).max(60).nullable(),
    preferredLocations: stringList(20),
    workModePreference: workModePreferenceSchema,
    openToRelocation: z.boolean(),
    targetRoles: stringList(10),
    noticePeriod: trimmedString(60).nullable(),
    expectedSalaryMin: z.number().int().nonnegative().max(1_000_000_000).nullable(),
    expectedSalaryMax: z.number().int().nonnegative().max(1_000_000_000).nullable(),
    currentTitle: trimmedString(160).nullable(),
    currentCompany: trimmedString(160).nullable(),
    portfolioUrl: optionalUrlSchema,
    githubUrl: optionalUrlSchema,
    linkedinUrl: optionalUrlSchema,
    summary: trimmedString(3000).nullable(),
    onboardingCompleted: z.boolean(),
  })
  .partial()
  .refine(
    (v) =>
      v.expectedSalaryMin == null ||
      v.expectedSalaryMax == null ||
      v.expectedSalaryMin <= v.expectedSalaryMax,
    { message: "Minimum salary must not exceed maximum", path: ["expectedSalaryMin"] },
  );
export type ProfileUpdateInput = z.infer<typeof profileUpdateSchema>;

/** POST /api/profile/facts/[factId]/verify - optionally with an edited text. */
export const factVerifySchema = z.object({
  editedText: trimmedString(2000).min(1).optional(),
});

export const addSkillSchema = z.object({
  name: nonEmptyString(80),
});

export const consentUpdateSchema = z.object({
  cvProcessing: z.boolean().optional(),
  aiProcessing: z.boolean().optional(),
  emailSending: z.boolean().optional(),
  analytics: z.boolean().optional(),
  /** Standing authorisation for AUTO mode to submit applications (see docs/platform-integration-policy.md). */
  autoApply: z.boolean().optional(),
});
export type ConsentUpdateInput = z.infer<typeof consentUpdateSchema>;
