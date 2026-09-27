import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { prisma, seedDemoJobs } from "@applywise/database";
import { parseCvText, parsedCvToDocument, renderResumeDocx } from "@applywise/resume-engine";
import { applicationService } from "@/server/services/application.service";
import { authService } from "@/server/services/auth.service";
import { consentService } from "@/server/services/consent.service";
import { emailService } from "@/server/services/email.service";
import { extensionService } from "@/server/services/extension.service";
import { jobsService } from "@/server/services/jobs.service";
import { profileService } from "@/server/services/profile.service";
import { questionnaireService } from "@/server/services/questionnaire.service";
import { resumeService } from "@/server/services/resume.service";
import { accountService } from "@/server/services/account.service";
import { emailVerificationService, VERIFY_TTL_MS } from "@/server/services/email-verification.service";
import { signToken } from "@/server/crypto";

let a: string;
let b: string;
let resumeId: string;
let emailJobId: string;
let privateJobId: string;
let applicationId: string;

const expectNotFound = async (p: Promise<unknown>) => {
  await expect(p).rejects.toMatchObject({ status: 404 });
};

beforeAll(async () => {
  await seedDemoJobs(prisma, "http://localhost:3000");
  a = (await authService.signUp({ name: "User A", email: `a-${Date.now()}@example.test`, password: "Password123", acceptTerms: true })).userId;
  b = (await authService.signUp({ name: "User B", email: `b-${Date.now()}@example.test`, password: "Password123", acceptTerms: true })).userId;
  await consentService.update(a, { cvProcessing: true, aiProcessing: false });
  await consentService.update(b, { cvProcessing: true });

  const text = readFileSync(resolve(__dirname, "../../../packages/resume-engine/fixtures/demo-cv.txt"), "utf8");
  const docx = await renderResumeDocx(parsedCvToDocument(parseCvText(text)));
  const file = new File([new Uint8Array(docx)], "demo-cv.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
  resumeId = (await resumeService.upload(a, file)).id;
  await resumeService.requestParse(a, resumeId); // inline queue => parsed synchronously
  await profileService.verifyAll(a);
  await profileService.update(a, { yoe: 5, preferredLocations: ["Bengaluru", "Remote - India"], targetRoles: ["Frontend Engineer"], onboardingCompleted: true });

  emailJobId = (await prisma.job.findFirstOrThrow({ where: { isDemo: true, applyMethod: "EMAIL", company: "Kavach Studio" } })).id;
  const imported = await jobsService.importManual(a, {
    mode: "structured",
    title: "Private React Role",
    company: "Secret Co",
    location: ["Pune"],
    description: "Private job imported by user A. Requirements: React and TypeScript.",
    requiredSkills: ["React"],
    preferredSkills: [],
    applyUrl: null,
    hrEmail: null,
    sourceUrl: null,
  });
  privateJobId = imported.imported[0]!.jobId;
});

describe("CV upload pipeline", () => {
  it("rejects uploads without CV consent and unsupported files", async () => {
    await consentService.update(b, { cvProcessing: false });
    await expect(resumeService.upload(b, new File(["%PDF-1.7"], "x.pdf", { type: "application/pdf" }))).rejects.toMatchObject({ code: "CONSENT_REQUIRED" });
    await consentService.update(b, { cvProcessing: true });
    await expect(resumeService.upload(b, new File(["MZ binary"], "evil.exe", { type: "application/octet-stream" }))).rejects.toMatchObject({ code: "UNSUPPORTED_FILE" });
    await expect(resumeService.upload(b, new File(["not a pdf"], "fake.pdf", { type: "application/pdf" }))).rejects.toMatchObject({ code: "UNSUPPORTED_FILE" });
  });

  it("parsed the CV into unverified facts, then the user verified them", async () => {
    const resume = await prisma.resume.findUniqueOrThrow({ where: { id: resumeId } });
    expect(resume.status).toBe("PARSED");
    expect(resume.extractedTextEnc?.startsWith("v1:")).toBe(true);
    expect(resume.extractedTextEnc).not.toContain("Clipverse");
    const view = await profileService.getView(a);
    expect(view.profile.experience.map((e) => e.company)).toContain("Clipverse Media");
    expect(view.verification.unverified).toBe(0);
    const audit = await prisma.auditLog.findMany({ where: { userId: a } });
    expect(JSON.stringify(audit)).not.toContain("Clipverse");
  });
});

describe("user ownership enforcement", () => {
  it("hides private jobs from other users", async () => {
    await expectNotFound(jobsService.get(b, privateJobId));
    const listB = await jobsService.list(b, { sort: "score", order: "desc", page: 1, pageSize: 100, platform: [], workMode: [], status: [], applyMethod: [], includeIgnored: true, savedOnly: false, newOnly: false });
    expect(listB.items.some((j) => j.id === privateJobId)).toBe(false);
    const listA = await jobsService.list(a, { sort: "score", order: "desc", page: 1, pageSize: 100, platform: [], workMode: [], status: [], applyMethod: [], includeIgnored: true, savedOnly: false, newOnly: false, q: "Private" });
    expect(listA.items.map((j) => j.id)).toContain(privateJobId);
  });

  it("scopes resumes, facts, questionnaires and applications to their owner", async () => {
    await expectNotFound(resumeService.download(b, resumeId));
    await expectNotFound(resumeService.export(b, resumeId, "pdf"));
    const factId = (await prisma.truthBankItem.findFirstOrThrow({ where: { userId: a } })).id;
    await expectNotFound(profileService.verifyFact(b, factId, undefined));
    await expectNotFound(profileService.rejectFact(b, factId));

    await questionnaireService.generate(a, emailJobId);
    expect(await questionnaireService.get(b, emailJobId)).toBeNull();

    const prepared = await applicationService.prepare(a, emailJobId);
    applicationId = prepared.applicationId;
    await expectNotFound(applicationService.get(b, applicationId));
    await expectNotFound(applicationService.update(b, applicationId, { notes: "hijack" }));
    await expectNotFound(applicationService.approve(b, applicationId));
    await expectNotFound(applicationService.markSubmitted(b, applicationId, undefined));
    await expectNotFound(emailService.preview(b, applicationId, { to: "x@example.test", cc: [], subject: "s", body: "b".repeat(30), attachCoverLetter: false }));
    await expectNotFound(extensionService.issuePrefill(b, applicationId));
  });
});

describe("application preparation and review", () => {
  it("generated truthful drafts and requires approval before any apply action", async () => {
    const app = await applicationService.get(a, applicationId);
    expect(app.status).toBe("READY_FOR_REVIEW");
    expect(app.tailored?.provider).toBe("fallback");
    expect(app.tailored?.validation.mayShow).toBe(true);
    expect(app.emailDraft?.to).toBe("hiring@kavach-studio.test");
    await expect(applicationService.markSubmitted(a, applicationId, undefined)).rejects.toMatchObject({ code: "INVALID_STATE" });
    await expect(emailService.preview(a, applicationId, { to: app.emailDraft!.to, cc: [], subject: app.emailDraft!.subject, body: app.emailDraft!.body, attachCoverLetter: false })).rejects.toMatchObject({ code: "INVALID_STATE" });
    await applicationService.approve(a, applicationId);
    expect((await applicationService.get(a, applicationId)).status).toBe("APPROVED");
  });
});

describe("email-send confirmation checks", () => {
  it("requires preview token, consent and unchanged content", async () => {
    const app = await applicationService.get(a, applicationId);
    const input = { to: app.emailDraft!.to, cc: [], subject: app.emailDraft!.subject, body: app.emailDraft!.body, attachCoverLetter: true };
    const preview = await emailService.preview(a, applicationId, input);
    expect(preview.attachments.map((x) => x.filename)).toEqual(expect.arrayContaining([expect.stringMatching(/Resume\.pdf$/), "Cover_Letter.txt"]));
    expect((await applicationService.get(a, applicationId)).status).toBe("EMAIL_DRAFT_READY");

    const send = { confirmationToken: preview.confirmationToken, userConfirmed: true as const, consentToSend: true as const };
    expect(preview.senderVerified).toBe(false);
    expect(preview.replyTo).toBeNull();
    expect(preview.canSendFromApp).toBe(false);
    // The account email is not confirmed yet -> nothing can be sent, even with consent.
    await consentService.update(a, { emailSending: true });
    await expect(emailService.requestSend(a, applicationId, send)).rejects.toMatchObject({ code: "EMAIL_NOT_VERIFIED" });
    const link = (await emailVerificationService.send(a)).devVerificationUrl!;
    expect(link).toMatch(/\/verify-email\?token=/);
    await emailVerificationService.verify(decodeURIComponent(link.split("token=")[1]!));
    expect(await emailVerificationService.isVerified(a)).toBe(true);
    await consentService.update(a, { emailSending: false });
    // No email-sending consent.
    await expect(emailService.requestSend(a, applicationId, send)).rejects.toMatchObject({ code: "CONSENT_REQUIRED" });
    await consentService.update(a, { emailSending: true });
    // Tampered token.
    await expect(emailService.requestSend(a, applicationId, { ...send, confirmationToken: `${preview.confirmationToken}x` })).rejects.toMatchObject({ code: "CONFIRMATION_REQUIRED" });
    // Content changed after review => the old token is no longer valid.
    await emailService.preview(a, applicationId, { ...input, body: `${input.body}\n\nP.S. edited` });
    await expect(emailService.requestSend(a, applicationId, send)).rejects.toMatchObject({ code: "CONFIRMATION_REQUIRED" });
    // Fresh preview => send succeeds (dev outbox, inline queue).
    const fresh = await emailService.preview(a, applicationId, input);
    // A queued send re-checks the confirmed address at send time.
    await prisma.user.update({ where: { id: a }, data: { emailVerifiedAt: null } });
    await expect(emailService.runSend(a, applicationId, fresh.confirmationToken)).rejects.toMatchObject({ code: "EMAIL_NOT_VERIFIED" });
    await prisma.user.update({ where: { id: a }, data: { emailVerifiedAt: new Date() } });
    await emailService.requestSend(a, applicationId, { ...send, confirmationToken: fresh.confirmationToken });
    const after = await applicationService.get(a, applicationId);
    expect(after.status).toBe("EMAIL_SENT");
    expect(after.emailDraft?.status).toBe("SENT");
    expect(after.events.some((e) => e.type === "email_sent")).toBe(true);
  });
});

describe("email address verification", () => {
  it("binds links to the user and address, rejects tampering, and is idempotent", async () => {
    const u = (await authService.signUp({ name: "Verify Me", email: `v-${Date.now()}@example.test`, password: "Password123", acceptTerms: true })).userId;
    expect(await emailVerificationService.isVerified(u)).toBe(false);
    const link = (await emailVerificationService.send(u)).devVerificationUrl!;
    const token = decodeURIComponent(link.split("token=")[1]!);
    await expect(emailVerificationService.verify(`${token}x`)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    // Changing the address invalidates earlier links.
    await prisma.user.update({ where: { id: u }, data: { email: `changed-${Date.now()}@example.test` } });
    await expect(emailVerificationService.verify(token)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    const fresh = decodeURIComponent((await emailVerificationService.send(u)).devVerificationUrl!.split("token=")[1]!);
    await emailVerificationService.verify(fresh);
    await emailVerificationService.verify(fresh); // idempotent
    expect(await emailVerificationService.isVerified(u)).toBe(true);
    expect((await emailVerificationService.send(u)).alreadyVerified).toBe(true);
    const audits = await prisma.auditLog.findMany({ where: { userId: u, action: { in: ["auth.verification_sent", "auth.email_verified"] } } });
    expect(audits.filter((x) => x.action === "auth.email_verified")).toHaveLength(1);
    expect(JSON.stringify(audits)).not.toContain(token);
  });

  it("confirms only the account a link was issued for, and only on the explicit confirm step", async () => {
    const x = (await authService.signUp({ name: "X", email: `x-${Date.now()}@example.test`, password: "Password123", acceptTerms: true })).userId;
    const yEmail = `y-${Date.now()}@example.test`;
    const y = (await authService.signUp({ name: "Y", email: yEmail, password: "Password123", acceptTerms: true })).userId;
    const xToken = decodeURIComponent((await emailVerificationService.send(x)).devVerificationUrl!.split("token=")[1]!);
    // Rendering the link's page is read-only.
    expect(await emailVerificationService.inspect(xToken)).toMatchObject({ alreadyVerified: false });
    expect(await emailVerificationService.isVerified(x)).toBe(false);
    await emailVerificationService.verify(xToken);
    expect(await emailVerificationService.isVerified(x)).toBe(true);
    expect(await emailVerificationService.isVerified(y)).toBe(false);
    // A validly signed token that pairs Y's id with X's address is rejected (address binding).
    const xEmail = (await prisma.user.findUniqueOrThrow({ where: { id: x } })).email;
    const crossed = signToken("verify-email", { userId: y, email: xEmail }, VERIFY_TTL_MS);
    await expect(emailVerificationService.verify(crossed)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(await emailVerificationService.isVerified(y)).toBe(false);
    // Expired links are rejected.
    const expired = signToken("verify-email", { userId: y, email: yEmail }, -1_000);
    await expect(emailVerificationService.verify(expired)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(emailVerificationService.inspect(expired)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(await emailVerificationService.isVerified(y)).toBe(false);
    // Sign-up queued the first link as a background task (no PII in the payload).
    const task = await prisma.backgroundTask.findFirstOrThrow({ where: { userId: y, type: "email.verification" } });
    expect(task.status).toBe("SUCCEEDED");
    expect(JSON.stringify(task.payload)).not.toContain(yEmail);
  });
});

describe("AI consent is scoped to the provider kind", () => {
  it("consent for a local model does not cover an external provider", async () => {
    const saved = process.env.AI_PROVIDER;
    const u = (await authService.signUp({ name: "Consent", email: `c-${Date.now()}@example.test`, password: "Password123", acceptTerms: true })).userId;
    try {
      process.env.AI_PROVIDER = "ollama"; // local
      await consentService.update(u, { aiProcessing: true });
      expect((await prisma.userConsent.findFirstOrThrow({ where: { userId: u, type: "AI_PROCESSING" } })).version).toBe("2026-09:local");
      expect(await consentService.get(u)).toMatchObject({ aiProcessing: true, aiProcessingNeedsRenewal: false });
      process.env.AI_PROVIDER = "anthropic"; // external
      expect(await consentService.get(u)).toMatchObject({ aiProcessing: false, aiProcessingNeedsRenewal: true });
      await expect(consentService.require(u, "aiProcessing")).rejects.toMatchObject({ code: "CONSENT_REQUIRED" });
      await consentService.update(u, { aiProcessing: true });
      expect(await consentService.get(u)).toMatchObject({ aiProcessing: true, aiProcessingNeedsRenewal: false });
      // Consent for an external provider also covers a local one.
      process.env.AI_PROVIDER = "ollama";
      expect((await consentService.get(u)).aiProcessing).toBe(true);
      // Legacy rows without a scope count as local-only.
      await prisma.userConsent.update({ where: { userId_type: { userId: u, type: "AI_PROCESSING" } }, data: { version: "2026-09" } });
      expect((await consentService.get(u)).aiProcessing).toBe(true);
      process.env.AI_PROVIDER = "anthropic";
      expect((await consentService.get(u)).aiProcessing).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.AI_PROVIDER;
      else process.env.AI_PROVIDER = saved;
    }
  });
});

describe("account deletion", () => {
  it("cascades all personal data and leaves only an anonymised audit record", async () => {
    await accountService.delete(a);
    expect(await prisma.user.findUnique({ where: { id: a } })).toBeNull();
    for (const count of await Promise.all([
      prisma.resume.count({ where: { userId: a } }),
      prisma.truthBankItem.count({ where: { userId: a } }),
      prisma.application.count({ where: { userId: a } }),
      prisma.applicationEmailDraft.count({ where: { userId: a } }),
      prisma.job.count({ where: { ownerUserId: a } }),
      prisma.auditLog.count({ where: { userId: a } }),
    ])) {
      expect(count).toBe(0);
    }
    const deletion = await prisma.auditLog.findFirst({ where: { action: "account.deleted" }, orderBy: { createdAt: "desc" } });
    expect(deletion?.userId).toBeNull();
    expect(JSON.stringify(deletion?.metadata)).not.toContain(a);
  });
});
