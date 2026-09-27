import "server-only";
import { prisma } from "@applywise/database";
import {
  buildMailtoUrl,
  CONFIRMATION_TTL_MS,
  createEmailAdapter,
  createSendConfirmationToken,
  emailContentDigest,
  EmailConfirmationError,
  plainTextToHtml,
  sendConfirmedEmail,
  verifySendConfirmationToken,
  type OutboundEmail,
} from "@applywise/email";
import { emailApplicationRequested } from "@applywise/job-engine";
import { renderResumePdf, type ResumeDocument } from "@applywise/resume-engine";
import type { EmailPreviewInput, EmailSendInput } from "@applywise/validation";
import { env } from "@/env";
import { audit } from "../audit";
import { AppError, Errors } from "../errors";
import { logger } from "../logger";
import { enqueue } from "../queue";
import { recordApplicationEvent, transitionApplication } from "./application-transitions";
import { consentService } from "./consent.service";
import { emailVerificationService, verificationDeliveryInfo } from "./email-verification.service";

/**
 * Email applications. The user's send path: preview (issues a confirmation token bound to the exact
 * content) -> explicit confirmation + consent -> sendConfirmedEmail. The client never sends email directly.
 *
 * The automation's send path (sendApplicationAutomatically) is used only by the email executor, which runs only
 * inside applicationExecutionService.execute for an application the user approved (REVIEW) or the AUTO policy
 * approved under the AUTO_APPLY consent. It re-checks the EMAIL_SENDING consent, the verified sender address, that
 * the posting asks for email applications to that address and (in production) that mail is really delivered at
 * send time, and uses the same provider adapter.
 *
 * Exactly-once: preview moves APPROVED -> EMAIL_DRAFT_READY with a compare-and-set before it touches the draft (the
 * automation can then no longer start, and a started automation makes the preview fail), a SENT draft is never
 * rewritten or sent again, and a user send consumes its confirmed preview (a double click or a re-delivered task
 * sends nothing the second time).
 */

function adapter() {
  return createEmailAdapter(env());
}

/** Mail-transport errors raised before any byte of the message reached the mail server. */
const NOT_SENT_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EAUTH", "ECONNECTION", "EDNS", "ETLS"]);

/** True only when the error proves the message was not handed to the mail server (safe to send again). */
export function isDefinitelyNotSent(e: unknown): boolean {
  const code = typeof e === "object" && e !== null ? (e as { code?: unknown }).code : undefined;
  return typeof code === "string" && NOT_SENT_CODES.has(code);
}

const ALREADY_SENT = "This application email was already sent.";

export function emailProviderInfo() {
  const a = adapter();
  return {
    name: a.name,
    deliversExternally: a.deliversExternally,
    label: a.deliversExternally ? `Sends real email via ${a.name}` : a.name === "dev-outbox" ? "Development outbox - no real email is sent" : `${a.name} (captured, not delivered)`,
  };
}

/** Resume attached by the automated path when the draft names no resume version (already a rendered PDF). */
export interface AutomatedResumeAttachment {
  fileName: string;
  mimeType: string;
  content: Uint8Array;
}

interface OutboundOptions {
  fallbackResume?: AutomatedResumeAttachment | null;
  /** Automated path: never attach a resume version nobody approved (the raw CV parse); use the approved fallback. */
  approvedResumeOnly?: boolean;
  /** false = never attach the cover letter (the user switched cover letters off for automated applications). */
  allowCoverLetter?: boolean;
}

