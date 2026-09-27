/** Read-only access to job-alert emails in the user's own mailbox (IMAP, Gmail API, Microsoft). */
export type { FetchOptions, FetchResult, ImapConnection, ImapPreset, MailCursor, MailMessage } from "./types";
export { MailAuthError, MailTransientError } from "./errors";
export { detectImapPreset, IMAP_PRESETS } from "./presets";
export { fetchAlertEmailsImap, IMAP_TIMEOUTS, testImapConnection } from "./imap";
export { fetchAlertEmailsGmail, GMAIL_PROCESSED_IDS_MAX, GMAIL_SCOPE, gmailAccessToken, gmailAuthUrl, gmailExchangeCode, gmailRevoke } from "./gmail";
export { MICROSOFT_IMAP_SCOPE, microsoftAccessToken, microsoftPollDeviceCode, microsoftStartDeviceCode } from "./microsoft";
export { createPkcePair } from "./oauth";
export { gmailForwardingConfirmation, parseRawEmail } from "./parse";
export { verifyInboundSignature } from "./webhook";
