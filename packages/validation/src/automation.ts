import { z } from "zod";
import { APPLICATION_MODES, APPLY_METHODS, JOB_WORK_MODES } from "@applywise/types";
import { nonEmptyString, stringList, trimmedString } from "./common";

const minutesOfDay = z.number().int().min(0).max(1439);
const score = z.number().int().min(0).max(100);

export const automationRulesUpdateSchema = z
  .object({
    targetTitles: stringList(30, 120),
    excludedTitles: stringList(30, 120),
    preferredCompanies: stringList(50, 120),
    excludedCompanies: stringList(100, 120),
    requiredSkills: stringList(30, 80),
    requiredSkillsMode: z.enum(["any", "all"]),
    allowMissingMandatorySkills: z.boolean(),
    maxExperienceGapYears: z.number().min(0).max(20),
    locationMode: z.enum(["preferences", "any"]),
    allowedWorkModes: z.array(z.enum(JOB_WORK_MODES)).max(4),
    minSalary: z.number().int().min(0).max(1_000_000_000).nullable(),
    salaryCurrency: z.string().trim().length(3).toUpperCase(),
    allowedApplyMethods: z.array(z.enum(APPLY_METHODS)).max(4),
  })
  .partial()
  .strict();
export type AutomationRulesUpdateInput = z.infer<typeof automationRulesUpdateSchema>;

/** PUT /api/automation/settings - the Automation control centre. */
export const automationSettingsUpdateSchema = z
  .object({
    enabled: z.boolean(),
    mode: z.enum(APPLICATION_MODES),
    recommendScore: score,
    minMatchScore: score,
    autoApplyScore: score,
    maxApplicationsPerDay: z.number().int().min(0).max(500),
    maxJobAgeDays: z.number().int().min(1).max(365),
    searchFrequencyMinutes: z
      .number()
      .int()
      .min(15)
      .max(7 * 24 * 60),
    enabledProviders: z.array(z.string().trim().min(1).max(40)).max(40),
    quietHoursStart: minutesOfDay.nullable(),
    quietHoursEnd: minutesOfDay.nullable(),
    timezone: z.string().trim().min(1).max(64),
    tailorResume: z.boolean(),
    generateCoverLetter: z.boolean(),
    allowEmailApplications: z.boolean(),
    notifyStrongMatches: z.boolean(),
    dailySummaryHour: z.number().int().min(0).max(23).nullable(),
    /** Grants or revokes the AUTO_APPLY consent (required for AUTO mode submissions). */
    autoApplyConsent: z.boolean(),
    rules: automationRulesUpdateSchema,
  })
  .partial()
  .strict()
  .superRefine((v, ctx) => {
    if (v.recommendScore != null && v.minMatchScore != null && v.recommendScore > v.minMatchScore) {
      ctx.addIssue({
        code: "custom",
        path: ["recommendScore"],
        message: "Must not be higher than the minimum match score",
      });
    }
    if (v.minMatchScore != null && v.autoApplyScore != null && v.minMatchScore > v.autoApplyScore) {
      ctx.addIssue({
        code: "custom",
        path: ["autoApplyScore"],
        message: "Must be at least the minimum match score",
      });
    }
  });
export type AutomationSettingsUpdateInput = z.infer<typeof automationSettingsUpdateSchema>;

export const automationRunsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  cursor: z.string().min(1).max(64).optional(),
});
export type AutomationRunsQuery = z.infer<typeof automationRunsQuerySchema>;

/** POST /api/automation/run - "Run now". */
export const automationRunNowSchema = z.object({ includeDemo: z.boolean().optional() }).strict();

/** PUT /api/candidate-answers - a reusable answer written by the user. */
export const candidateAnswerUpsertSchema = z
  .object({
    questionKey: z.string().trim().min(1).max(120).optional(),
    question: nonEmptyString(500),
    answer: nonEmptyString(2000),
  })
  .strict();
export type CandidateAnswerUpsertInput = z.infer<typeof candidateAnswerUpsertSchema>;