async function buildOutbound(userId: string, applicationId: string, opts: OutboundOptions = {}): Promise<OutboundEmail> {
  const draft = await prisma.applicationEmailDraft.findFirst({ where: { applicationId, userId } });
  if (!draft) throw Errors.invalidState("There is no email draft for this application.");
  // Replies go to the account address, and only once the user has confirmed they own it.
  const account = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, emailVerifiedAt: true } });
  const attachments: OutboundEmail["attachments"] = [];
  const attachFallback = (file: AutomatedResumeAttachment) => attachments.push({ filename: file.fileName, contentType: file.mimeType, content: Buffer.from(file.content) });
  if (draft.resumeVersionId) {
    const version = await prisma.resumeVersion.findFirst({ where: { id: draft.resumeVersionId, userId } });
    if (!version) throw Errors.invalidState("The selected resume version no longer exists.");
    if (opts.approvedResumeOnly && !version.approvedAt) {
      if (!opts.fallbackResume) throw Errors.invalidState("The email draft attaches a resume version nobody approved - review and send it yourself.");
      attachFallback(opts.fallbackResume);
    } else {
      const doc = version.content as unknown as ResumeDocument;
      // Fixed creation date => byte-identical PDF between preview and send.
      const pdf = await renderResumePdf(doc, { creationDate: version.createdAt });
      attachments.push({ filename: `${(doc.contact.fullName || "resume").replace(/[^\w]+/g, "_")}_Resume.pdf`, contentType: "application/pdf", content: pdf });
    }
  } else if (opts.fallbackResume) {
    attachFallback(opts.fallbackResume);
  }
  if (draft.attachCoverLetter && opts.allowCoverLetter !== false) {
    const cover = await prisma.coverLetter.findFirst({ where: { applicationId, userId } });
    if (cover) attachments.push({ filename: "Cover_Letter.txt", contentType: "text/plain; charset=utf-8", content: Buffer.from(cover.body, "utf8") });
  }
  return {
    from: env().EMAIL_FROM,
    replyTo: account?.emailVerifiedAt ? account.email : null,
    to: draft.to,
    cc: draft.cc,
    subject: draft.subject,
    text: draft.body,
    html: plainTextToHtml(draft.body),
    attachments,
  };
}

