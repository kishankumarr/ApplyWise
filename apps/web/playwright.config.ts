import { defineConfig, devices } from "@playwright/test";

const PORT = 3100;
export const E2E_BASE_URL = `http://localhost:${PORT}`;
export const E2E_DATABASE_URL = process.env.E2E_DATABASE_URL ?? "postgresql://applywise:applywise@localhost:5433/applywise_e2e";

/** Deterministic E2E environment: dedicated DB, inline queue, no AI, dev email outbox. */
export const E2E_ENV = {
  DATABASE_URL: E2E_DATABASE_URL,
  APP_URL: E2E_BASE_URL,
  AUTH_URL: E2E_BASE_URL,
  QUEUE_DRIVER: process.env.E2E_QUEUE_DRIVER ?? "inline",
  AI_DISABLED: "true",
  ANTHROPIC_API_KEY: "",
  RATE_LIMIT_ENABLED: "false",
  EMAIL_PROVIDER: "dev",
  EMAIL_OUTBOX_DIR: ".outbox-e2e",
  STORAGE_LOCAL_DIR: ".storage-e2e",
  ENABLE_DEMO_ADMIN: "false",
  LOG_LEVEL: "warn",
  // Forwarding address + signed inbound webhook are exercised end to end (no external network).
  INBOUND_EMAIL_DOMAIN: "in.applywise.test",
  INBOUND_EMAIL_SECRET: "e2e-inbound-secret-0123456789abcdef",
  FEEDS_SCHEDULER: "off",
  // Automation: runs only when a test asks for one (inline queue => they finish within the request).
  AUTOMATION_SCHEDULER: "off",
  // `next start` runs with NODE_ENV=production, where the fictional demo provider is off unless enabled explicitly.
  DEMO_PROVIDER_ENABLED: "true",
  // The worker-side browser executor (Playwright + Chromium inside the server process) submits the local
  // /demo/ats/* pages of the demo provider's browser-channel jobs; a CAPTCHA page ends in a manual handoff.
  BROWSER_EXECUTOR_ENABLED: "true",
  BROWSER_EXECUTOR_PROVIDERS: "demo",
  BROWSER_EXECUTOR_HEADLESS: "true",
};

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [["list"], ["html", { open: "never" }]],
  globalSetup: "./e2e/global-setup.ts",
  use: {
    baseURL: E2E_BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    actionTimeout: 15_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: process.env.E2E_SKIP_BUILD ? `pnpm exec next start -p ${PORT}` : `pnpm exec next build && pnpm exec next start -p ${PORT}`,
    url: `${E2E_BASE_URL}/api/health`,
    timeout: 600_000,
    reuseExistingServer: !process.env.CI,
    env: E2E_ENV,
    stdout: "ignore",
    stderr: "pipe",
  },
});
