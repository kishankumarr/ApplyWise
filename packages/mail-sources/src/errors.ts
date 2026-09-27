/**
 * The user has to act: wrong or revoked app password, IMAP turned off, revoked or expired OAuth grant,
 * missing permission. The message is user-facing and never contains credentials or email content.
 */
export class MailAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailAuthError";
  }
}

/** Network failure, timeout or a busy server; retry later. The message is safe to show. */
export class MailTransientError extends Error {
  constructor(
    message: string,
    /** Provider-suggested wait (Retry-After), when given. */
    readonly retryAfterSec: number | null = null,
    /** Safe machine code such as "ETIMEOUT" or "429" (never a server response text). */
    readonly code?: string,
  ) {
    super(message);
    this.name = "MailTransientError";
  }
}
