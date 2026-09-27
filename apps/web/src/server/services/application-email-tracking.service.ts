import "server-only";
import { prisma, type ApplicationMessageCategory, type ApplicationStatus } from "@applywise/database";
import {
  associateStatusEmail,
  classifyStatusEmail,
  STATUS_EMAIL_CLASSIFIER_VERSION,
  STATUS_EMAIL_MIN_CONFIDENCE,
  statusForMessageCategory,
  unwrapForwardedStatusEmail,
} from "@applywise/job-engine";
import type { StatusEmailApplicationRef } from "@applywise/types";
import { audit } from "../audit";
import { sha256Hex } from "../crypto";
import { canTransition } from "../domain/application-state";
import { AppError } from "../errors";
import { logger } from "../logger";
import { recordApplicationEvent, transitionApplication } from "./application-transitions";
import { notificationService, type NotificationType } from "./notification.service";

/**
 * Application-status email tracking.
 *
 * Classifies employer emails (confirmation, recruiter response, assessment, interview, rejection, offer) with the
 * deterministic classifier in packages/job-engine/src/automation/email-status.ts, associates them with one of the
 * user's sent applications when confident, stores metadata only (ApplicationMessage: message-id hash, sender
 * domain, truncated subject - never the body or the full address) and moves the application (status_update,
 * actor "system"). Never replies to or sends any email.
 */

export interface StatusMessageInput {
  /** Provider message id (hashed before storage). */
  messageId: string;
  from: string;
  subject: string;
  /** Plain text, processed in memory only (never stored or logged). */
  text: string;
  receivedAt: Date;
}

export interface StatusIngestResult {
  stored: boolean;
  duplicate: boolean;
  category: string;
  applicationId: string | null;
  statusApplied: string | null;
}

/** Applications an employer email can be about: sent, or already in an employer-driven step. */
const TRACKED_STATUSES: ApplicationStatus[] = ["APPLIED", "SUBMITTED", "EMAIL_SENT", "ASSESSMENT", "INTERVIEW"];
const MAX_CANDIDATES = 500;
const SUBJECT_MAX = 200;

const CATEGORY_LABELS: Record<ApplicationMessageCategory, string> = {
  APPLICATION_CONFIRMATION: "application confirmation",
  RECRUITER_RESPONSE: "recruiter response",
  ASSESSMENT: "assessment",
  INTERVIEW: "interview",
  REJECTION: "rejection",
  OFFER: "offer",
  OTHER: "other",
};

const STATUS_LABELS: Partial<Record<ApplicationStatus, string>> = {
  ASSESSMENT: "Assessment",
  INTERVIEW: "Interview",
  REJECTED: "Rejected",
  OFFER: "Offer",
};

/** In-app notification per detected category (the application confirmation is recorded on the timeline only). */
const CATEGORY_NOTICES: Partial<Record<ApplicationMessageCategory, { type: NotificationType; title: string; detected: string }>> = {
  RECRUITER_RESPONSE: { type: "application.recruiter_response", title: "Recruiter reply", detected: "a reply from a recruiter" },
  ASSESSMENT: { type: "application.assessment", title: "Assessment invitation", detected: "an assessment invitation" },
  INTERVIEW: { type: "application.interview", title: "Interview request", detected: "an interview request" },
  OFFER: { type: "application.offer", title: "Offer received", detected: "a job offer" },
  REJECTION: { type: "application.rejected", title: "Application update", detected: "a rejection" },
};

/** Notification for an employer-driven status (used by the provider status sync too). */
const STATUS_NOTICES: Partial<Record<ApplicationStatus, { type: NotificationType; title: string }>> = {
  ASSESSMENT: { type: "application.assessment", title: "Assessment invitation" },
  INTERVIEW: { type: "application.interview", title: "Interview request" },
  OFFER: { type: "application.offer", title: "Offer received" },
  REJECTED: { type: "application.rejected", title: "Application update" },
};

export function messageHashFor(message: Pick<StatusMessageInput, "messageId" | "from" | "subject" | "receivedAt">): string {
  const id = message.messageId.trim() || `${message.from}\n${message.subject}\n${validDate(message.receivedAt).toISOString()}`;
  return sha256Hex(id);
}

function validDate(d: Date): Date {
  return d instanceof Date && !Number.isNaN(d.getTime()) ? d : new Date();
}

function sentAtOf(app: { appliedAt: Date | null; submittedAt: Date | null; emailSentAt: Date | null }): Date | null {
  return app.appliedAt ?? app.submittedAt ?? app.emailSentAt;
}

/**
 * Tell the user about an employer-driven status change detected for an application (provider status sync).
 * Idempotent through the dedupe key.
 */
export async function notifyApplicationStatus(
  userId: string,
  app: { id: string; title: string; company: string },
  status: ApplicationStatus,
  opts: { dedupeKey: string; via: string },
): Promise<void> {
  const notice = STATUS_NOTICES[status];
  if (!notice) return;
  await notificationService.notify(userId, {
    type: notice.type,
    title: `${notice.title}: ${app.title} at ${app.company}`,
    body: `${opts.via} reports a new status for this application. It was moved to ${STATUS_LABELS[status] ?? status.toLowerCase()}.`,
    link: `/applications/${app.id}`,
    dedupeKey: opts.dedupeKey,
  });
}

