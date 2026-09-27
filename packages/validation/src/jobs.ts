import { z } from "zod";
import {
  applicationStatusSchema,
  applyMethodSchema,
  employmentTypeSchema,
  jobImportMethodSchema,
  jobPlatformSchema,
  jobWorkModeSchema,
  nonEmptyString,
  optionalEmailSchema,
  optionalUrlSchema,
  seniorityLevelSchema,
  trimmedString,
} from "./common";

export const jobSkillSchema = z.object({
  name: nonEmptyString(80),
  canonicalName: nonEmptyString(80),
  mandatory: z.boolean(),
});

export const normalizedJobSchema = z.object({
  id: z.string().optional(),
  platform: jobPlatformSchema,
  title: nonEmptyString(200),
  company: nonEmptyString(200),
  companyWebsite: z.string().max(2048).nullable(),
  location: z.array(z.string().max(120)).max(20),
  workMode: jobWorkModeSchema,
  employmentType: employmentTypeSchema,
  seniority: seniorityLevelSchema,
  description: z.string().max(40_000),
  responsibilities: z.array(z.string().max(1000)).max(60),
  requiredSkills: z.array(jobSkillSchema).max(60),
  preferredSkills: z.array(jobSkillSchema).max(60),
  otherRequirements: z.array(z.object({ text: z.string().max(500), mandatory: z.boolean() })).max(30),
  domains: z.array(z.string().max(60)).max(20),
  experienceMinYears: z.number().min(0).max(40).nullable(),
  experienceMaxYears: z.number().min(0).max(50).nullable(),
  salaryMin: z.number().nonnegative().nullable(),
  salaryMax: z.number().nonnegative().nullable(),
  currency: z.string().max(8).nullable(),
  postedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  applyUrl: z.string().max(2048).nullable(),
  hrEmail: z.string().max(320).nullable(),
  applicationInstructions: z.string().max(4000).nullable(),
  screeningQuestions: z.array(z.string().max(500)).max(20),
  applyMethod: applyMethodSchema,
  importMethod: jobImportMethodSchema,
  sourceUrl: z.string().max(2048).nullable(),
  sourceExternalId: z.string().max(200).nullable(),
  isDemo: z.boolean().optional(),
});

const commaList = z
  .union([z.array(z.string()), z.string()])
  .optional()
  .transform((v) =>
    (Array.isArray(v) ? v : (v ?? "").split(","))
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 40),
  );

/** POST /api/jobs/manual - structured manual entry OR pasted raw description. */
export const manualJobSchema = z
  .object({
    mode: z.enum(["structured", "paste", "career_page_url"]).default("structured"),
    title: trimmedString(200).optional(),
    company: trimmedString(200).optional(),
    location: commaList,
    workMode: jobWorkModeSchema.optional(),
    platform: jobPlatformSchema.optional(),
    description: z.string().trim().min(20, "Paste at least a few lines of the job description").max(40_000),
    requiredSkills: commaList,
    preferredSkills: commaList,
    experienceMinYears: z.number().min(0).max(40).nullable().optional(),
    experienceMaxYears: z.number().min(0).max(50).nullable().optional(),
    applyUrl: optionalUrlSchema,
    hrEmail: optionalEmailSchema,
    sourceUrl: optionalUrlSchema,
  })
  .refine((v) => v.mode !== "career_page_url" || !!v.sourceUrl || !!v.applyUrl, {
    message: "Official career-page URL is required",
    path: ["sourceUrl"],
  });
export type ManualJobInput = z.infer<typeof manualJobSchema>;

export const csvImportSchema = z.object({
  csv: z.string().min(10).max(2_000_000),
});

export const emailImportSchema = z.object({
  /** Raw RFC822 (.eml) or plain-text content of a job-alert email the user forwarded. */
  raw: z.string().min(20).max(2_000_000),
});

/** POST /api/jobs/import/browser - payload from the user-triggered extension import. */
export const browserImportSchema = z.object({
  pageUrl: z.url({ protocol: /^https?$/ }).max(2048),
  pageTitle: trimmedString(300).optional().default(""),
  title: nonEmptyString(200),
  company: trimmedString(200).optional().default(""),
  location: trimmedString(300).optional().default(""),
  description: z.string().trim().min(20).max(40_000),
  applyUrl: optionalUrlSchema,
  contactEmail: optionalEmailSchema,
  /** The user confirmed the extracted preview before upload. */
  userConfirmed: z.literal(true),
});
export type BrowserImportInput = z.infer<typeof browserImportSchema>;

const csvToArray = z
  .string()
  .optional()
  .transform((v) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : []));

/** GET /api/jobs query string. */
export const jobListQuerySchema = z.object({
  q: trimmedString(200).optional(),
  platform: csvToArray,
  company: trimmedString(200).optional(),
  location: trimmedString(120).optional(),
  workMode: csvToArray,
  minYoe: z.coerce.number().min(0).max(40).optional(),
  maxYoe: z.coerce.number().min(0).max(50).optional(),
  postedWithinDays: z.coerce.number().int().min(1).max(365).optional(),
  minScore: z.coerce.number().min(0).max(100).optional(),
  status: csvToArray,
  /** Automation decisions (IGNORE, RECOMMEND, REVIEW, AUTO_ELIGIBLE) and/or NONE (not evaluated). */
  decision: csvToArray.optional(),
  applyMethod: csvToArray,
  includeIgnored: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
  savedOnly: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
  /** Only jobs found since the user last marked the inbox as seen. */
  newOnly: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
  /** Only jobs from this automatic source. */
  feedId: trimmedString(40).optional(),
  sort: z.enum(["score", "posted", "company", "title", "found"]).default("score"),
  order: z.enum(["asc", "desc"]).default("desc"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});
export type JobListQuery = z.infer<typeof jobListQuerySchema>;

export const jobStateUpdateSchema = z.object({
  saved: z.boolean().optional(),
  ignored: z.boolean().optional(),
});

export const batchPrepareSchema = z.object({
  jobIds: z.array(z.string().min(1)).min(1).max(10, "You can prepare at most 10 jobs at a time"),
});

export { applicationStatusSchema };
