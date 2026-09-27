import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { E2E_ENV } from "../playwright.config";
import { signUp } from "./helpers";

const here = dirname(fileURLToPath(import.meta.url));
const ALERT = readFileSync(resolve(here, "../../../packages/job-engine/test/fixtures/alerts/linkedin-digest.eml"));

/** What the Cloudflare Email Worker sends: HMAC-SHA256 over "<timestamp>.<recipient>." + raw email. */
function signed(raw: Buffer, to: string) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = createHmac("sha256", E2E_ENV.INBOUND_EMAIL_SECRET).update(`${ts}.${to.toLowerCase()}.`).update(raw).digest("hex");
  return { "content-type": "message/rfc822", "x-aw-envelope-to": to, "x-aw-timestamp": ts, "x-aw-signature": sig };
}

test("job alerts forwarded to the private address appear in the inbox automatically; demo jobs step aside", async ({ page, request }) => {
  await signUp(page, "Sources Tester");
  await page.goto("/jobs");
  await expect(page.getByTestId("demo-notice")).toBeVisible();

  await page.goto("/jobs/sources");
  await page.getByRole("button", { name: "Forward alerts to your private address" }).first().click();
  await page.getByRole("button", { name: "Create my address" }).click();
  const address = (await page.getByTestId("forwarding-address").textContent())!.trim();
  expect(address).toMatch(/^jobs-[a-z0-9]+@in\.applywise\.test$/);
  await expect(page.getByTestId("gmail-filter-query")).toContainText("from:(");

  // Unsigned or tampered deliveries are rejected.
  const bad = await request.post("/api/inbound/email", { data: ALERT, headers: { ...signed(ALERT, address), "x-aw-signature": "00".repeat(32) } });
  expect(bad.status()).toBe(401);

  // A delivery signed for another address cannot be replayed to this user.
  const replay = await request.post("/api/inbound/email", { data: ALERT, headers: { ...signed(ALERT, "jobs-someoneelse123@in.applywise.test"), "x-aw-envelope-to": address } });
  expect(replay.status()).toBe(401);

  const ok = await request.post("/api/inbound/email", { data: ALERT, headers: signed(ALERT, address) });
  expect(ok.status()).toBe(200);
  expect(await ok.json()).toMatchObject({ ok: true, kind: "job_alert" });

  await page.goto("/jobs");
  const row = page.getByTestId("job-row").filter({ hasText: "Senior Python Developer" });
  await expect(row).toBeVisible();
  await expect(row.getByTestId("job-new")).toBeVisible();
  await expect(row.getByTestId("job-snippet")).toBeVisible();
  // Real jobs arrived, so the demo jobs are hidden automatically.
  await expect(page.getByTestId("demo-notice")).toHaveCount(0);
  await expect(page.getByTestId("job-title").filter({ hasText: "Senior Frontend Engineer - Video Editor" })).toHaveCount(0);

  await page.goto("/jobs/sources");
  await expect(page.getByTestId("feed-row").filter({ hasText: "Forwarded job alerts" })).toBeVisible();
});