export const applicationEmailTrackingService = {
  async ingest(userId: string, message: StatusMessageInput, source: "inbound" | "mailbox" | "demo"): Promise<StatusIngestResult> {
    const messageHash = messageHashFor(message);
    const existing = await prisma.applicationMessage.findUnique({ where: { userId_messageHash: { userId, messageHash } }, select: { category: true, applicationId: true } });
    if (existing) return { stored: false, duplicate: true, category: existing.category, applicationId: existing.applicationId, statusApplied: null };

    const receivedAt = validDate(message.receivedAt);
    // A hand-forwarded email carries the employer's message below its "Forwarded message" header block.
    const input = unwrapForwardedStatusEmail({ from: message.from, subject: message.subject, text: message.text, receivedAt: receivedAt.toISOString() });
    const classification = classifyStatusEmail(input);

    const apps = await prisma.application.findMany({
      where: { userId, status: { in: TRACKED_STATUSES } },
      select: { id: true, status: true, appliedAt: true, submittedAt: true, emailSentAt: true, job: { select: { title: true, company: true, companyWebsite: true } } },
      orderBy: { updatedAt: "desc" },
      take: MAX_CANDIDATES,
    });
    const refs: StatusEmailApplicationRef[] = apps.map((a) => ({
      applicationId: a.id,
      company: a.job.company,
      title: a.job.title,
      companyWebsite: a.job.companyWebsite,
      sentAt: sentAtOf(a)?.toISOString() ?? null,
    }));
    const association = associateStatusEmail(classification, input, refs);
    const app = association.applicationId ? (apps.find((a) => a.id === association.applicationId) ?? null) : null;

    const category = classification.category;
    const confident = classification.confidence >= STATUS_EMAIL_MIN_CONFIDENCE;
    const target = statusForMessageCategory(category);
    const label = CATEGORY_LABELS[category];
    const eventMetadata = {
      category,
      confidence: classification.confidence,
      associationConfidence: association.confidence,
      associatedBy: association.associatedBy,
      classifier: STATUS_EMAIL_CLASSIFIER_VERSION,
      source,
    };

    let stored: { id: string; statusApplied: ApplicationStatus | null };
    try {
      stored = await prisma.$transaction(async (tx) => {
        const row = await tx.applicationMessage.create({
          data: {
            userId,
            applicationId: app?.id ?? null,
            category,
            confidence: classification.confidence,
            messageHash,
            fromDomain: classification.fromDomain,
            subject: input.subject.replace(/\s+/g, " ").trim().slice(0, SUBJECT_MAX),
            receivedAt,
            associatedBy: app ? association.associatedBy : null,
            source,
          },
          select: { id: true },
        });
        if (!app) return { id: row.id, statusApplied: null };
        let applied: ApplicationStatus | null = null;
        if (confident && target && canTransition(app.status, "status_update", target)) {
          try {
            applied = await transitionApplication(userId, app.id, "status_update", {
              to: target,
              from: [app.status],
              actor: "system",
              message: `Detected from an email: ${label}`,
              metadata: { ...eventMetadata, applicationMessageId: row.id },
              tx,
            });
            await tx.applicationMessage.update({ where: { id: row.id }, data: { statusApplied: true } });
          } catch (e) {
            // The status changed meanwhile (e.g. the user updated it): keep the message, change nothing.
            if (!(e instanceof AppError)) throw e;
          }
        }
        if (!applied) {
          const what = category === "APPLICATION_CONFIRMATION" ? "Application confirmation received by email" : `Email detected: ${label}`;
          await recordApplicationEvent(userId, app.id, "status_email", `${what}${classification.fromDomain ? ` (from ${classification.fromDomain})` : ""}`, {
            actor: "system",
            metadata: { ...eventMetadata, applicationMessageId: row.id },
            tx,
          });
        }
        return { id: row.id, statusApplied: applied };
      });
    } catch (e) {
      // Unique (userId, messageHash): the same message was ingested concurrently.
      if ((e as { code?: string }).code === "P2002") return { stored: false, duplicate: true, category, applicationId: app?.id ?? null, statusApplied: null };
      throw e;
    }

    if (app) {
      const notice = CATEGORY_NOTICES[category];
      if (notice && confident) {
        const outcome = stored.statusApplied
          ? ` The application was moved to ${STATUS_LABELS[stored.statusApplied] ?? stored.statusApplied.toLowerCase()}.`
          : " Check your inbox for the details.";
        await notificationService.notify(userId, {
          type: notice.type,
          title: `${notice.title}: ${app.job.title} at ${app.job.company}`,
          body: `An email from ${classification.fromDomain ?? "the employer"} looks like ${notice.detected}.${outcome}`,
          link: `/applications/${app.id}`,
          dedupeKey: `msg:${messageHash}`,
        });
      }
      await audit(userId, "application.status_detected", {
        entityType: "Application",
        entityId: app.id,
        metadata: { applicationMessageId: stored.id, category, confidence: classification.confidence, statusApplied: stored.statusApplied, source },
      });
    }
    logger.info("status_email.ingested", {
      userId,
      applicationId: app?.id ?? null,
      category,
      confidence: classification.confidence,
      associated: app !== null,
      statusApplied: stored.statusApplied,
      source,
    });
    return { stored: true, duplicate: false, category, applicationId: app?.id ?? null, statusApplied: stored.statusApplied };
  },
};
