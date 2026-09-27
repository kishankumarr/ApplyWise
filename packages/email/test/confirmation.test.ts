import { describe, expect, it } from "vitest";
import {
  buildMailtoUrl,
  createEmailAdapter,
  createSendConfirmationToken,
  DevOutboxAdapter,
  EmailConfirmationError,
  emailContentDigest,
  sendConfirmedEmail,
  type OutboundEmail,
} from "../src";

const secret = "x".repeat(40);
const email: OutboundEmail = {
  from: "ApplyWise <noreply@applywise.test>",
  replyTo: "candidate@example.test",
  to: "hiring@kavach-studio.test",
  cc: [],
  subject: "Application for Frontend Developer",
  text: "Dear Hiring Team...",
  html: "<p>Dear Hiring Team...</p>",
  attachments: [{ filename: "resume.pdf", contentType: "application/pdf", content: Buffer.from("%PDF-1.7") }],
};

function confirmation(overrides: Partial<Parameters<typeof sendConfirmedEmail>[2]> = {}) {
  const token = createSendConfirmationToken({ userId: "u1", applicationId: "a1", contentDigest: emailContentDigest(email) }, secret);
  return { token, userId: "u1", applicationId: "a1", userConfirmed: true, consentToSend: true, ...overrides };
}

describe("email-send confirmation checks", () => {
  it("sends only with a valid token, explicit confirmation and consent", async () => {
    const adapter = new DevOutboxAdapter(null);
    const res = await sendConfirmedEmail(adapter, email, confirmation(), secret);
    expect(res.captured).toBe(true);
    expect(adapter.sent).toHaveLength(1);
  });

  it("refuses without explicit confirmation or consent", async () => {
    const adapter = new DevOutboxAdapter(null);
    await expect(sendConfirmedEmail(adapter, email, confirmation({ userConfirmed: false }), secret)).rejects.toBeInstanceOf(EmailConfirmationError);
    await expect(sendConfirmedEmail(adapter, email, confirmation({ consentToSend: false }), secret)).rejects.toThrow(/Consent/);
    expect(adapter.sent).toHaveLength(0);
  });

  it("refuses if the content changed after review", async () => {
    const adapter = new DevOutboxAdapter(null);
    const c = confirmation();
    await expect(sendConfirmedEmail(adapter, { ...email, to: "someone-else@example.test" }, c, secret)).rejects.toThrow(/changed/);
    await expect(sendConfirmedEmail(adapter, { ...email, text: "edited" }, c, secret)).rejects.toThrow(/changed/);
    await expect(
      sendConfirmedEmail(adapter, { ...email, attachments: [{ ...email.attachments[0]!, content: Buffer.from("other") }] }, c, secret),
    ).rejects.toThrow(/changed/);
    expect(adapter.sent).toHaveLength(0);
  });

  it("refuses tokens for another user/application, forged or expired tokens", async () => {
    const adapter = new DevOutboxAdapter(null);
    await expect(sendConfirmedEmail(adapter, email, confirmation({ userId: "u2" }), secret)).rejects.toThrow(/belong/);
    await expect(sendConfirmedEmail(adapter, email, confirmation({ token: "abc.def" }), secret)).rejects.toThrow(/Invalid/);
    const old = createSendConfirmationToken({ userId: "u1", applicationId: "a1", contentDigest: emailContentDigest(email) }, secret, Date.now() - 60 * 60 * 1000);
    await expect(sendConfirmedEmail(adapter, email, confirmation({ token: old }), secret)).rejects.toThrow(/expired/);
    const forged = createSendConfirmationToken({ userId: "u1", applicationId: "a1", contentDigest: emailContentDigest(email) }, "y".repeat(40));
    await expect(sendConfirmedEmail(adapter, email, confirmation({ token: forged }), secret)).rejects.toThrow(/Invalid/);
  });

  it("defaults to the non-delivering dev outbox", () => {
    const adapter = createEmailAdapter({});
    expect(adapter.name).toBe("dev-outbox");
    expect(adapter.deliversExternally).toBe(false);
    expect(createEmailAdapter({ EMAIL_PROVIDER: "smtp", SMTP_HOST: "localhost" }).deliversExternally).toBe(false);
    // Delivery mode drives the verification banner copy.
    expect(adapter.delivery).toBe("outbox");
    expect(createEmailAdapter({ EMAIL_PROVIDER: "smtp", SMTP_HOST: "localhost" }).delivery).toBe("catcher");
    expect(createEmailAdapter({ EMAIL_PROVIDER: "smtp", SMTP_HOST: "smtp.example.com", SMTP_DELIVERS_EXTERNALLY: "true" }).delivery).toBe("external");
    expect(createEmailAdapter({ EMAIL_PROVIDER: "resend", RESEND_API_KEY: "re_x" }).delivery).toBe("external");
  });

  it("builds mailto links", () => {
    const url = buildMailtoUrl({ to: "hr@x.test", subject: "Hi there", body: "Line 1\nLine 2" });
    expect(url.startsWith("mailto:hr%40x.test?")).toBe(true);
    expect(url).toContain("subject=Hi%20there");
    expect(url).not.toContain("+");
  });
});
