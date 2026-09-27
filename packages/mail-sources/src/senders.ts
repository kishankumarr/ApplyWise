/**
 * A plain domain or address; anything else is dropped so it cannot change the meaning of a search query.
 * Labels and the local part start with a letter or digit: a leading "-" negates a Gmail search term.
 */
const SENDER_RE = /^(?:[a-z0-9][a-z0-9._%+-]*@)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const MAX_SENDERS = 60;

/** Lowercased, de-duplicated sender filters ("naukri.com", "jobalerts-noreply@linkedin.com"). */
export function normalizeSenders(list: readonly string[]): string[] {
  const out = new Set<string>();
  for (const raw of list) {
    const s = raw.trim().toLowerCase().replace(/^@/, "");
    if (s.length <= 254 && SENDER_RE.test(s)) out.add(s);
  }
  return [...out].slice(0, MAX_SENDERS);
}

/** Address filter: exact match for full addresses, the domain or a subdomain of it otherwise. */
export function matchesSender(address: string, senders: readonly string[]): boolean {
  const a = address.trim().toLowerCase();
  const at = a.lastIndexOf("@");
  if (at < 1) return false;
  const domain = a.slice(at + 1);
  return senders.some((s) => (s.includes("@") ? a === s : domain === s || domain.endsWith(`.${s}`)));
}

/** Gmail search syntax (API `q` and IMAP X-GM-RAW): from:(a OR b) after:<unix seconds>. */
export function gmailQuery(senders: readonly string[], since: Date): string {
  const secs = Math.floor(since.getTime() / 1000);
  // An invalid Date would produce "after:NaN", which Gmail rejects with HTTP 400.
  return `from:(${senders.join(" OR ")}) after:${Number.isFinite(secs) ? Math.max(0, secs) : 0}`;
}
