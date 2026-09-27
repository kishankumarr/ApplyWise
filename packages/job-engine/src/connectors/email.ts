import { simpleParser, type ParsedMail } from "mailparser";
import type { JobPlatform } from "@applywise/types";
import { detectAlertPlatformFromLinks, parseJobAlertEmail, parseJobAlertEmailAs } from "../feeds/alerts";
import { INTRO, isTitleText } from "../feeds/alerts/fields";
import { decodeHtmlEntities } from "../feeds/alerts/html";
import { senderAddress } from "../feeds/alerts/senders";
import type { AlertEmail } from "../feeds/types";
import { applicationContactEmail, isNonApplicationAddress } from "../automation/application-email";
import { detectPlatformFromUrl, extractUrls } from "../jd-parser";
import { normalizeRawJob } from "./normalize";
import { ConnectorInputError, type ImportInput, type JobSourceConnector, type RawImportedJob } from "./types";

export interface ParsedJobEmail {
  subject: string;
  fromDomain: string | null;
  date: string | null;
  messageId: string | null;
  body: string;
  title: string | null;
  company: string | null;
  location: string | null;
  applyUrl: string | null;
  contactEmail: string | null;
  platform: JobPlatform;
}

const SENDER_PLATFORMS: [RegExp, JobPlatform][] = [
  [/naukri/i, "NAUKRI"],
  [/indeed/i, "INDEED"],
  [/instahyre/i, "INSTAHYRE"],
  [/linkedin/i, "LINKEDIN"],
  [/greenhouse/i, "GREENHOUSE"],
  [/lever/i, "LEVER"],
  [/workday/i, "WORKDAY"],
  [/ashby/i, "ASHBY"],
];

/** Job-alert digests attached as .eml ("Forward as attachment") that are read per email. */
const MAX_ATTACHED_EMAILS = 20;
const MAX_ALERT_JOBS = 50;

function labelled(body: string, labels: string[]): string | null {
  for (const label of labels) {
    // [ \t], not \s: with /m, "^\s*" runs across blank lines and goes quadratic on long runs of them.
    const m = body.match(new RegExp(`^[ \\t]*${label}[ \\t]*[:\\-–][ \\t]*(.+)$`, "im"));
    if (m?.[1]) return m[1].trim();
  }
  return null;
}

function parseSubject(subject: string): { title: string | null; company: string | null; location: string | null } {
  const s = subject
    .replace(/^\s*((fwd?|re)\s*:\s*)+/i, "")
    .replace(/^\s*(new\s+)?(job alert|jobs? for you|recommended job|job opportunity|hiring)\s*[:\-–|]\s*/i, "")
    .trim();
  // "Title | Company | Location"
  const pipe = s.split(/\s*\|\s*/);
  if (pipe.length >= 2) return { title: pipe[0] || null, company: pipe[1] || null, location: pipe[2] ?? null };
  // "Title at Company - Location" / "Title at Company"
  const at = s.match(/^(.+?)\s+(?:at|@)\s+(.+?)(?:\s+[-–(]\s*(.+?)\)?)?$/i);
  if (at) return { title: at[1]?.trim() ?? null, company: at[2]?.trim() ?? null, location: at[3]?.trim() ?? null };
  return { title: s || null, company: null, location: null };
}

/** Subject-derived hints, unless the subject is a digest intro or greets the reader ("Asha, 3 new jobs ..."). */
function subjectHints(subject: string): { title: string | null; company: string | null; location: string | null } {
  const none = { title: null, company: null, location: null };
  const s = subject.replace(/^\s*((fwd?|re)\s*:\s*)+/i, "").trim();
  if (INTRO.test(s) || /^\p{Lu}\p{Ll}+,\s/u.test(s)) return none;
  const hints = parseSubject(s);
  return hints.title && isTitleText(hints.title) ? hints : none;
}

/** The pieces of a pasted/uploaded email the connector works with. */
interface EmailParts {
  subject: string;
  fromAddress: string;
  date: Date | null;
  messageId: string | null;
  html: string | null;
  text: string | null;
  body: string;
  attachedEmails: Buffer[];
}

function mailParts(mail: ParsedMail): Omit<EmailParts, "body"> {
  const date = mail.date && !Number.isNaN(mail.date.getTime()) ? mail.date : null;
  return {
    subject: mail.subject ?? "",
    fromAddress: mail.from?.value?.[0]?.address ?? "",
    date,
    messageId: mail.messageId ?? null,
    html: typeof mail.html === "string" && mail.html ? mail.html : null,
    text: mail.text ? mail.text : null,
    attachedEmails: (mail.attachments ?? [])
      .filter((a) => a.contentType === "message/rfc822" && Buffer.isBuffer(a.content))
      .slice(0, MAX_ATTACHED_EMAILS)
      .map((a) => a.content),
  };
}