export const emailService = {
  providerInfo: emailProviderInfo,

  /** Save the user's edits and return the exact final preview plus a confirmation token. */
  async preview(userId: string, applicationId: string, input: EmailPreviewInput, requestId?: string) {
    const app = await prisma.application.findFirst({ where: { id: applicationId, userId }, include: { job: { select: { hrEmail: true } } } });
    if (!app) throw Errors.notFound("Application");
    if (app.status !== "APPROVED" && app.status !== "EMAIL_DRAFT_READY") {
      throw Errors.invalidState("Approve the application content before previewing the final email.");
    }
    if (input.resumeVersionId) {
      const v = await prisma.resumeVersion.findFirst({ where: { id: input.resumeVersionId, userId }, select: { id: true, approvedAt: true } });
      if (!v?.approvedAt) throw Errors.validation("Choose an approved resume version to attach.");
    }
    const existing = await prisma.applicationEmailDraft.findFirst({ where: { applicationId, userId } });
    if (existing?.status === "SENT" || app.emailSentAt) throw Errors.conflict(ALREADY_SENT);
    const defaultVersion = await prisma.resumeVersion.findFirst({ where: { userId, applicationId, kind: "TAILORED", approvedAt: { not: null } }, orderBy: { createdAt: "desc" } });
    const data = {
      to: input.to,
      cc: input.cc,
      subject: input.subject,
      body: input.body,
      attachCoverLetter: input.attachCoverLetter,
      resumeVersionId: input.resumeVersionId ?? existing?.resumeVersionId ?? defaultVersion?.id ?? null,
    };
    await prisma.$transaction(async (tx) => {
      if (app.status === "APPROVED") {
        // Compare-and-set BEFORE the draft changes: if the automation already moved the application to APPLYING this
        // throws and nothing is written; once EMAIL_DRAFT_READY, the automation can no longer start (from APPROVED only).
        await transitionApplication(userId, applicationId, "email_preview", { tx, from: ["APPROVED"], message: "Email draft is ready for your final review." });
      } else if ((await tx.application.count({ where: { id: applicationId, userId, status: "EMAIL_DRAFT_READY" } })) === 0) {
        throw Errors.invalidState("The application changed - reload it before previewing the email.");
      }
      if (existing) {
        // Never rewrite an email that was already sent.
        const res = await tx.applicationEmailDraft.updateMany({ where: { id: existing.id, status: { not: "SENT" } }, data });
        if (res.count === 0) throw Errors.conflict(ALREADY_SENT);
      } else {
        await tx.applicationEmailDraft.create({ data: { ...data, userId, applicationId, originalBody: input.body, provider: "user", promptVersion: "manual" } });
      }
    });

    const outbound = await buildOutbound(userId, applicationId);
    const digest = emailContentDigest(outbound);
    const token = createSendConfirmationToken({ userId, applicationId, contentDigest: digest }, env().SIGNING_SECRET);
    const previewed = await prisma.applicationEmailDraft.updateMany({
      where: { applicationId, userId, status: { not: "SENT" } },
      data: { status: "PREVIEWED", previewDigest: digest, previewedAt: new Date() },
    });
    if (previewed.count === 0) throw Errors.conflict(ALREADY_SENT);
    await audit(userId, "email.previewed", { requestId, entityType: "Application", entityId: applicationId, metadata: { attachments: outbound.attachments.length } });
    const consents = await consentService.get(userId);
    const verification = await emailVerificationService.status(userId);
    const provider = emailProviderInfo();
    return {
      from: outbound.from,
      replyTo: outbound.replyTo,
      to: outbound.to,
      cc: outbound.cc,
      subject: outbound.subject,
      body: outbound.text,
      attachments: outbound.attachments.map((a) => ({ filename: a.filename, contentType: a.contentType, sizeBytes: a.content.length })),
      mailtoUrl: buildMailtoUrl({ to: outbound.to, cc: outbound.cc, subject: outbound.subject, body: outbound.text }),
      confirmationToken: token,
      expiresAt: new Date(Date.now() + CONFIRMATION_TTL_MS).toISOString(),
      provider,
      emailSendingConsent: consents.emailSending,
      senderEmail: verification.email,
      senderVerified: verification.verified,
      senderVerification: verificationDeliveryInfo(),
      canSendFromApp: consents.emailSending && verification.verified,
      recipientMatchesJob: !!app.job.hrEmail && app.job.hrEmail.toLowerCase() === outbound.to.toLowerCase(),
    };
  },

  /** Verifies the confirmation synchronously, then queues the actual send. */
  async requestSend(userId: string, applicationId: string, input: EmailSendInput, requestId?: string) {
    await emailVerificationService.require(userId);
    await consentService.require(userId, "emailSending");
    const app = await prisma.application.findFirst({ where: { id: applicationId, userId }, select: { status: true, emailSentAt: true, appliedAt: true } });
    if (!app) throw Errors.notFound("Application");
    if (app.emailSentAt || app.appliedAt) throw Errors.conflict(ALREADY_SENT);
    if (app.status !== "EMAIL_DRAFT_READY") throw Errors.invalidState("Preview the email and confirm before sending.");
    try {
      const claims = verifySendConfirmationToken(input.confirmationToken, env().SIGNING_SECRET);
      if (claims.userId !== userId || claims.applicationId !== applicationId) throw new EmailConfirmationError("Confirmation does not belong to this application");
      const draft = await prisma.applicationEmailDraft.findFirst({ where: { applicationId, userId } });
      if (draft?.status === "SENT") throw Errors.conflict(ALREADY_SENT);
      if (!draft || draft.previewDigest !== claims.contentDigest) throw new EmailConfirmationError("The email changed after you reviewed it - please review it again");
    } catch (e) {
      if (e instanceof EmailConfirmationError) throw Errors.confirmationRequired(e.message);
      throw e;
    }
    const { taskId } = await enqueue("email.send", { applicationId, token: input.confirmationToken, requestId }, { userId });
    return { queued: true, taskId };
  },

  /** Background task: the only place a user-confirmed application email is sent (automation: sendApplicationAutomatically). */
  async runSend(userId: string, applicationId: string, token: string, requestId?: string) {
    // Re-checked at send time (defence in depth for queued sends).
    await emailVerificationService.require(userId);
    await consentService.require(userId, "emailSending");
    let contentDigest: string;
    try {
      const claims = verifySendConfirmationToken(token, env().SIGNING_SECRET);
      if (claims.userId !== userId || claims.applicationId !== applicationId) throw new EmailConfirmationError("Confirmation does not belong to this application");
      contentDigest = claims.contentDigest;
    } catch (e) {
      if (e instanceof EmailConfirmationError) throw Errors.confirmationRequired(e.message);
      throw e;
    }
    const app = await prisma.application.findFirst({ where: { id: applicationId, userId }, select: { status: true, emailSentAt: true } });
    if (!app) throw Errors.notFound("Application");
    const draft = await prisma.applicationEmailDraft.findFirst({ where: { applicationId, userId }, select: { status: true, previewDigest: true } });
    if (draft?.status === "SENT" || app.emailSentAt) {
      // A duplicate task (double click, re-delivery): the email went out once already.
      logger.info("email.send_skipped", { applicationId, reason: "already_sent" });
      return;
    }
    if (app.status !== "EMAIL_DRAFT_READY") throw Errors.invalidState("Preview the email and confirm before sending.");
    if (draft?.status === "PREVIEWED" && draft.previewDigest === null) {
      // Another task consumed this confirmation (it is sending, or its send ended uncertain): never send it twice.
      logger.info("email.send_skipped", { applicationId, reason: "confirmation_consumed" });
      return;
    }
    if (!draft || draft.previewDigest !== contentDigest) throw Errors.confirmationRequired("The email changed after you reviewed it - please review it again");
    // Consume the confirmed preview: exactly one send per confirmation, whatever the number of tasks.
    const claimed = await prisma.applicationEmailDraft.updateMany({ where: { applicationId, userId, status: "PREVIEWED", previewDigest: contentDigest }, data: { previewDigest: null } });
    if (claimed.count === 0) {
      logger.info("email.send_skipped", { applicationId, reason: "confirmation_consumed" });
      return;
    }
    const restoreConfirmation = () =>
      prisma.applicationEmailDraft.updateMany({ where: { applicationId, userId, status: { not: "SENT" }, previewDigest: null }, data: { previewDigest: contentDigest } });
    let outbound: OutboundEmail;
    let result: Awaited<ReturnType<typeof sendConfirmedEmail>>;
    try {
      outbound = await buildOutbound(userId, applicationId);
      result = await sendConfirmedEmail(adapter(), outbound, { token, userId, applicationId, userConfirmed: true, consentToSend: true }, env().SIGNING_SECRET);
    } catch (e) {
      // Definitely not sent: the same confirmation may be used again. Otherwise the user re-previews and confirms.
      if (e instanceof EmailConfirmationError || e instanceof AppError || isDefinitelyNotSent(e)) await restoreConfirmation();
      if (e instanceof EmailConfirmationError) throw Errors.confirmationRequired(e.message);
      throw e;
    }
    const sentAt = new Date();
    const message = result.captured ? `Email captured by ${result.provider} (development - not delivered).` : `Email sent via ${result.provider}.`;
    const metadata = { provider: result.provider, captured: result.captured };
    await prisma.$transaction(async (tx) => {
      await tx.applicationEmailDraft.update({ where: { applicationId }, data: { status: "SENT", sentAt, sendProvider: result.provider, sendMessageId: result.messageId } });
      try {
        await transitionApplication(userId, applicationId, "email_sent", { tx, from: ["EMAIL_DRAFT_READY"], message, data: { emailSentAt: sentAt }, metadata });
      } catch (e) {
        if (!(e instanceof AppError)) throw e;
        // The application moved meanwhile: the email did go out - keep that fact on record.
        await tx.application.updateMany({ where: { id: applicationId, userId }, data: { emailSentAt: sentAt } });
        await recordApplicationEvent(userId, applicationId, "email_sent", message, { tx, actor: "user", metadata: { ...metadata, outOfBand: true } });
      }
    });
    await audit(userId, "email.sent", { requestId, entityType: "Application", entityId: applicationId, metadata: { provider: result.provider, captured: result.captured, attachments: outbound.attachments.length } });
  },

  /**
   * Automation send path. Called only by the email executor (services/executors/email.ts), i.e. only inside
   * applicationExecutionService.execute while it holds the idempotency claim and the application is APPLYING -
   * never from a route. Re-checks consent, the verified sender, the mode, the recipient and that the posting asks
   * for email applications to that address at send time; refuses a non-delivering email provider in production;
   * sends the prepared draft (with an approved resume PDF and, like the manual flow, the cover letter when the draft
   * attaches it and cover letters are on) through the configured adapter and marks the draft SENT. The execution
   * service records APPLIED.
   */
  async sendApplicationAutomatically(
    userId: string,
    applicationId: string,
    opts: { fallbackResume?: AutomatedResumeAttachment | null; allowCoverLetter?: boolean; requestId?: string } = {},
  ): Promise<{ provider: string; messageId: string; captured: boolean }> {
    await emailVerificationService.require(userId);
    await consentService.require(userId, "emailSending");
    const app = await prisma.application.findFirst({
      where: { id: applicationId, userId },
      select: { status: true, mode: true, emailSentAt: true, job: { select: { hrEmail: true, description: true, applicationInstructions: true } } },
    });
    if (!app) throw Errors.notFound("Application");
    if (app.status !== "APPLYING" || (app.mode !== "REVIEW" && app.mode !== "AUTO")) {
      throw Errors.invalidState("Automatic email applications are only sent for approved Review/Auto applications.");
    }
    const draft = await prisma.applicationEmailDraft.findFirst({ where: { applicationId, userId }, select: { to: true, status: true } });
    if (!draft) throw Errors.invalidState("No application email was prepared for this job.");
    if (draft.status === "SENT" || app.emailSentAt) throw Errors.conflict(ALREADY_SENT);
    const hrEmail = app.job.hrEmail?.trim().toLowerCase();
    if (!hrEmail || draft.to.trim().toLowerCase() !== hrEmail) {
      throw Errors.invalidState("The email draft is not addressed to the job's HR contact - review and send it yourself.");
    }
    // job.hrEmail may be any address found in the text (a fraud-report or newsletter address): only send when the
    // posting itself asks for applications by email to exactly this address.
    if (!emailApplicationRequested(app.job.description, app.job.applicationInstructions, hrEmail)) {
      throw Errors.invalidState(`The job post does not clearly ask for email applications to ${hrEmail} - review and send it yourself.`);
    }
    const mailer = adapter();
    if (!mailer.deliversExternally && env().NODE_ENV === "production") {
      throw Errors.providerNotConfigured("No email provider that delivers mail is configured - the application email would never reach the employer.");
    }
    const outbound = await buildOutbound(userId, applicationId, { fallbackResume: opts.fallbackResume ?? null, approvedResumeOnly: true, allowCoverLetter: opts.allowCoverLetter !== false });
    const result = await mailer.send(outbound);
    const sentAt = new Date();
    await prisma.$transaction([
      prisma.applicationEmailDraft.update({ where: { applicationId }, data: { status: "SENT", sentAt, sendProvider: result.provider, sendMessageId: result.messageId } }),
      prisma.application.updateMany({ where: { id: applicationId, userId }, data: { emailSentAt: sentAt } }),
    ]);
    await audit(userId, "email.sent", {
      requestId: opts.requestId,
      entityType: "Application",
      entityId: applicationId,
      metadata: { provider: result.provider, captured: result.captured, attachments: outbound.attachments.length, automated: true },
    });
    return { provider: result.provider, messageId: result.messageId, captured: result.captured };
  },
};
