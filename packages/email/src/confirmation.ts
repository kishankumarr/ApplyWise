import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { EmailAdapter, EmailSendResult, OutboundEmail } from "./types";

/**
 * Explicit send-confirmation guard.
 *
 * The preview endpoint issues a short-lived HMAC token bound to the exact content the
 * user reviewed (recipient, cc, subject, body, attachment names/hashes), the user and the
 * application. The only way to send is `sendConfirmedEmail`, which re-computes the digest
 * and refuses on any mismatch, expiry or missing consent. There is no unguarded send path.
 */

export const CONFIRMATION_TTL_MS = 15 * 60 * 1000;

export interface ConfirmationClaims {
  userId: string;
  applicationId: string;
  contentDigest: string;
  exp: number;
}

export class EmailConfirmationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmailConfirmationError";
  }
}

export function emailContentDigest(email: Pick<OutboundEmail, "to" | "cc" | "subject" | "text" | "attachments">): string {
  const h = createHash("sha256");
  h.update(email.to.toLowerCase());
  h.update("\u0000");
  h.update([...email.cc].map((c) => c.toLowerCase()).sort().join(","));
  h.update("\u0000");
  h.update(email.subject);
  h.update("\u0000");
  h.update(email.text);
  for (const a of email.attachments) {
    h.update("\u0000");
    h.update(a.filename);
    h.update(createHash("sha256").update(a.content).digest("hex"));
  }
  return h.digest("hex");
}

const b64url = (buf: Buffer | string) => Buffer.from(buf).toString("base64url");

export function createSendConfirmationToken(claims: Omit<ConfirmationClaims, "exp">, secret: string, now = Date.now()): string {
  if (!secret || secret.length < 32) throw new EmailConfirmationError("Confirmation secret must be at least 32 characters");
  const payload: ConfirmationClaims = { ...claims, exp: now + CONFIRMATION_TTL_MS };
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(createHmac("sha256", secret).update(`email-confirm.${body}`).digest());
  return `${body}.${sig}`;
}

export function verifySendConfirmationToken(token: string, secret: string, now = Date.now()): ConfirmationClaims {
  const [body, sig] = token.split(".");
  if (!body || !sig) throw new EmailConfirmationError("Malformed confirmation token");
  const expected = createHmac("sha256", secret).update(`email-confirm.${body}`).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new EmailConfirmationError("Invalid confirmation token");
  }
  const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as ConfirmationClaims;
  if (typeof claims.exp !== "number" || claims.exp < now) throw new EmailConfirmationError("Confirmation expired - please review the email again");
  return claims;
}

export interface SendConfirmation {
  token: string;
  userId: string;
  applicationId: string;
  userConfirmed: boolean;
  consentToSend: boolean;
}

/** The single, guarded send path. */
export async function sendConfirmedEmail(
  adapter: EmailAdapter,
  email: OutboundEmail,
  confirmation: SendConfirmation,
  secret: string,
): Promise<EmailSendResult> {
  if (confirmation.userConfirmed !== true) throw new EmailConfirmationError("Explicit user confirmation is required");
  if (confirmation.consentToSend !== true) throw new EmailConfirmationError("Consent to send is required");
  const claims = verifySendConfirmationToken(confirmation.token, secret);
  if (claims.userId !== confirmation.userId || claims.applicationId !== confirmation.applicationId) {
    throw new EmailConfirmationError("Confirmation does not belong to this application");
  }
  if (claims.contentDigest !== emailContentDigest(email)) {
    throw new EmailConfirmationError("The email changed after you reviewed it - please review it again");
  }
  return adapter.send(email);
}
