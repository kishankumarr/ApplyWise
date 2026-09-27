/** One job-alert email, reduced to what the alert parsers need. Never stored as-is. */
export interface MailMessage {
  /** Sender address, lowercase ("" when the message has no parsable From). */
  from: string;
  subject: string;
  html: string | null;
  text: string | null;
  date: Date | null;
  messageId: string | null;
}

/**
 * Sync position, JSON-serialisable and free of message content, e.g.
 * `{ imap: { mailbox, uidValidity, lastUid } }` or `{ gmail: { lastInternalDate, processedIds } }`.
 * Unknown keys are preserved so callers can keep their own state next to it.
 */
export type MailCursor = Record<string, unknown>;

export interface FetchOptions {
  /** Oldest message to consider (the first sync's look-back). */
  since: Date;
  /** Sender domains ("naukri.com") or full addresses ("jobalerts-noreply@linkedin.com"). */
  senderDomains: readonly string[];
  /** Newest N matching messages per run. */
  maxMessages: number;
  cursor: MailCursor;
  /** IMAP folder (default INBOX; Gmail searches All Mail). */
  folder?: string;
}

export interface FetchResult {
  messages: MailMessage[];
  cursor: MailCursor;
}

export interface ImapConnection {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  /** App password (never logged). */
  password?: string;
  /** OAuth access token for SASL XOAUTH2 (Microsoft). */
  accessToken?: string;
}

export interface ImapPreset {
  label: string;
  host: string;
  port: number;
  secure: boolean;
  /** Where the user creates an app password, or null when the provider does not allow them. */
  appPasswordUrl: string | null;
  /** Short setup hint shown next to the password field. */
  notes: string;
  /** Address domains this preset is detected from. */
  domains: string[];
  auth: "app_password" | "oauth_microsoft";
  /** Folder holding every message (archived ones too), searched instead of INBOX. */
  allMailFolder?: string;
}
