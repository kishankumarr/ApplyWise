import { ERROR_CODES, type ErrorCode } from "@applywise/types";

/** Errors with a safe, user-facing message. Never put PII in the message. */
export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly status: number,
    readonly fieldErrors?: Record<string, string[]>,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const Errors = {
  validation: (message = "Some fields are invalid.", fieldErrors?: Record<string, string[]>) =>
    new AppError(ERROR_CODES.VALIDATION, message, 422, fieldErrors),
  unauthenticated: () => new AppError(ERROR_CODES.UNAUTHENTICATED, "Please sign in to continue.", 401),
  forbidden: (message = "You do not have access to this resource.") => new AppError(ERROR_CODES.FORBIDDEN, message, 403),
  notFound: (what = "Resource") => new AppError(ERROR_CODES.NOT_FOUND, `${what} not found.`, 404),
  conflict: (message: string) => new AppError(ERROR_CODES.CONFLICT, message, 409),
  rateLimited: (retryAfterSec: number) => new AppError(ERROR_CODES.RATE_LIMITED, `Too many requests. Try again in ${retryAfterSec}s.`, 429),
  consentRequired: (what: string) => new AppError(ERROR_CODES.CONSENT_REQUIRED, `Consent required: ${what}. Update it in Settings → Privacy.`, 403),
  emailNotVerified: () =>
    new AppError(ERROR_CODES.EMAIL_NOT_VERIFIED, "Confirm your email address first. We sent you a verification link - you can resend it from the banner or Settings.", 403),
  confirmationRequired: (message: string) => new AppError(ERROR_CODES.CONFIRMATION_REQUIRED, message, 409),
  invalidState: (message: string) => new AppError(ERROR_CODES.INVALID_STATE, message, 409),
  unsupportedFile: (message: string) => new AppError(ERROR_CODES.UNSUPPORTED_FILE, message, 415),
  providerNotConfigured: (message: string) => new AppError(ERROR_CODES.PROVIDER_NOT_CONFIGURED, message, 501),
  /** An external API (job board, search provider) is temporarily unavailable; safe to retry. */
  providerUnavailable: (message: string) => new AppError(ERROR_CODES.PROVIDER_UNAVAILABLE, message, 503),
};
