import type { Browser, BrowserContext, Page, Route } from "playwright-core";
import { SubmitButtonNotFoundError, type BrowserChallenge, type BrowserDriver, type BrowserField, type BrowserFile, type BrowserSession } from "./driver";

/**
 * Playwright + Chromium implementation of the browser seam (worker process only).
 *
 * Deliberately plain: default user agent, no stealth plugins, no fingerprint spoofing, no proxy rotation and no
 * attempt to interact with CAPTCHAs, MFA prompts or sign-in forms - detectChallenge() only reports them. Each
 * application gets its own browser + context, closed afterwards, so nothing (cookies, storage) is shared or kept.
 * Page scripts are passed as plain-JS strings so no transpiler helper can leak into the page.
 */

export interface PlaywrightDriverOptions {
  headless: boolean;
  /** Navigation / action timeout (BROWSER_EXECUTOR_TIMEOUT_MS). */
  timeoutMs: number;
}

const FIELD_ATTR = "data-applywise-field";
const OPTION_ATTR = "data-applywise-option";

/** Reports (never touches) CAPTCHA widgets, one-time-code inputs and sign-in forms. */
const DETECT_CHALLENGE_SCRIPT = String.raw`(() => {
  const has = (s) => document.querySelector(s) !== null;
  const text = ((document.body && document.body.innerText) || "").toLowerCase();
  const captcha = 'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"], iframe[src*="challenges.cloudflare.com"], .g-recaptcha, .h-captcha, .cf-turnstile, [data-sitekey]';
  if (has(captcha) || /verify (that )?you are (a )?human|i'?m not a robot/.test(text)) return "CAPTCHA";
  const inputs = Array.from(document.querySelectorAll("input"));
  if (has('input[autocomplete="one-time-code"]') || inputs.some((i) => /(^|[\s_-])(otp|mfa|2fa|totp)([\s_-]|$)|one[\s_-]?time|verification[\s_-]?code/i.test((i.name || "") + " " + (i.id || "")))) return "MFA";
  if (has('input[type="password"]')) return "LOGIN_REQUIRED";
  const forms = Array.from(document.querySelectorAll("form"));
  if (forms.length > 0 && forms.every((f) => /(^|\/)(login|signin|sign-in|sso)(\/|\?|$)/i.test(f.getAttribute("action") || ""))) return "LOGIN_REQUIRED";
  return null;
})()`;

