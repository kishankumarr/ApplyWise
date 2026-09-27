import { describe, expect, it } from "vitest";
import { prisma, type ApplicationStatus, type EmailDraftStatus } from "@applywise/database";
import { applicationExecutionService } from "@/server/services/application-execution.service";
import { emailService } from "@/server/services/email.service";

/**
 * Application emails go out at most once: the user's preview cannot race the automation (compare-and-set on the
 * application before the draft changes), a SENT draft is never rewritten or confirmed again, and a confirmed preview
 * is consumed by the first send task.
 */

const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const BODY = "Dear hiring team, please find my application for the Frontend Engineer role below. Kind regards, Asha";

async function setup(status: ApplicationStatus, draftStatus: EmailDraftStatus = "DRAFT") {
  const user = await prisma.user.create({ data: { email: `send-once-${uid()}@example.test`, passwordHash: "unused-in-tests", emailVerifiedAt: new Date() } });
  await prisma.userConsent.create({ data: { userId: user.id, type: "EMAIL_SENDING", granted: true, grantedAt: new Date() } });
  const job = await prisma.job.create({
    data: {
      ownerUserId: user.id,
      platform: "OTHER",
      title: "Frontend Engineer",
      company: "Acme Test",
      description: "Send your resume to hr@acme.test.",
      importMethod: "MANUAL_ENTRY",
      dedupeKey: `send-once-${uid()}`,
      hrEmail: "hr@acme.test",
      applyMethod: "EMAIL",
    },
  });
  const app = await prisma.application.create({
    data: { userId: user.id, jobId: job.id, status, applyMethod: "EMAIL", origin: "AUTOMATION", mode: "AUTO", approvalSource: "policy", approvedAt: new Date(), rulesVersion: 1 },
  });
  await prisma.applicationEmailDraft.create({
    data: { userId: user.id, applicationId: app.id, to: "hr@acme.test", subject: "Application: Frontend Engineer", body: BODY, originalBody: BODY, provider: "fallback", promptVersion: "v1", status: draftStatus },
  });
  return { userId: user.id, appId: app.id };
}

const input = (body = BODY) => ({ to: "hr@acme.test", cc: [], subject: "Application: Frontend Engineer", body, attachCoverLetter: false });
const draftOf = (appId: string) => prisma.applicationEmailDraft.findUniqueOrThrow({ where: { applicationId: appId } });
const sends = (userId: string) => prisma.auditLog.count({ where: { userId, action: "email.sent" } });

describe("application email: exactly once", () => {
  it("a preview never touches an application the automation already started, and takes over an approved one", async () => {
    const started = await setup("APPLYING");
    await expect(emailService.preview(started.userId, started.appId, input(`${BODY} (edited)`))).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect((await draftOf(started.appId)).body).toBe(BODY);

    // APPROVED -> EMAIL_DRAFT_READY first: the automation can no longer start on it.
    const approved = await setup("APPROVED");
    await emailService.preview(approved.userId, approved.appId, input());
    expect((await prisma.application.findUniqueOrThrow({ where: { id: approved.appId } })).status).toBe("EMAIL_DRAFT_READY");
    await expect(applicationExecutionService.execute(approved.userId, approved.appId)).resolves.toMatchObject({ outcome: "SKIPPED" });
    expect(await prisma.applicationExecution.count({ where: { applicationId: approved.appId } })).toBe(0);
  });

  it("a sent draft is never rewritten, confirmed or sent again", async () => {
    const s = await setup("EMAIL_DRAFT_READY", "SENT");
    await expect(emailService.preview(s.userId, s.appId, input(`${BODY} (edited)`))).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await draftOf(s.appId)).toMatchObject({ status: "SENT", body: BODY });

    const t = await setup("EMAIL_DRAFT_READY");
    const preview = await emailService.preview(t.userId, t.appId, input());
    await prisma.application.update({ where: { id: t.appId }, data: { emailSentAt: new Date() } });
    await expect(emailService.requestSend(t.userId, t.appId, { confirmationToken: preview.confirmationToken, userConfirmed: true, consentToSend: true })).rejects.toMatchObject({ code: "CONFLICT" });
    await emailService.runSend(t.userId, t.appId, preview.confirmationToken);
    expect(await sends(t.userId)).toBe(0);
  });

  it("two send tasks for one confirmation send one email", async () => {
    const s = await setup("EMAIL_DRAFT_READY");
    const preview = await emailService.preview(s.userId, s.appId, input());
    await Promise.all([emailService.runSend(s.userId, s.appId, preview.confirmationToken), emailService.runSend(s.userId, s.appId, preview.confirmationToken)]);
    expect(await sends(s.userId)).toBe(1);
    expect((await draftOf(s.appId)).status).toBe("SENT");
    expect(await prisma.application.findUniqueOrThrow({ where: { id: s.appId } })).toMatchObject({ status: "EMAIL_SENT" });
    // A re-delivered task later on sends nothing either.
    await emailService.runSend(s.userId, s.appId, preview.confirmationToken);
    expect(await sends(s.userId)).toBe(1);
    expect(await prisma.applicationEvent.count({ where: { applicationId: s.appId, type: "email_sent" } })).toBe(1);
  });
});
