import { z } from "zod";
import { applicationStatusSchema, nonEmptyString, trimmedString } from "./common";

export const sourcedClaimSchema = z.object({
  text: z.string().min(1).max(2000),
  sourceFactIds: z.array(z.string().min(1)).max(20),
});

export const tailoredBulletChangeSchema = z.object({
  experienceId: z.string().nullable(),
  originalFactId: z.string().nullable(),
  original: z.string().nullable(),
  proposed: z.string().min(1).max(600),
  sourceFactIds: z.array(z.string().min(1)).min(1).max(10),
  rationale: z.string().max(500),
  confidence: z.enum(["high", "medium", "low"]),
});

export const tailoredResumePlanSchema = z.object({
  summary: sourcedClaimSchema,
  bulletChanges: z.array(tailoredBulletChangeSchema).max(30),
  selectedSkills: z
    .array(z.object({ name: z.string().min(1).max(80), sourceFactIds: z.array(z.string()) }))
    .max(40),
  sectionOrder: z
    .array(z.enum(["summary", "experience", "projects", "skills", "education", "achievements"]))
    .min(1)
    .max(6),
  orderingNotes: z.array(z.string().max(300)).max(10),
  warnings: z.array(z.string().max(300)).max(20),
});

/** PATCH /api/applications/[id] - user edits to generated drafts and tracking status. */
export const applicationUpdateSchema = z
  .object({
    status: applicationStatusSchema.optional(),
    notes: trimmedString(4000).nullable().optional(),
    tailoredSummary: trimmedString(2000).optional(),
    tailoredBullets: z
      .array(
        z.object({
          proposed: nonEmptyString(600),
          sourceFactIds: z.array(z.string()).max(10),
          accepted: z.boolean(),
        }),
      )
      .max(30)
      .optional(),
    coverLetter: trimmedString(8000).optional(),
    screeningAnswers: z
      .array(z.object({ id: z.string().min(1), answer: trimmedString(4000) }))
      .max(30)
      .optional(),
    reminderAt: z.iso.datetime().nullable().optional(),
  })
  .strict();
export type ApplicationUpdateInput = z.infer<typeof applicationUpdateSchema>;

/** User-settable tracking statuses (the rest are driven by explicit actions). */
export const MANUAL_TRACKING_STATUSES = [
  "SAVED",
  "INTERVIEW",
  "REJECTED",
  "OFFER",
  "WITHDRAWN",
  "EXPIRED",
] as const;

const emailList = z.array(z.email().max(320)).max(10);

/** POST /api/applications/[id]/email/preview - save the edited draft and get the exact preview. */
export const emailPreviewSchema = z.object({
  to: z.email().max(320),
  cc: emailList.optional().default([]),
  subject: nonEmptyString(300),
  body: z.string().trim().min(20).max(10_000),
  resumeVersionId: z.string().min(1).nullable().optional(),
  attachCoverLetter: z.boolean().optional().default(false),
});
export type EmailPreviewInput = z.infer<typeof emailPreviewSchema>;

/**
 * POST /api/applications/[id]/email/send
 * Requires the confirmation token issued by the preview endpoint (binds the exact content
 * the user reviewed) plus an explicit consent checkbox.
 */
export const emailSendSchema = z.object({
  confirmationToken: z.string().min(20).max(2000),
  userConfirmed: z.literal(true, { error: "Explicit confirmation is required to send" }),
  consentToSend: z.literal(true, { error: "Consent to send is required" }),
});
export type EmailSendInput = z.infer<typeof emailSendSchema>;

export const markSubmittedSchema = z.object({
  /** The user states they clicked the final submit themselves on the official page. */
  submittedByUser: z.literal(true),
  note: trimmedString(1000).optional(),
});

export const approveApplicationSchema = z.object({
  reviewedContent: z.literal(true, { error: "Please confirm you reviewed all generated content" }),
});
