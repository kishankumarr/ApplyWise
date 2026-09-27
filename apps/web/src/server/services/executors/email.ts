import "server-only";
import type { SubmissionPayload, SubmissionResult } from "@applywise/job-engine";
import { AppError } from "../../errors";
import { emailService, isDefinitelyNotSent } from "../email.service";
import type { ApplicationExecutor, ExecutorContext } from "./types";

/**
 * Email executor ("api:email"): sends the prepared ApplicationEmailDraft to the job's HR address through the same
 * email provider adapter as the manual send path (emailService.sendApplicationAutomatically re-checks the
 * EMAIL_SENDING consent, the verified sender address, the recipient, that the posting asks for email applications
 * to that address, a delivering email provider and the application state at send time).
 * Email cannot be deduplicated by the recipient, so an interrupted send is never retried blindly.
 */

export const emailExecutor: ApplicationExecutor = {
  kind: "API",
  id: "api:email",
  label: "Email application",
  idempotentSubmission: false,
  async execute(payload: SubmissionPayload, ctx: ExecutorContext): Promise<SubmissionResult> {
    try {
      const sent = await emailService.sendApplicationAutomatically(ctx.userId, ctx.applicationId, {
        fallbackResume: payload.resume,
        // The payload carries no cover letter when the user switched cover letters off: never attach one then.
        allowCoverLetter: payload.coverLetter !== null,
      });
      return {
        outcome: "SUBMITTED",
        externalApplicationId: null,
        confirmation: sent.captured ? `Email captured by ${sent.provider} (development - not delivered).` : `Email sent via ${sent.provider}.`,
      };
    } catch (e) {
      if (e instanceof AppError) {
        // The draft was already sent, or an earlier send was interrupted: it may be out - the user checks.
        if (e.code === "CONFLICT") return { outcome: "FAILED", retryable: false, error: e.message, submissionUncertain: true };
        const reason = e.code === "CONSENT_REQUIRED" || e.code === "EMAIL_NOT_VERIFIED" ? "AUTOMATION_NOT_SUPPORTED" : "UNSUPPORTED_FLOW";
        return { outcome: "MANUAL_ACTION_REQUIRED", reason, detail: e.message };
      }
      const code = (e as { code?: unknown }).code;
      const notSent = isDefinitelyNotSent(e);
      ctx.logger.warn("executor.email.send_failed", { code: typeof code === "string" ? code : null, notSent });
      return { outcome: "FAILED", retryable: notSent, error: notSent ? "The email server could not be reached." : "Sending the application email failed.", submissionUncertain: !notSent };
    }
  },
};
