import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { gmailForwardingConfirmation, parseRawEmail, type MailMessage } from "../src";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(join(here, "fixtures", name));

describe("parseRawEmail", () => {
  it("parses a multipart job alert into a MailMessage", async () => {
    const m = await parseRawEmail(fixture("naukri-alert.eml"));
    expect(m.from).toBe("jobalerts@naukri.com");
    expect(m.subject).toBe("3 new Frontend Developer jobs – Bengaluru");
    expect(m.messageId).toBe("<alert-20260925-0001@naukri.com>");
    expect(m.date?.toISOString()).toBe("2026-09-25T04:00:00.000Z");
    expect(m.html).toContain("job-listings-react-engineer-lotus-fintech");
    // Quoted-printable soft line breaks are joined.
    expect(m.text).toContain("https://www.naukri.com/job-listings-frontend-developer-kavach-studio-bengaluru-3-to-5-years-230925000111");
    expect(m.text).toContain("Kavach Studio – Bengaluru");
    // Attachments are not part of the message shape.
    expect(Object.keys(m).sort()).toEqual(["date", "from", "html", "messageId", "subject", "text"]);
  });

  it("returns nulls for missing parts instead of throwing", async () => {
    const m = await parseRawEmail(Buffer.from("Subject: hi\r\n\r\n"));
    expect(m).toEqual({ from: "", subject: "hi", html: null, text: null, date: null, messageId: null });
  });
});

describe("gmailForwardingConfirmation", () => {
  it("extracts the code, the confirmation link and the requester", async () => {
    const m = await parseRawEmail(fixture("gmail-forwarding.eml"));
    expect(gmailForwardingConfirmation(m)).toEqual({
      code: "612345987",
      confirmUrl: "https://mail-settings.google.com/mail/vf-%5BANGjdJ9x%5D-Abc_def123?hl=en&src=fwd",
      requester: "priya.sharma@gmail.com",
    });
  });

  const base: MailMessage = {
    from: "forwarding-noreply@google.com",
    subject: "Gmail Forwarding Confirmation - Receive Mail from Someone.Else@gmail.com",
    html: null,
    text: "Someone.Else@gmail.com has requested to automatically forward mail to your email address.\nhttps://support.google.com/mail/answer/10957\nhttps://mail.google.com/mail/vf-%5BAbC%5D-xyz\n",
    date: null,
    messageId: null,
  };

  it("handles the link-only variant (no code) from plain text", () => {
    expect(gmailForwardingConfirmation(base)).toEqual({
      code: null,
      confirmUrl: "https://mail.google.com/mail/vf-%5BAbC%5D-xyz",
      requester: "someone.else@gmail.com",
    });
  });

  it("only accepts https links on Google hosts", () => {
    const spoofed = { ...base, text: "https://mail.google.com.evil.example/mail/vf-1\nhttp://mail.google.com/mail/vf-2\nhttps://evil.example/?u=https://mail.google.com/mail/vf-3" };
    expect(gmailForwardingConfirmation(spoofed)?.confirmUrl).toBeNull();
  });

  it("ignores other senders, and other subjects without a verification link", () => {
    expect(gmailForwardingConfirmation({ ...base, from: "forwarding-noreply@google.com.evil.example" })).toBeNull();
    expect(gmailForwardingConfirmation({ ...base, from: "jobalerts-noreply@linkedin.com" })).toBeNull();
    expect(gmailForwardingConfirmation({ ...base, subject: "Your Google Account", text: "https://support.google.com/mail/answer/10957\nhttps://mail.google.com/mail/u/0/#settings" })).toBeNull();
  });

  it("recognises a localised subject by its verification link", () => {
    const hindi: MailMessage = {
      ...base,
      subject: "(#612345987) Gmail अग्रेषण पुष्टि - priya.sharma@gmail.com से ईमेल प्राप्त करें",
      text: "priya.sharma@gmail.com ने अनुरोध किया है ...\nhttps://mail-settings.google.com/mail/vf-%5BABC%5D-def",
    };
    expect(gmailForwardingConfirmation(hindi)).toEqual({ code: "612345987", confirmUrl: "https://mail-settings.google.com/mail/vf-%5BABC%5D-def", requester: "priya.sharma@gmail.com" });
  });

  it("decodes entities in links once, and reads unquoted or mixed-quote hrefs", () => {
    const html = (href: string) => ({ ...base, text: null, html: `<a href=${href}>Confirm</a>` });
    // "&#38;amp;" is an escaped "&amp;": decoding it twice would turn the query into "&src=".
    expect(gmailForwardingConfirmation(html(`"https://mail-settings.google.com/mail/vf-1?hl=en&#38;amp;src=fwd"`))?.confirmUrl).toBe(
      "https://mail-settings.google.com/mail/vf-1?hl=en&amp;src=fwd",
    );
    expect(gmailForwardingConfirmation(html(`"https://mail-settings.google.com/mail/vf-1?hl=en&amp;src=fwd"`))?.confirmUrl).toBe("https://mail-settings.google.com/mail/vf-1?hl=en&src=fwd");
    expect(gmailForwardingConfirmation(html("https://mail-settings.google.com/mail/vf-2"))?.confirmUrl).toBe("https://mail-settings.google.com/mail/vf-2");
    expect(gmailForwardingConfirmation(html(`"https://mail-settings.google.com/mail/vf-3?x='y'"`))?.confirmUrl).toBe("https://mail-settings.google.com/mail/vf-3?x=%27y%27");
  });

  it("drops sentence punctuation after a plain-text link", () => {
    const m = { ...base, text: "Confirm here: https://mail-settings.google.com/mail/vf-%5BAbC%5D-xyz." };
    expect(gmailForwardingConfirmation(m)?.confirmUrl).toBe("https://mail-settings.google.com/mail/vf-%5BAbC%5D-xyz");
  });
});
