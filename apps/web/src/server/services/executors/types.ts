import type { ExecutorKind, ManualActionReason, ProviderConnectionStatus } from "@applywise/types";
import type { JobProvider, ProviderEnv, ProviderJobRef, SubmissionPayload, SubmissionResult } from "@applywise/job-engine";

/**
 * ApplicationExecutor abstraction.
 *
 *  - API executors call a provider's submitApplication (the demo provider; the email executor sends the
 *    application email through packages/email).
 *  - The BROWSER executor drives Chromium via Playwright inside the worker (never the user's browser). It fills
 *    only mapped fields from the SubmissionPayload and stops on CAPTCHA / MFA / login walls / unknown required
 *    questions - it never tries to bypass them.
 *  - The MANUAL executor performs no submission: it produces the manual handoff.
 *
 * Executors are only ever invoked by applicationExecutionService.execute(), which holds the idempotency claim,
 * the daily-limit slot and the APPROVED -> APPLYING transition. Never call execute() from anywhere else.
 */

export interface ExecutorLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
}

export interface ExecutorContext {
  userId: string;
  applicationId: string;
  job: ProviderJobRef;
  provider: JobProvider;
  env: ProviderEnv;
  logger: ExecutorLogger;
  /** Aborts long-running browser sessions when the lease is about to expire. */
  signal?: AbortSignal;
}

export interface ApplicationExecutor {
  kind: ExecutorKind;
  /** e.g. "api:demo", "api:email", "browser:demo-ats", "browser:greenhouse", "manual" */
  id: string;
  label: string;
  /**
   * True when re-running after a crash cannot submit twice (the provider deduplicates on
   * payload.idempotencyKey). Otherwise an interrupted attempt becomes MANUAL_ACTION_REQUIRED/SUBMISSION_UNCERTAIN.
   */
  idempotentSubmission: boolean;
  execute(payload: SubmissionPayload, ctx: ExecutorContext): Promise<SubmissionResult>;
}

export interface ExecutorSelectionInput {
  job: ProviderJobRef;
  /** applicationProviderForJob(job) */
  provider: JobProvider;
  env: ProviderEnv;
  settings: { allowEmailApplications: boolean };
  /** The user's ProviderConnection for provider.id, if any. */
  connection: { status: ProviderConnectionStatus } | null;
  userEmailVerified: boolean;
  emailSendingConsent: boolean;
}

export type ExecutorSelection =
  | { automatic: true; executor: ApplicationExecutor }
  | { automatic: false; executor: ApplicationExecutor; reason: ManualActionReason; detail: string };
