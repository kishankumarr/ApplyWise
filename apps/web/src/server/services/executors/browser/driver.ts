/**
 * Browser automation seam used by the BROWSER executor (worker-side only, never the user's browser).
 *
 * The flow (flow.ts) only talks to these interfaces, so it is unit-tested with a fake session; the real
 * implementation is playwright-driver.ts (Playwright + Chromium). A session never interacts with CAPTCHAs,
 * MFA prompts or sign-in forms: detectChallenge() reports them and the flow hands the application to the user.
 */

/** A barrier automation must never try to pass. */
export type BrowserChallenge = "CAPTCHA" | "MFA" | "LOGIN_REQUIRED";

export interface BrowserField {
  /** Stable index for fill()/upload() within the current page. */
  index: number;
  /** Visible label (label element, aria-label, placeholder or name, in that order). */
  label: string;
  name: string | null;
  /** input type ("text", "email", "file", "checkbox", ...), "select" or "textarea". */
  type: string;
  required: boolean;
  /** Option labels for select fields. */
  options: string[] | null;
}

export interface BrowserFile {
  fileName: string;
  mimeType: string;
  content: Uint8Array;
}

export interface BrowserSession {
  goto(url: string): Promise<void>;
  /** The main frame's current URL (after redirects and script navigations). */
  currentUrl(): string;
  detectChallenge(): Promise<BrowserChallenge | null>;
  listFields(): Promise<BrowserField[]>;
  fill(index: number, value: string): Promise<void>;
  upload(index: number, file: BrowserFile): Promise<void>;
  /** Press the form's own submit button (first visible match of the adapter's selectors). Throws when none exists. */
  submit(selectors: string[]): Promise<void>;
  /** Wait until the page text matches one of the patterns; returns the matching text, or null on timeout. */
  readConfirmation(patterns: RegExp[], timeoutMs: number): Promise<string | null>;
  close(): Promise<void>;
}

export interface BrowserSessionOptions {
  signal?: AbortSignal;
  /**
   * Main-frame navigations to a URL this rejects are blocked before the request is sent (script navigations, links,
   * form posts). HTTP redirects are followed by the network stack, so the flow also re-checks currentUrl().
   */
  allowUrl?: (url: URL) => boolean;
}

export interface BrowserDriver {
  /** One isolated browser context per application (no shared cookies or storage between applications). */
  newSession(opts: BrowserSessionOptions): Promise<BrowserSession>;
}

/** Thrown when no submit button matched; nothing was submitted. */
export class SubmitButtonNotFoundError extends Error {
  constructor() {
    super("No submit button found on the application page");
    this.name = "SubmitButtonNotFoundError";
  }
}
