/**
 * Which email address (if any) a job posting asks applications to be sent to.
 *
 * An address is an application contact only when the posting uses it in an application context: the "How to apply"
 * section, or a sentence that asks for applications ("send your resume/CV to ...", "email your application to ...",
 * "apply by email: ...", "interested candidates can write to ..."). Any other address in the text (a fraud-report,
 * privacy, accessibility or support contact, an alert sender, a footer address) is never an application contact, and
 * nothing falls back to "the first address in the text". Used by the job-description parser (Job.hrEmail), the
 * forwarded-email connector, the AI job parser's hrEmail check and the send-time check of automatic email
 * applications (emailApplicationRequested).
 */

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

/** Addresses that never receive applications (automated senders and non-recruiting contacts). */
const NON_APPLICATION_ADDRESS_RE =
  /noreply|no-reply|donotreply|do-not-reply|alerts?@|notifications?@|notify@|mailer-daemon|postmaster|bounce|fraud|scam|phish|abuse|privacy|gdpr|security|support|accessib|accommodat|unsubscribe/i;

/** A sentence about fraud, privacy, accessibility, support or a warning never names the application address. */
const NON_APPLICATION_CONTEXT_RE =
  /\b(?:fraud\w*|scam\w*|phishing|impersonat\w*|suspicious|unsubscribe|privacy|gdpr|data protection|personal data|accommodations?|accessib\w*|disabilit\w*|complaints?|grievances?|abuse|support|never (?:ask|request|charge)|do not send|don't send|not be (?:accepted|considered)|will not (?:accept|consider)|not accepted)\b/i;

const DOCUMENT = String.raw`(?:resumes?|résumés?|cvs?|c\.v\.?|curriculum vitae|applications?|profiles?|portfolios?|candidature|biodata)`;
const SEND_VERB = String.raw`(?:apply|applying|send|sending|sent|e-?mail|e-?mailing|mail|mailing|forward|forwarding|submit|submitting|share|sharing|drop)`;
const ADDRESS = String.raw`[A-Z0-9._%+-]+@`;

/** Sentences that ask for applications (the address must be in the same sentence). */
const APPLICATION_REQUEST_RES: RegExp[] = [
  // "Send your resume to ...", "Email your CV and portfolio to ...", "Please share your profile at ..."
  new RegExp(String.raw`\b${SEND_VERB}\b[^\n]{0,60}?\b${DOCUMENT}(?![a-z])`, "i"),
  // "Resumes to hr@...", "Applications at jobs@..."
  new RegExp(String.raw`\b${DOCUMENT}\s*(?:to|at|on)\s*:?\s*${ADDRESS}`, "i"),
  // "Apply by email", "Apply via e-mail: ..."
  /\bapply\b[^\n]{0,30}?\b(?:by|via|through|over|using|with an?)\s+e-?mail\b/i,
  // "Apply at hr@...", "Apply: hr@..."
  new RegExp(String.raw`\bapply(?:\s+(?:now|here))?\s*(?:to|at|on|:|-)\s*${ADDRESS}`, "i"),
  // "Interested candidates can email / write to hr@..."
  /\binterested\b[^\n]{0,60}?\b(?:e-?mail|write|send|share|mail|reach out)\b/i,
];

/** True for addresses that never receive applications (noreply, alerts, fraud/privacy/security/support contacts...). */
export function isNonApplicationAddress(email: string): boolean {
  return NON_APPLICATION_ADDRESS_RE.test(email);
}

function addressesIn(text: string): string[] {
  return [...new Set((text.match(EMAIL_RE) ?? []).map((e) => e.toLowerCase().replace(/[.,;]+$/, "")))];
}

/** Lines, then sentences ("... to hr@acme.com. Report fraud to ..." splits after the address). */
function sentences(text: string): string[] {
  return text
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?;])\s+(?=[^\s])/))
    .map((s) => s.trim())
    .filter(Boolean);
}

function applicationAddressesIn(sentence: string, anySentence: boolean): string[] {
  if (NON_APPLICATION_CONTEXT_RE.test(sentence)) return [];
  if (!anySentence && !APPLICATION_REQUEST_RES.some((re) => re.test(sentence))) return [];
  return addressesIn(sentence).filter((e) => !isNonApplicationAddress(e));
}

/**
 * Every application contact address in a job posting, in order: addresses in the "How to apply" section
 * (`applySection`, any sentence) first, then addresses in sentences of `text` that ask for applications.
 */
export function applicationContactEmails(text: string, applySection?: string | string[] | null): string[] {
  const found: string[] = [];
  const add = (list: string[]) => {
    for (const e of list) if (!found.includes(e)) found.push(e);
  };
  const section = Array.isArray(applySection) ? applySection.join("\n") : (applySection ?? "");
  for (const s of sentences(section)) add(applicationAddressesIn(s, true));
  for (const s of sentences(text ?? "")) add(applicationAddressesIn(s, false));
  return found;
}

/** The posting's application contact address (see applicationContactEmails), or null. Never "the first email". */
export function applicationContactEmail(text: string, applySection?: string | string[] | null): string | null {
  return applicationContactEmails(text, applySection)[0] ?? null;
}

/** Lower-case words and addresses only, for "does this text appear in that text" checks. */
function comparable(text: string): string {
  return ` ${(text ?? "").toLowerCase().replace(/[^a-z0-9@]+/g, " ").trim()} `;
}

/**
 * True only when the posting itself asks for applications to be emailed to `email`: the address is an application
 * contact of the description (an application-request sentence), or of `applicationInstructions` when those
 * instructions are literally part of the description (the parsed "How to apply" section). Instructions that are not
 * in the posting text (a model's paraphrase, a hint) never count on their own.
 */
export function emailApplicationRequested(description: string, applicationInstructions: string | null, email: string): boolean {
  const target = (email ?? "").trim().toLowerCase();
  if (!target || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(target) || isNonApplicationAddress(target)) return false;
  if (applicationContactEmails(description ?? "").includes(target)) return true;
  const instructions = (applicationInstructions ?? "").trim();
  if (!instructions) return false;
  const fromPosting = comparable(description).includes(comparable(instructions));
  return fromPosting && applicationContactEmails("", instructions).includes(target);
}
