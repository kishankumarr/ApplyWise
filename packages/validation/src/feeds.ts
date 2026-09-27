import { z } from "zod";
import { nonEmptyString, trimmedString } from "./common";

/** Automatic job sources ("feeds"). Credentials are only accepted on connect and never returned. */

export const feedSearchCreateSchema = z.object({
  provider: z.string().trim().min(1).max(40),
  keywords: nonEmptyString(120),
  location: trimmedString(120).nullable().optional().transform((v) => v || null),
  remoteOnly: z.boolean().default(false),
  maxDaysOld: z.number().int().min(1).max(30).default(7),
});
export type FeedSearchCreateInput = z.infer<typeof feedSearchCreateSchema>;

export const feedBoardFindSchema = z.object({
  /** A company name ("Razorpay") or a careers/job URL on a supported board. */
  query: nonEmptyString(300),
});

export const feedBoardCreateSchema = z.object({
  provider: z.string().trim().min(1).max(40),
  slug: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/, "Invalid board identifier"),
  companyName: trimmedString(120).nullable().optional().transform((v) => v || null),
  onlyRelevant: z.boolean().default(true),
});
export type FeedBoardCreateInput = z.infer<typeof feedBoardCreateSchema>;

export const feedImapConnectSchema = z.object({
  preset: z.string().trim().min(1).max(40),
  /** Only used with preset "custom" when the operator allows custom hosts. */
  host: trimmedString(253).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  email: z.email("Enter the email address of the mailbox").max(254),
  /** App password (not the account password). Encrypted at rest, never returned or logged. */
  appPassword: z.string().min(4, "Enter the app password").max(200),
  folder: trimmedString(120).optional(),
  /** Explicit consent to read job-alert emails from known job sites in this mailbox. */
  consent: z.literal(true, { error: "Confirm that ApplyWise may read job-alert emails in this mailbox" }),
});
export type FeedImapConnectInput = z.infer<typeof feedImapConnectSchema>;

export const feedUpdateSchema = z.object({
  paused: z.boolean().optional(),
  label: nonEmptyString(120).optional(),
  onlyRelevant: z.boolean().optional(),
  intervalMinutes: z.number().int().min(15).max(7 * 24 * 60).optional(),
});
export type FeedUpdateInput = z.infer<typeof feedUpdateSchema>;

export const jobViewPrefsSchema = z.object({
  /** null = automatic (hide demo jobs once real jobs exist). */
  showDemoJobs: z.boolean().nullable().optional(),
  /** Mark all current jobs as seen ("new" badges are cleared). */
  markSeen: z.boolean().optional(),
  /** Only jobs found up to this moment (the list's view.asOf) are marked seen. */
  asOf: z.iso.datetime({ offset: true }).optional(),
});
export type JobViewPrefsInput = z.infer<typeof jobViewPrefsSchema>;
