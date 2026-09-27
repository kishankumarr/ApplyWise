import "server-only";
import { prisma } from "@applywise/database";
import { createEmailAdapter, plainTextToHtml, type EmailDelivery } from "@applywise/email";
import { env } from "@/env";
import { audit } from "../audit";
import { signToken, verifyToken } from "../crypto";
import { Errors } from "../errors";
import { logger } from "../logger";
import { enqueue } from "../queue";

/**
 * Email-address verification. A user must confirm they own their account email before
 * ApplyWise sends any application email for them (it is also used as the reply-to address).
 *
 * The link carries a 24-hour HMAC token bound to the user id AND the email address, so it
 * stops working if the address changes. Opening the link only shows a page; the address is
 * confirmed by an explicit POST from that page (mail scanners that prefetch links cannot
 * confirm it). Verification is idempotent.
 */

export const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const PURPOSE = "verify-email";

interface VerifyClaims {
  userId: string;
  email: string;
}

export function verificationUrl(token: string): string {
  return `${env().APP_URL.replace(/\/$/, "")}/verify-email?token=${encodeURIComponent(token)}`;
}

/** How confirmation links reach users with the current email configuration (drives the UI copy). */
export function verificationDeliveryInfo(): { delivery: EmailDelivery; devLinkAvailable: boolean } {
  const delivery = createEmailAdapter(env()).delivery;
  return { delivery, devLinkAvailable: env().NODE_ENV !== "production" && delivery !== "external" };
}

function checkToken(token: string): VerifyClaims {
  try {
    return verifyToken<VerifyClaims>(PURPOSE, token);
  } catch {
    throw Errors.validation("This verification link is invalid or has expired. Request a new one from Settings.");
  }
}

export const emailVerificationService = {
  async status(userId: string) {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, emailVerifiedAt: true } });
    if (!user) throw Errors.unauthenticated();
    return { email: user.email, verified: !!user.emailVerifiedAt, verifiedAt: user.emailVerifiedAt };
  },

  async isVerified(userId: string): Promise<boolean> {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { emailVerifiedAt: true } });
    return !!user?.emailVerifiedAt;
  },

  async require(userId: string): Promise<{ email: string }> {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, emailVerifiedAt: true } });
    if (!user) throw Errors.unauthenticated();
    if (!user.emailVerifiedAt) throw Errors.emailNotVerified();
    return { email: user.email };
  },

  /** Sign-up: send the first link in the background so a slow mail server never delays account creation. */
  async queueInitial(userId: string, requestId?: string): Promise<void> {
    await enqueue("email.verification", { requestId: requestId ?? null }, { userId });
  },

  /**
   * Send (or re-send) the verification link. In development, when the configured email
   * adapter cannot deliver real mail, the link is also returned so it can be opened directly.
   */
  async send(
    userId: string,
    requestId?: string,
  ): Promise<{ sent: boolean; alreadyVerified: boolean; delivery: EmailDelivery; devVerificationUrl?: string }> {
    const adapter = createEmailAdapter(env());
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, emailVerifiedAt: true } });
    if (!user) throw Errors.unauthenticated();
    if (user.emailVerifiedAt) return { sent: false, alreadyVerified: true, delivery: adapter.delivery };
    const token = signToken<VerifyClaims>(PURPOSE, { userId, email: user.email }, VERIFY_TTL_MS);
    const url = verificationUrl(token);
    const appName = process.env.NEXT_PUBLIC_APP_NAME ?? "ApplyWise";
    // No name or other profile data: the message only needs the address being confirmed.
    const text = [
      "Hello,",
      `Please confirm that ${user.email} is your email address by opening this link and pressing "Confirm" (valid for 24 hours):`,
      url,
      `You need to confirm your address before ${appName} can send job-application emails on your behalf.`,
      "If you did not create this account, you can ignore this email.",
    ].join("\n\n");
    try {
      // System email to the account holder's own address (not an application email).
      await adapter.send({
        from: env().EMAIL_FROM,
        replyTo: null,
        to: user.email,
        cc: [],
        subject: `Confirm your email address for ${appName}`,
        text,
        html: plainTextToHtml(text),
        attachments: [],
      });
    } catch (e) {
      logger.error("email_verification.send_failed", { requestId, userId, error: e instanceof Error ? e.name : "unknown" });
      throw Errors.providerNotConfigured("The verification email could not be sent. Check the email provider settings.");
    }
    await audit(userId, "auth.verification_sent", { requestId, metadata: { delivery: adapter.delivery } });
    const devVerificationUrl = env().NODE_ENV !== "production" && adapter.delivery !== "external" ? url : undefined;
    return { sent: true, alreadyVerified: false, delivery: adapter.delivery, ...(devVerificationUrl ? { devVerificationUrl } : {}) };
  },

  /** Read-only check used to render the confirmation page (no state change on GET). */
  async inspect(token: string): Promise<{ email: string; alreadyVerified: boolean }> {
    const claims = checkToken(token);
    const user = await prisma.user.findUnique({ where: { id: claims.userId }, select: { email: true, emailVerifiedAt: true } });
    if (!user || user.email.toLowerCase() !== claims.email.toLowerCase()) {
      throw Errors.validation("This verification link is no longer valid for this account.");
    }
    return { email: user.email, alreadyVerified: !!user.emailVerifiedAt };
  },

  async verify(token: string, requestId?: string): Promise<{ email: string }> {
    const claims = checkToken(token);
    const user = await prisma.user.findUnique({ where: { id: claims.userId }, select: { email: true, emailVerifiedAt: true } });
    // The link is bound to the address it was sent to.
    if (!user || user.email.toLowerCase() !== claims.email.toLowerCase()) {
      throw Errors.validation("This verification link is no longer valid for this account.");
    }
    if (!user.emailVerifiedAt) {
      await prisma.user.update({ where: { id: claims.userId }, data: { emailVerifiedAt: new Date() } });
      await audit(claims.userId, "auth.email_verified", { requestId });
    }
    return { email: user.email };
  },
};
