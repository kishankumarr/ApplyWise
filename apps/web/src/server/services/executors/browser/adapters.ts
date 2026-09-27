import type { ProviderEnv } from "@applywise/job-engine";

/**
 * Browser adapters: which application pages the BROWSER executor may drive, how to find the form's own submit
 * button and how to recognise the provider's confirmation.
 *
 *  - demo-ats: the local DEMO CONTENT career pages served by this app under /demo/ats/ (APP_URL origin only).
 *  - greenhouse / lever / ashby: EXPERIMENTAL, not validated against the live providers. They only run when the
 *    operator enables the browser executor AND lists the provider in BROWSER_EXECUTOR_PROVIDERS. A CAPTCHA, MFA
 *    prompt or sign-in wall on any of them always ends in a manual handoff.
 */

export interface BrowserAdapter {
  /** Executor id suffix: "browser:<id>". */
  id: string;
  label: string;
  /** The application provider (packages/job-engine providers) this adapter belongs to. */
  providerId: string;
  experimental: boolean;
  matches(url: URL, env: ProviderEnv): boolean;
  /** Tried in order; the first visible match is pressed. */
  submitSelectors: string[];
  confirmationPatterns: RegExp[];
  /** Provider reference shown in the confirmation, if any. */
  extractReference(confirmation: string): string | null;
}

const DEFAULT_APP_URL = "http://localhost:3000";

function appOrigin(env: ProviderEnv): string | null {
  try {
    return new URL(env.APP_URL || DEFAULT_APP_URL).origin;
  } catch {
    return null;
  }
}

const hostIs = (url: URL, ...hosts: string[]) => hosts.some((h) => url.hostname === h || url.hostname.endsWith(`.${h}`));

export const demoAtsAdapter: BrowserAdapter = {
  id: "demo-ats",
  label: "Demo career page",
  providerId: "demo",
  experimental: false,
  matches: (url, env) => url.origin === appOrigin(env) && url.pathname.startsWith("/demo/ats/"),
  submitSelectors: ['form[data-demo-ats] button[type="submit"]', 'button[type="submit"]'],
  confirmationPatterns: [/Application received/i],
  extractReference: (text) => /\b(DEMO-[A-Z0-9]+)\b/i.exec(text)?.[1]?.toUpperCase() ?? null,
};

export const greenhouseAdapter: BrowserAdapter = {
  id: "greenhouse",
  label: "Greenhouse (experimental)",
  providerId: "greenhouse",
  experimental: true,
  matches: (url) => hostIs(url, "boards.greenhouse.io", "job-boards.greenhouse.io", "job-boards.eu.greenhouse.io"),
  submitSelectors: ["#submit_app", 'button[type="submit"]', 'input[type="submit"]'],
  confirmationPatterns: [/thank you for applying/i, /application (has been )?(submitted|received)/i],
  extractReference: () => null,
};

export const leverAdapter: BrowserAdapter = {
  id: "lever",
  label: "Lever (experimental)",
  providerId: "lever",
  experimental: true,
  matches: (url) => hostIs(url, "jobs.lever.co", "jobs.eu.lever.co"),
  submitSelectors: ["#btn-submit", 'button[type="submit"]'],
  confirmationPatterns: [/application submitted/i, /thanks? (you )?for applying/i],
  extractReference: () => null,
};

export const ashbyAdapter: BrowserAdapter = {
  id: "ashby",
  label: "Ashby (experimental)",
  providerId: "ashby",
  experimental: true,
  matches: (url) => hostIs(url, "jobs.ashbyhq.com"),
  submitSelectors: ["button.ashby-application-form-submit-button", 'button[type="submit"]'],
  confirmationPatterns: [/application (was )?(successfully )?submitted/i, /thanks? (you )?for applying/i],
  extractReference: () => null,
};

export const BROWSER_ADAPTERS: readonly BrowserAdapter[] = [demoAtsAdapter, greenhouseAdapter, leverAdapter, ashbyAdapter];

/** BROWSER_EXECUTOR_PROVIDERS (comma separated), default "demo" - mirrors apps/web/src/env.ts. */
export function browserExecutorProviders(env: ProviderEnv): string[] {
  const raw = env.BROWSER_EXECUTOR_PROVIDERS;
  const list = raw ? raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean) : [];
  return list.length ? list : ["demo"];
}

/** The adapter for this apply URL, only when the operator enabled browser automation for its provider. */
export function findBrowserAdapter(applyUrl: string | null, providerId: string, env: ProviderEnv): BrowserAdapter | null {
  if (!applyUrl) return null;
  let url: URL;
  try {
    url = new URL(applyUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const allowed = browserExecutorProviders(env);
  return BROWSER_ADAPTERS.find((a) => a.providerId === providerId && allowed.includes(a.providerId) && a.matches(url, env)) ?? null;
}

export function browserAdapterById(id: string): BrowserAdapter | null {
  return BROWSER_ADAPTERS.find((a) => a.id === id) ?? null;
}
