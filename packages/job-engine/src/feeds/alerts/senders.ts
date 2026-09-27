import type { JobPlatform } from "@applywise/types";

/**
 * Known job-alert senders. The From domain is matched ANCHORED ("linkedin.com" or a subdomain of
 * it), never as a substring, so look-alikes such as linkedin.com.evil.test are rejected.
 */

export interface AlertSender {
  platform: JobPlatform;
  /** Shown in attributions, e.g. "LinkedIn job alert (your email)". */
  label: string;
  domains: string[];
  /** Local parts that send job mail; when set, other addresses on the domain are notifications. */
  jobLocalParts?: RegExp;
}

export const ALERT_SENDERS: AlertSender[] = [
  // LinkedIn also sends messages, invitations, InMail and feed digests from the same domain: only these are job mail.
  { platform: "LINKEDIN", label: "LinkedIn", domains: ["linkedin.com"], jobLocalParts: /^(jobalerts-noreply|jobs-listings|jobs-noreply|jobalerts|jobs)$/ },
  { platform: "INDEED", label: "Indeed", domains: ["indeed.com"] },
  { platform: "NAUKRI", label: "Naukri", domains: ["naukri.com"] },
  { platform: "FOUNDIT", label: "Foundit", domains: ["foundit.in", "monsterindia.com"] },
  { platform: "INSTAHYRE", label: "Instahyre", domains: ["instahyre.com"] },
  { platform: "CUTSHORT", label: "Cutshort", domains: ["cutshort.io"] },
  { platform: "WELLFOUND", label: "Wellfound", domains: ["wellfound.com", "angel.co"] },
  { platform: "GLASSDOOR", label: "Glassdoor", domains: ["glassdoor.com", "glassdoor.co.in"] },
  { platform: "HIRIST", label: "Hirist", domains: ["hirist.tech", "hirist.com"] },
  { platform: "HIRIST", label: "iimjobs", domains: ["iimjobs.com"] },
];

/**
 * Senders to search the mailbox for (IMAP FROM / Gmail from:). Bare domains match every address on
 * them; LinkedIn is narrowed to its job-mail addresses so private messages and invitations are never
 * downloaded.
 */
export const JOB_ALERT_SENDER_DOMAINS: string[] = [
  "jobalerts-noreply@linkedin.com",
  "jobs-listings@linkedin.com",
  "jobs-noreply@linkedin.com",
  "indeed.com",
  "naukri.com",
  "foundit.in",
  "monsterindia.com",
  "instahyre.com",
  "cutshort.io",
  "wellfound.com",
  "glassdoor.com",
  "glassdoor.co.in",
  "hirist.tech",
  "hirist.com",
  "iimjobs.com",
];

/** The mailbox address of a From header ("Name <a@b.c>" or "a@b.c"), lowercased, or null. */
export function senderAddress(from: unknown): string | null {
  if (typeof from !== "string" || from.length > 1000) return null;
  // A display name can itself hold "<address>" ('"<jobalerts-noreply@linkedin.com>" <x@evil.test>'):
  // quoted strings and comments are dropped, and two different addresses left over are ambiguous.
  const s = from.replace(/"(?:[^"\\]|\\.)*"/g, " ").replace(/\((?:[^()\\]|\\.)*\)/g, " ");
  const all = new Set((s.match(/[^<>\s@"'(),;:]+@[^<>\s@"'(),;:]+/g) ?? []).map((a) => a.toLowerCase().replace(/\.+$/, "")));
  if (all.size > 1) return null;
  const angle = /<\s*([^<>\s@]+@[^<>\s@]+)\s*>/.exec(s)?.[1];
  const bare = angle ?? /(?:^|[\s:;,"'(])([^<>\s@"'(),;:]+@[^<>\s@"'(),;:]+)\s*$/.exec(s.trim())?.[1];
  const address = bare?.toLowerCase().replace(/\.+$/, "");
  return address && /^[^@\s]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(address) ? address : null;
}

function domainMatches(domain: string, base: string): boolean {
  return domain === base || domain.endsWith(`.${base}`);
}

export interface SenderMatch {
  sender: AlertSender;
  address: string;
  domain: string;
  /** False for notification addresses on a job site's domain (LinkedIn messages, invitations, ...). */
  jobMail: boolean;
}

export function matchAlertSender(from: unknown): SenderMatch | null {
  const address = senderAddress(from);
  if (!address) return null;
  const at = address.lastIndexOf("@");
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  for (const sender of ALERT_SENDERS) {
    if (!sender.domains.some((d) => domainMatches(domain, d))) continue;
    return { sender, address, domain, jobMail: !sender.jobLocalParts || sender.jobLocalParts.test(local) };
  }
  return null;
}

/** True when `from` is a job-alert sender we can parse (anchored domain match). */
export function isJobAlertSender(from: string): boolean {
  return matchAlertSender(from)?.jobMail === true;
}

/** Gmail search / filter query for the forwarding setup: from:(linkedin.com OR naukri.com OR ...). */
export function buildMailFilterQuery(domains: string[] = JOB_ALERT_SENDER_DOMAINS): string {
  const clean = [
    ...new Set(
      (Array.isArray(domains) ? domains : [])
        .map((d) => (typeof d === "string" ? d.trim().toLowerCase().replace(/^@/, "") : ""))
        // Labels and the local part start with a letter or digit: a leading "-" negates a Gmail search term.
        .filter((d) => d.length <= 254 && /^(?:[a-z0-9][a-z0-9._%+-]*@)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(d)),
    ),
  ];
  return clean.length ? `from:(${clean.join(" OR ")})` : "";
}
