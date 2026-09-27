import "server-only";
import { prisma, type Prisma } from "@applywise/database";
import { redact } from "./logger";

export type AuditAction =
  | "auth.signed_up"
  | "auth.verification_sent"
  | "auth.email_verified"
  | "consent.updated"
  | "resume.uploaded"
  | "resume.parsed"
  | "resume.downloaded"
  | "resume.exported"
  | "resume.version_created"
  | "profile.updated"
  | "fact.verified"
  | "fact.rejected"
  | "fact.edited"
  | "job.imported"
  | "job.analyzed"
  | "questionnaire.generated"
  | "questionnaire.answered"
  | "application.prepared"
  | "application.edited"
  | "application.approved"
  | "application.status_changed"
  | "application.opened_apply_page"
  | "application.marked_submitted"
  | "email.previewed"
  | "email.sent"
  | "extension.token_created"
  | "extension.token_revoked"
  | "extension.prefill_issued"
  | "account.exported"
  | "account.deleted"
  | "demo.reset"
  | "feed.created"
  | "feed.updated"
  | "feed.removed"
  | "feed.mailbox_connected"
  | "feed.inbound_received"
  | "automation.settings_updated"
  | "automation.run_started"
  | "automation.run_completed"
  | "application.auto_approved"
  | "application.declined"
  | "application.execution_started"
  | "application.submitted_by_executor"
  | "application.execution_failed"
  | "application.manual_action_required"
  | "application.information_provided"
  | "application.resume_overridden"
  | "application.status_detected"
  | "provider.connected"
  | "provider.disconnected"
  | "provider.auth_failed"
  | "candidate_answer.saved"
  | "candidate_answer.deleted";

/** Write an audit entry. Metadata is redacted: never pass raw resume text, email bodies or secrets. */
export async function audit(
  userId: string | null,
  action: AuditAction,
  opts: { entityType?: string; entityId?: string; requestId?: string; metadata?: Record<string, unknown>; tx?: Prisma.TransactionClient } = {},
): Promise<void> {
  const db = opts.tx ?? prisma;
  await db.auditLog.create({
    data: {
      userId,
      action,
      entityType: opts.entityType,
      entityId: opts.entityId,
      requestId: opts.requestId,
      metadata: (redact(opts.metadata ?? {}) ?? {}) as Prisma.InputJsonValue,
    },
  });
}