async function readEmail(raw: string): Promise<EmailParts> {
  const looksLikeEml = /^(from|subject|date|to|message-id|mime-version|received|return-path):/im.test(raw.slice(0, 2000));
  if (!looksLikeEml) {
    return {
      subject: labelled(raw, ["subject"]) ?? "",
      fromAddress: labelled(raw, ["from"]) ?? "",
      date: null,
      messageId: null,
      html: null,
      text: raw,
      body: raw,
      attachedEmails: [],
    };
  }
  const mail = await simpleParser(raw, { skipImageLinks: true, skipHtmlToText: false });
  const parts = mailParts(mail);
  // An empty text part (HTML-only mail) falls back to the HTML with its tags removed.
  const body = (mail.text || (typeof mail.html === "string" ? mail.html.replace(/<[^<>]*>/g, " ") : "")).trim();
  return { ...parts, body };
}

/**
 * Forwarded messages carry the original sender inside the body ("From: LinkedIn <jobalerts-noreply@linkedin.com>",
 * Outlook's "From: LinkedIn [mailto:...]"). Read like a header: a display name that looks like an
 * address never counts.
 */
function forwardedFrom(body: string): string {
  const m = /^[ \t]*From:[ \t]*(.{3,300})$/im.exec(body);
  if (!m) return "";
  let line = m[1]!;
  // HTML-to-text output breaks "Name <a@b" + "[a@b]>" over two lines.
  if (line.includes("<") && !line.includes(">")) line += body.slice(m.index + m[0].length, m.index + m[0].length + 302).split("\n", 2)[1] ?? "";
  // The body may be HTML with its tags removed, where the brackets are still "&lt;" / "&gt;".
  line = decodeHtmlEntities(line);
  // Outlook's "[mailto:a@b]" is the address; a "[a@b]" after an angle address only repeats a link target.
  const angle = /<\s*[^<>\s@]+@[^<>\s@]+/.test(line);
  line = line.replace(/\[(?:mailto:)?([^\]\s]+)\]/gi, (_, a: string) => (angle ? " " : `<${a}>`)).replace(/<\s*mailto:/gi, "<");
  return senderAddress(line) ?? "";
}

function toParsedJobEmail(parts: EmailParts): ParsedJobEmail {
  const { subject, fromAddress, body } = parts;
  const forwarded = forwardedFrom(body);
  const senderForPlatform = `${fromAddress} ${forwarded}`;
  const fromDomain = (forwarded || fromAddress).split("@")[1]?.toLowerCase() ?? null;

  const subj = subjectHints(labelled(body, ["subject"]) && !subject ? (labelled(body, ["subject"]) as string) : subject);
  const urls = extractUrls(body);
  const applyUrl =
    labelled(body, ["apply(?: here| at| link| now)?", "application link", "job link"])?.match(/https?:\/\/\S+/)?.[0] ??
    urls.find((u) => /apply|job|career|greenhouse|lever|workday|ashby/i.test(u)) ??
    null;

  // An explicitly labelled HR / hiring contact, else an address the email asks applications to be sent to. A bare
  // "Email:" line or any address that merely looks like HR is not an application contact.
  const labelledContact = labelled(body, [
    "hr e-?mail(?: id| address)?",
    "hiring e-?mail(?: id| address)?",
    "recruiter(?:'s)? e-?mail(?: id| address)?",
    "contact e-?mail(?: id| address)?",
    "e-?mail your (?:resume|cv|application) to",
    "send (?:your )?(?:cv|resume|application) to",
  ])
    ?.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]
    ?.toLowerCase()
    .replace(/[.,;]+$/, "");
  const contactEmail = (labelledContact && !isNonApplicationAddress(labelledContact) ? labelledContact : null) ?? applicationContactEmail(body);

  let platform: JobPlatform = "OTHER";
  for (const [re, p] of SENDER_PLATFORMS) if (re.test(senderForPlatform)) platform = p;
  if (platform === "OTHER") platform = detectPlatformFromUrl(applyUrl) ?? "OTHER";

  return {
    subject,
    fromDomain,
    date: parts.date ? parts.date.toISOString() : null,
    messageId: parts.messageId,
    body,
    title: labelled(body, ["job title", "title", "role", "position"]) ?? subj.title,
    company: labelled(body, ["company", "organisation", "organization", "employer"]) ?? subj.company,
    location: labelled(body, ["location", "job location", "locations"]) ?? subj.location,
    applyUrl,
    contactEmail,
    platform,
  };
}

/** Parse a forwarded job-alert email (.eml RFC822 or plain text). */
export async function parseJobEmail(raw: string): Promise<ParsedJobEmail> {
  return toParsedJobEmail(await readEmail(raw));
}

