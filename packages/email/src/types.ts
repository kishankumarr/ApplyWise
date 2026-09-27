export interface EmailAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
}

export interface OutboundEmail {
  from: string;
  replyTo: string | null;
  to: string;
  cc: string[];
  subject: string;
  text: string;
  html: string;
  attachments: EmailAttachment[];
}

export interface EmailSendResult {
  provider: string;
  messageId: string;
  /** True when the adapter only captured the email locally (dev outbox / Mailpit). */
  captured: boolean;
}

/** Where mail actually goes: a local file outbox, a local catcher (Mailpit/Mailtrap), or real inboxes. */
export type EmailDelivery = "outbox" | "catcher" | "external";

export interface EmailAdapter {
  readonly name: string;
  readonly delivery: EmailDelivery;
  /** Whether the adapter can deliver to real inboxes. */
  readonly deliversExternally: boolean;
  send(email: OutboundEmail): Promise<EmailSendResult>;
}
