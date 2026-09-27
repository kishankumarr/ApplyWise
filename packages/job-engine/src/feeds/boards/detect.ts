import type { BoardAdapter, BoardRef } from "../types";

/** Parse a pasted link; bare hosts ("jobs.lever.co/cred") are accepted. */
export function parseBoardUrl(input: string): URL | null {
  const value = input.trim();
  if (!value || /\s/.test(value)) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

export function detectBoardWith(adapters: BoardAdapter[], input: string): BoardRef | null {
  const url = parseBoardUrl(input);
  if (!url) return null;
  for (const adapter of adapters) {
    const slug = adapter.slugFromUrl(url);
    if (slug) return { provider: adapter.id, slug };
  }
  return null;
}

const ATS_ADVICE = (name: string) =>
  `${name} career sites have no public job feed, so ApplyWise can't follow this company automatically. ` +
  "Turn on the company's job alerts (or a job-site alert for it) and connect your mailbox, or open a job and import it with the ApplyWise browser extension.";

const JOB_SITE_ADVICE = (name: string) =>
  `${name} has no public job API and ApplyWise never scrapes it. ` +
  `Set up ${name} job-alert emails and connect your mailbox (or forward them), or import a job you have open with the ApplyWise browser extension.`;

const UNSUPPORTED: { name: string; host: RegExp; kind: "ats" | "site" }[] = [
  { name: "Keka", host: /(^|\.)keka\.com$/, kind: "ats" },
  { name: "Darwinbox", host: /(^|\.)darwinbox\.(in|com)$/, kind: "ats" },
  { name: "Freshteam", host: /(^|\.)freshteam\.com$/, kind: "ats" },
  { name: "Workday", host: /(^|\.)(myworkdayjobs|myworkdaysite|myworkday)\.com$/, kind: "ats" },
  { name: "Zoho Recruit", host: /(^|\.)zohorecruit\.(com|in|eu|com\.au|jp|ca|sa|uk)$/, kind: "ats" },
  { name: "SAP SuccessFactors", host: /(^|\.)successfactors\.(com|eu)$/, kind: "ats" },
  { name: "Oracle Taleo", host: /(^|\.)taleo\.net$/, kind: "ats" },
  { name: "iCIMS", host: /(^|\.)icims\.com$/, kind: "ats" },
  { name: "LinkedIn", host: /(^|\.)linkedin\.com$/, kind: "site" },
  { name: "Naukri", host: /(^|\.)naukri\.com$/, kind: "site" },
  { name: "Indeed", host: /(^|\.)indeed\.(com|co\.in|co\.uk|ca|com\.au)$/, kind: "site" },
  { name: "Foundit", host: /(^|\.)(foundit\.in|monsterindia\.com)$/, kind: "site" },
  { name: "Glassdoor", host: /(^|\.)glassdoor\.(com|co\.in|co\.uk)$/, kind: "site" },
  { name: "Instahyre", host: /(^|\.)instahyre\.com$/, kind: "site" },
  { name: "Wellfound", host: /(^|\.)(wellfound\.com|angel\.co)$/, kind: "site" },
  { name: "Cutshort", host: /(^|\.)cutshort\.io$/, kind: "site" },
  { name: "Hirist", host: /(^|\.)hirist\.(com|tech)$/, kind: "site" },
  { name: "iimjobs", host: /(^|\.)iimjobs\.com$/, kind: "site" },
];

/** Career portals and job sites with no open feed, with what the user can do instead. */
export function detectUnsupportedPortal(input: string): { name: string; advice: string } | null {
  const url = parseBoardUrl(input);
  if (!url) return null;
  const host = url.hostname.toLowerCase();
  const match = UNSUPPORTED.find((p) => p.host.test(host));
  if (!match) return null;
  return { name: match.name, advice: match.kind === "ats" ? ATS_ADVICE(match.name) : JOB_SITE_ADVICE(match.name) };
}