/** The original sender after a "Forwarded message" marker (Gmail, Outlook), else the first From: line. */
function originalSender(parts: Pick<EmailParts, "body" | "text">): string {
  // The forward header sits at the top; bounded input and quantifiers keep the search linear.
  const source = (parts.text ?? parts.body).slice(0, 20_000);
  const marker = /-{2,20}\s?(?:forwarded message|original message)\s?-{2,20}|^begin forwarded message:/im.exec(source);
  const after = marker ? source.slice(marker.index, marker.index + 3000) : "";
  return forwardedFrom(after) || forwardedFrom(source);
}

/**
 * Jobs from a job-alert digest: known alert senders (directly or forwarded), plus pasted alerts
 * whose links clearly point at one job site. Returns [] for anything else.
 */
function alertJobs(parts: Omit<EmailParts, "body" | "attachedEmails"> & { body?: string }): RawImportedJob[] {
  const mail: AlertEmail = { from: parts.fromAddress, subject: parts.subject, html: parts.html, text: parts.text, date: parts.date, messageId: parts.messageId };
  // A job site's own mail follows that site's rules (messages, invitations and application updates
  // give no jobs) and never falls back to guessing from its links.
  const direct = parseJobAlertEmail(mail);
  if (direct.platform) return direct.jobs;
  const forwarded = originalSender({ body: parts.body ?? parts.text ?? "", text: parts.text });
  const viaForward = forwarded ? parseJobAlertEmail({ ...mail, from: forwarded }) : null;
  if (viaForward?.platform) return viaForward.jobs;
  // Pasted alert without headers: several job links to one site are enough (user-provided content).
  const platform = detectAlertPlatformFromLinks(parts.html, parts.text);
  if (!platform) return [];
  const jobs = parseJobAlertEmailAs(mail, platform).jobs;
  return jobs.length >= 2 ? jobs : [];
}

async function alertJobsFromEmail(parts: EmailParts): Promise<RawImportedJob[]> {
  const jobs = [...alertJobs(parts)];
  for (const attached of parts.attachedEmails) {
    try {
      jobs.push(...alertJobs(mailParts(await simpleParser(attached, { skipImageLinks: true }))));
    } catch {
      // An unreadable attachment is skipped; the rest of the email still imports.
    }
  }
  const seen = new Set<string>();
  return jobs
    .filter((j) => {
      const key = j.externalId ?? j.sourceUrl ?? "";
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_ALERT_JOBS)
    .map((j) => ({
      ...j,
      importMethod: "USER_FORWARDED_EMAIL" as const,
      attribution: j.attribution.replace(/ job alert \(your email\)$/, " job alert (forwarded)"),
    }));
}

/**
 * Jobs from a raw email (RFC 822 text) that is, forwards, or attaches job-alert digests. Used for the
 * private forwarding address, where hand-forwarded alerts arrive with the user as the sender.
 * Returns [] for anything that is not a job alert (never falls back to single-job parsing).
 */
export async function parseAlertJobsFromRawEmail(raw: string): Promise<RawImportedJob[]> {
  try {
    return await alertJobsFromEmail(await readEmail(raw));
  } catch {
    return [];
  }
}

/** 4. User-forwarded job-alert email. Only job content is kept - never the user's inbox. */
export const forwardedEmailConnector: JobSourceConnector = {
  provider: "OTHER",
  importMethod: "USER_FORWARDED_EMAIL",
  integrationClass: "user_forwarded_email",
  description: "Paste or upload a job-alert email you received (.eml or text). Digests import every job.",
  isConfigured: () => true,
  async importJobs(input: ImportInput): Promise<RawImportedJob[]> {
    const raw = (input.payload as { raw?: string } | null)?.raw;
    if (typeof raw !== "string" || raw.trim().length < 20) throw new ConnectorInputError("Email content is required.");
    const parts = await readEmail(raw);

    // Job-alert emails from known senders (LinkedIn, Indeed, Naukri, ...): one job per card.
    const alerts = await alertJobsFromEmail(parts);
    if (alerts.length > 0) return alerts;

    const parsed = toParsedJobEmail(parts);
    if (parsed.body.length < 20) throw new ConnectorInputError("The email does not contain a job description.");
    return [
      {
        provider: parsed.platform,
        importMethod: "USER_FORWARDED_EMAIL",
        externalId: parsed.messageId,
        sourceUrl: parsed.applyUrl,
        attribution: `Forwarded job alert${parsed.fromDomain ? ` from ${parsed.fromDomain}` : ""}`,
        // Minimal metadata only: no subject (it often names the recipient), no addresses, no headers.
        raw: {
          kind: "forwarded_email",
          fromDomain: parsed.fromDomain,
          date: parsed.date,
          messageId: parsed.messageId,
        },
        text: parsed.body,
        hints: {
          platform: parsed.platform,
          title: parsed.title ?? undefined,
          company: parsed.company ?? undefined,
          location: parsed.location ?? undefined,
          applyUrl: parsed.applyUrl ?? undefined,
          hrEmail: parsed.contactEmail ?? undefined,
          postedAt: parsed.date ?? undefined,
        },
      },
    ];
  },
  normalize: normalizeRawJob,
};