/** POST /api/applications/[id]/answers - answers to NEEDS_INFORMATION questions; resumes the workflow. */
export const applicationAnswersSchema = z
  .object({
    answers: z
      .array(
        z.object({
          key: z.string().trim().min(1).max(120),
          question: nonEmptyString(500),
          answer: nonEmptyString(2000),
          /** Save as a reusable answer for future applications (default true). */
          remember: z.boolean().optional().default(true),
        }),
      )
      .min(1)
      .max(30),
  })
  .strict();
export type ApplicationAnswersInput = z.infer<typeof applicationAnswersSchema>;

/** PUT /api/applications/[id]/resume - override the automatically selected resume (null = automatic). */
export const applicationResumeOverrideSchema = z
  .object({ resumeId: z.string().min(1).max(64).nullable() })
  .strict();
export type ApplicationResumeOverrideInput = z.infer<typeof applicationResumeOverrideSchema>;

export const applicationDeclineSchema = z
  .object({ reason: trimmedString(500).optional() })
  .strict();
export type ApplicationDeclineInput = z.infer<typeof applicationDeclineSchema>;

export const applicationSkipSchema = z
  .object({ days: z.number().int().min(1).max(30).optional().default(1) })
  .strict();
export type ApplicationSkipInput = z.infer<typeof applicationSkipSchema>;

/** POST /api/applications/[id]/apply - "Approve & apply" (REVIEW queue) or retry after a manual fix. */
export const applicationApplySchema = z
  .object({
    /** The user confirms they reviewed the content and want it submitted by the automation. */
    userConfirmed: z.literal(true, { error: "Explicit confirmation is required" }),
    retry: z.boolean().optional().default(false),
    /** After an uncertain attempt: the user checked the employer's page and the application was not received. */
    acknowledgeUncertain: z.boolean().optional().default(false),
  })
  .strict();
export type ApplicationApplyInput = z.infer<typeof applicationApplySchema>;

/** ?page=&pageSize= for server-paginated lists (1-based; pages past the end return no items). */
export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(25),
});
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

/** GET /api/automation/review - the queue shows full review cards, so pages are smaller. */
export const reviewQueueQuerySchema = paginationQuerySchema.extend({
  pageSize: z.coerce.number().int().min(1).max(50).optional().default(10),
});

export const applicationListQuerySchema = paginationQuerySchema.extend({
  view: z.enum(["active", "pipeline", "all"]).optional().default("active"),
  /** Only the applications that need the user (review, missing answers, manual handoff, failed). */
  attention: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
});
export type ApplicationListQuery = z.infer<typeof applicationListQuerySchema>;

/** PUT /api/automation/providers/[providerId]/connection - token/API key for providers that offer one. */
export const providerConnectSchema = z
  .object({
    token: z.string().trim().min(4).max(4000),
    accountLabel: trimmedString(120).nullable().optional(),
    expiresAt: z.iso.datetime().nullable().optional(),
  })
  .strict();
export type ProviderConnectInput = z.infer<typeof providerConnectSchema>;

/** PATCH /api/profile/resume/[resumeId] - label a resume variant for automatic selection. */
export const resumeVariantSchema = z
  .object({
    label: trimmedString(80).nullable().optional(),
    targetRoles: stringList(10, 120).optional(),
  })
  .strict();
export type ResumeVariantInput = z.infer<typeof resumeVariantSchema>;

/** GET /api/automation/runs/[runId]/items - one page of a run's timeline, optionally narrowed to one stage, one outcome and a search. */
export const automationRunItemsQuerySchema = paginationQuerySchema.extend({
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(50),
  stage: z.string().trim().min(1).max(40).optional(),
  outcome: z.string().trim().min(1).max(40).optional(),
  /** Case-insensitive search in the step's message (which names the job and company). */
  q: z.string().trim().max(120).optional(),
});
export type AutomationRunItemsQuery = z.infer<typeof automationRunItemsQuerySchema>;
