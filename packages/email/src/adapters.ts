import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EmailAdapter, EmailDelivery, EmailSendResult, OutboundEmail } from "./types";

/** Network timeouts so a slow or unreachable mail server cannot hang a request or worker. */
export const EMAIL_TIMEOUTS = { connectMs: 10_000, greetingMs: 10_000, socketMs: 30_000, httpMs: 15_000 } as const;

/** Development adapter: writes the message to a local outbox folder. Nothing leaves the machine. */
export class DevOutboxAdapter implements EmailAdapter {
  readonly name = "dev-outbox";
  readonly delivery: EmailDelivery = "outbox";
  readonly deliversExternally = false;
  readonly sent: OutboundEmail[] = [];
  constructor(private readonly dir: string | null) {}

  async send(email: OutboundEmail): Promise<EmailSendResult> {
    const messageId = `dev-${randomUUID()}`;
    this.sent.push(email);
    if (this.dir) {
      await mkdir(this.dir, { recursive: true });
      const meta = { ...email, attachments: email.attachments.map((a) => ({ filename: a.filename, contentType: a.contentType, bytes: a.content.length })) };
      await writeFile(join(this.dir, `${messageId}.json`), JSON.stringify(meta, null, 2), "utf8");
    }
    return { provider: this.name, messageId, captured: true };
  }
}

/** SMTP adapter (Nodemailer). Works with Mailpit/Mailtrap locally or a real SMTP relay. */
export class SmtpAdapter implements EmailAdapter {
  readonly name = "smtp";
  constructor(
    private readonly options: { host: string; port: number; secure: boolean; user?: string; pass?: string },
    readonly deliversExternally: boolean,
  ) {}

  get delivery(): EmailDelivery {
    return this.deliversExternally ? "external" : "catcher";
  }

  async send(email: OutboundEmail): Promise<EmailSendResult> {
    const nodemailer = await import("nodemailer");
    const transport = nodemailer.createTransport({
      host: this.options.host,
      port: this.options.port,
      secure: this.options.secure,
      auth: this.options.user ? { user: this.options.user, pass: this.options.pass } : undefined,
      connectionTimeout: EMAIL_TIMEOUTS.connectMs,
      greetingTimeout: EMAIL_TIMEOUTS.greetingMs,
      socketTimeout: EMAIL_TIMEOUTS.socketMs,
    });
    const info = await transport.sendMail({
      from: email.from,
      replyTo: email.replyTo ?? undefined,
      to: email.to,
      cc: email.cc.length ? email.cc : undefined,
      subject: email.subject,
      text: email.text,
      html: email.html,
      attachments: email.attachments.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType })),
    });
    return { provider: this.name, messageId: String(info.messageId), captured: !this.deliversExternally };
  }
}

/** Resend HTTP API adapter. */
export class ResendAdapter implements EmailAdapter {
  readonly name = "resend";
  readonly delivery: EmailDelivery = "external";
  readonly deliversExternally = true;
  constructor(private readonly apiKey: string) {}

  async send(email: OutboundEmail): Promise<EmailSendResult> {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      signal: AbortSignal.timeout(EMAIL_TIMEOUTS.httpMs),
      body: JSON.stringify({
        from: email.from,
        to: [email.to],
        cc: email.cc.length ? email.cc : undefined,
        reply_to: email.replyTo ?? undefined,
        subject: email.subject,
        text: email.text,
        html: email.html,
        attachments: email.attachments.map((a) => ({ filename: a.filename, content: a.content.toString("base64") })),
      }),
    });
    if (!res.ok) throw new Error(`Resend request failed with status ${res.status}`);
    const data = (await res.json()) as { id?: string };
    return { provider: this.name, messageId: data.id ?? "unknown", captured: false };
  }
}

export interface EmailEnv {
  EMAIL_PROVIDER?: string;
  EMAIL_OUTBOX_DIR?: string;
  SMTP_HOST?: string;
  SMTP_PORT?: string;
  SMTP_SECURE?: string;
  SMTP_USER?: string;
  SMTP_PASS?: string;
  SMTP_DELIVERS_EXTERNALLY?: string;
  RESEND_API_KEY?: string;
}

/** Build the configured adapter. Defaults to the dev outbox, which never sends real email. */
export function createEmailAdapter(env: EmailEnv): EmailAdapter {
  const provider = (env.EMAIL_PROVIDER ?? "dev").toLowerCase();
  if (provider === "smtp" && env.SMTP_HOST) {
    return new SmtpAdapter(
      {
        host: env.SMTP_HOST,
        port: Number(env.SMTP_PORT ?? 1025),
        secure: env.SMTP_SECURE === "true",
        user: env.SMTP_USER || undefined,
        pass: env.SMTP_PASS || undefined,
      },
      env.SMTP_DELIVERS_EXTERNALLY === "true",
    );
  }
  if (provider === "resend" && env.RESEND_API_KEY) return new ResendAdapter(env.RESEND_API_KEY);
  return new DevOutboxAdapter(env.EMAIL_OUTBOX_DIR ?? null);
}
