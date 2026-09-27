import { simpleParser, type EmailAddress, type ParsedMail } from "mailparser";
import type { MailMessage } from "./types";

/** Parse an RFC822 message (IMAP source, Gmail raw, webhook body). Attachments are dropped. */
export async function parseRawEmail(raw: Buffer): Promise<MailMessage> {
  let mail: ParsedMail;
  try {
    mail = await simpleParser(raw, { skipImageLinks: true, skipTextToHtml: true });
  } catch {
    // Never echo parser details: they can quote the message.
    throw new Error("The email could not be parsed.");
  }
  return {
    from: firstAddress(mail.from?.value ?? []) ?? "",
    subject: mail.subject ?? "",
    html: typeof mail.html === "string" && mail.html ? mail.html : null,
    text: mail.text ? mail.text : null,
    date: mail.date && !Number.isNaN(mail.date.getTime()) ? mail.date : null,
    messageId: mail.messageId ?? null,
  };
}

function firstAddress(list: EmailAddress[]): string | null {
  for (const a of list) {
    if (a.address) return a.address.trim().toLowerCase();
    const inGroup = a.group ? firstAddress(a.group) : null;
    if (inGroup) return inGroup;
  }
  return null;
}

// ---------------------------------------------------------------- Gmail forwarding confirmation

const FORWARDING_SENDER = "forwarding-noreply@google.com";
/** Hosts Google uses for the confirmation link, best first. */
const CONFIRM_HOSTS = ["mail-settings.google.com", "mail.google.com", "google.com", "www.google.com"];

/**
 * Detects Google's "(#123456) Gmail Forwarding Confirmation - Receive Mail from user@gmail.com" email
 * and extracts the code, the confirmation link and the requesting address. Returns null for any other
 * email. The link is for the user to open themselves; it must never be fetched server-side.
 */
export function gmailForwardingConfirmation(
  msg: MailMessage,
): { code: string | null; confirmUrl: string | null; requester: string | null } | null {
  if (msg.from !== FORWARDING_SENDER) return null;
  const link = confirmationLink(msg);
  // The subject is localised to the requester's Gmail language; a verification link identifies the email too.
  if (!/gmail forwarding confirmation/i.test(msg.subject) && !link?.verify) return null;
  const body = `${msg.text ?? ""}\n${msg.html ? stripTags(msg.html) : ""}`;
  const code = /\(#(\d{4,12})\)/.exec(msg.subject)?.[1] ?? /confirmation code:?\s*(\d{4,12})/i.exec(body)?.[1] ?? null;
  const requester =
    cleanAddress(/receive mail from\s+(\S+@\S+)/i.exec(msg.subject)?.[1]) ??
    cleanAddress(/([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})\s+has requested/i.exec(body)?.[1]) ??
    // Localised subjects still carry only the requester's address.
    cleanAddress(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.exec(msg.subject)?.[0]);
  return { code, confirmUrl: link?.url ?? null, requester };
}

function cleanAddress(s: string | undefined): string | null {
  const a = s?.replace(/^[<("']+|[>)"'.,;:]+$/g, "").toLowerCase();
  return a && /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(a) ? a : null;
}

function confirmationLink(msg: MailMessage): { url: string; verify: boolean } | null {
  const candidates: string[] = [];
  for (const m of (msg.html ?? "").matchAll(/href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi)) candidates.push(decodeEntities(m[1] ?? m[2] ?? m[3] ?? ""));
  // Plain-text links: drop sentence punctuation that follows the URL.
  for (const m of (msg.text ?? "").matchAll(/https:\/\/[^\s<>"')\]]+/gi)) candidates.push(m[0].replace(/[.,;:!?]+$/, ""));
  let best: { url: string; verify: boolean; score: number } | null = null;
  for (const c of candidates) {
    let u: URL;
    try {
      u = new URL(c.trim());
    } catch {
      continue;
    }
    const host = CONFIRM_HOSTS.indexOf(u.hostname.toLowerCase());
    if (u.protocol !== "https:" || u.username || u.password || host < 0) continue;
    // The verification link path is /mail/vf-...; other links on these hosts are help pages.
    const verify = /\/vf-/i.test(u.pathname);
    if (!verify && host >= 2) continue;
    const score = (verify ? 0 : 10) + host;
    if (!best || score < best.score) best = { url: u.toString(), verify, score };
  }
  return best && { url: best.url, verify: best.verify };
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, " "));
}

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** One pass, so "&#38;lt;" becomes "&lt;" (not "<"). */
function decodeEntities(s: string): string {
  return s.replace(/&(?:#x([0-9a-f]{1,6})|#(\d{1,7})|([a-z]+));/gi, (m, hex: string | undefined, dec: string | undefined, name: string | undefined) => {
    if (hex) return codePoint(parseInt(hex, 16));
    if (dec) return codePoint(Number(dec));
    return NAMED_ENTITIES[name ?? ""] ?? m;
  });
}

function codePoint(n: number): string {
  return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
}
