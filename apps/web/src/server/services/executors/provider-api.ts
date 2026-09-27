import type { JobProvider, SubmissionPayload, SubmissionResult } from "@applywise/job-engine";
import type { ApplicationExecutor, ExecutorContext } from "./types";

/**
 * Providers whose submitApplication deduplicates on payload.idempotencyKey, so re-running an interrupted
 * attempt can never create a second application. Every other provider is treated as non-idempotent: an
 * interrupted attempt becomes MANUAL_ACTION_REQUIRED / SUBMISSION_UNCERTAIN instead of being retried.
 */
const IDEMPOTENT_API_PROVIDERS = new Set(["demo"]);

export function isIdempotentApiProvider(providerId: string): boolean {
  return IDEMPOTENT_API_PROVIDERS.has(providerId);
}

/**
 * Generic API executor: hands the SubmissionPayload (verified data, approved documents, resolved answers and,
 * for connected providers, the decrypted credential for this call only) to the provider's submitApplication.
 * The provider maps its own responses to SubmissionResult (AUTH_FAILED, NEEDS_INFORMATION, ...).
 */
export function providerApiExecutor(provider: JobProvider, label: string): ApplicationExecutor {
  return {
    kind: "API",
    id: `api:${provider.id}`,
    label: `${label} API`,
    idempotentSubmission: isIdempotentApiProvider(provider.id),
    async execute(payload: SubmissionPayload, ctx: ExecutorContext): Promise<SubmissionResult> {
      if (!provider.submitApplication) {
        return { outcome: "MANUAL_ACTION_REQUIRED", reason: "AUTOMATION_NOT_SUPPORTED", detail: `${label} has no application API - apply on the official page.` };
      }
      return provider.submitApplication(payload, { env: ctx.env, ...(ctx.signal ? { signal: ctx.signal } : {}) });
    },
  };
}