/** Lists fillable fields and tags them with a stable index attribute. */
const LIST_FIELDS_SCRIPT = String.raw`(() => {
  const FIELD = "${FIELD_ATTR}";
  const OPTION = "${OPTION_ATTR}";
  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
  const labelText = (el) => {
    let label = "";
    if (el.id) {
      const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (l) label = l.textContent || "";
    }
    if (!clean(label)) {
      const l = el.closest("label");
      if (l) {
        const copy = l.cloneNode(true);
        copy.querySelectorAll("input, select, textarea, option").forEach((n) => n.remove());
        label = copy.textContent || "";
      }
    }
    if (!clean(label)) label = el.getAttribute("aria-label") || "";
    if (!clean(label) && el.getAttribute("aria-labelledby")) {
      label = el.getAttribute("aria-labelledby").split(/\s+/).map((id) => (document.getElementById(id) || {}).textContent || "").join(" ");
    }
    if (!clean(label)) label = el.getAttribute("placeholder") || el.getAttribute("name") || "";
    return clean(label);
  };
  const out = [];
  const radioGroups = new Map();
  let index = 0;
  for (const el of Array.from(document.querySelectorAll("input, select, textarea"))) {
    const tag = el.tagName.toLowerCase();
    const type = tag === "select" ? "select" : tag === "textarea" ? "textarea" : (el.getAttribute("type") || "text").toLowerCase();
    if (["hidden", "submit", "button", "reset", "image", "password"].includes(type) || el.disabled) continue;
    const style = window.getComputedStyle(el);
    if (type !== "file" && (style.display === "none" || style.visibility === "hidden")) continue;
    if (type === "radio") {
      const key = el.name || "radio-" + index;
      let group = radioGroups.get(key);
      if (!group) {
        const fieldset = el.closest("fieldset");
        const legend = fieldset && fieldset.querySelector("legend");
        group = { index: index++, label: clean(legend ? legend.textContent : el.name), name: el.name || null, type: "radio", required: false, options: [] };
        radioGroups.set(key, group);
        out.push(group);
      }
      el.setAttribute(FIELD, String(group.index));
      el.setAttribute(OPTION, String(group.options.length));
      group.options.push(labelText(el));
      group.required = group.required || el.required;
      continue;
    }
    let label = labelText(el);
    const required = el.required || el.getAttribute("aria-required") === "true" || /\*\s*$/.test(label);
    label = label.replace(/\s*\*\s*$/, "").trim();
    const options = tag === "select" ? Array.from(el.options).map((o) => clean(o.textContent)).filter(Boolean) : null;
    el.setAttribute(FIELD, String(index));
    out.push({ index: index++, label, name: el.getAttribute("name"), type, required, options });
  }
  for (const g of out) if (g.type === "radio") g.label = g.label.replace(/\s*\*\s*$/, "").trim();
  return out;
})()`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class PlaywrightSession implements BrowserSession {
  private readonly types = new Map<number, BrowserField>();
  private closed = false;

  constructor(
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    private readonly page: Page,
  ) {}

  private field(index: number) {
    return this.page.locator(`[${FIELD_ATTR}="${index}"]`);
  }

  async goto(url: string): Promise<void> {
    await this.page.goto(url, { waitUntil: "domcontentloaded" });
    // Client-rendered forms attach their handlers after hydration.
    await this.page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
  }

  currentUrl(): string {
    return this.page.url();
  }

  async detectChallenge(): Promise<BrowserChallenge | null> {
    const found = (await this.page.evaluate(DETECT_CHALLENGE_SCRIPT)) as BrowserChallenge | null;
    return found === "CAPTCHA" || found === "MFA" || found === "LOGIN_REQUIRED" ? found : null;
  }

  async listFields(): Promise<BrowserField[]> {
    const fields = (await this.page.evaluate(LIST_FIELDS_SCRIPT)) as BrowserField[];
    this.types.clear();
    for (const f of fields) this.types.set(f.index, f);
    return fields;
  }

  async fill(index: number, value: string): Promise<void> {
    const meta = this.types.get(index);
    const loc = this.field(index);
    switch (meta?.type) {
      case "select":
        await loc.selectOption({ label: value });
        return;
      case "checkbox":
        await loc.first().setChecked(/^(yes|true|1|on|checked)$/i.test(value.trim()));
        return;
      case "radio": {
        const option = (meta.options ?? []).findIndex((o) => o.trim().toLowerCase() === value.trim().toLowerCase());
        if (option === -1) throw new Error("Radio option not found");
        await this.page.locator(`[${FIELD_ATTR}="${index}"][${OPTION_ATTR}="${option}"]`).check();
        return;
      }
      default:
        await loc.fill(value);
    }
  }

  async upload(index: number, file: BrowserFile): Promise<void> {
    await this.field(index).setInputFiles({ name: file.fileName, mimeType: file.mimeType, buffer: Buffer.from(file.content) });
  }

  async submit(selectors: string[]): Promise<void> {
    for (const selector of selectors) {
      const candidates = this.page.locator(selector);
      const count = await candidates.count();
      for (let i = 0; i < count; i++) {
        const button = candidates.nth(i);
        if (await button.isVisible()) {
          // The employer form's own submit button - only ever reached through the execution service.
          await button.click();
          return;
        }
      }
    }
    throw new SubmitButtonNotFoundError();
  }

  async readConfirmation(patterns: RegExp[], timeoutMs: number): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const text = await this.page
        .locator("body")
        .innerText({ timeout: 2_000 })
        .catch(() => "");
      for (const pattern of patterns) {
        const m = pattern.exec(text);
        if (m) {
          const start = text.lastIndexOf("\n", m.index) + 1;
          const end = text.indexOf("\n", m.index);
          return text.slice(start, end === -1 ? undefined : end).trim().slice(0, 300);
        }
      }
      if (Date.now() >= deadline) return null;
      await sleep(500);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.context.close().catch(() => undefined);
    await this.browser.close().catch(() => undefined);
  }
}

/**
 * Blocks main-frame navigations (script redirects, links, form posts) to URLs the adapter does not allow, before
 * the request leaves the worker. Sub-resources and iframes (CDNs, CAPTCHA widgets) are left alone: the flow detects
 * challenges and only ever fills and submits the main frame. HTTP redirects are followed inside the network stack
 * (Playwright does not route them), which is why the flow re-checks the page URL after every navigation.
 */
function guardNavigations(page: Page, allowUrl: (url: URL) => boolean) {
  return async (route: Route) => {
    const request = route.request();
    let mainFrameNavigation = false;
    try {
      mainFrameNavigation = request.isNavigationRequest() && request.frame() === page.mainFrame();
    } catch {
      // Service-worker requests have no frame: not a navigation of the application page.
    }
    if (!mainFrameNavigation) return route.continue();
    let allowed = false;
    try {
      const url = new URL(request.url());
      allowed = (url.protocol === "https:" || url.protocol === "http:") && allowUrl(url);
    } catch {
      allowed = false;
    }
    return allowed ? route.continue() : route.abort("blockedbyclient");
  };
}

export function createPlaywrightDriver(opts: PlaywrightDriverOptions): BrowserDriver {
  return {
    async newSession({ signal, allowUrl }) {
      // Lazy: playwright-core (and a Chromium binary) are only needed when the browser executor actually runs.
      const { chromium } = await import("playwright-core");
      const browser = await chromium.launch({ headless: opts.headless, timeout: opts.timeoutMs });
      try {
        const context = await browser.newContext({ acceptDownloads: false });
        context.setDefaultTimeout(opts.timeoutMs);
        context.setDefaultNavigationTimeout(opts.timeoutMs);
        const page = await context.newPage();
        if (allowUrl) await page.route("**/*", guardNavigations(page, allowUrl));
        const session = new PlaywrightSession(browser, context, page);
        signal?.addEventListener("abort", () => void session.close(), { once: true });
        return session;
      } catch (e) {
        await browser.close().catch(() => undefined);
        throw e;
      }
    },
  };
}
