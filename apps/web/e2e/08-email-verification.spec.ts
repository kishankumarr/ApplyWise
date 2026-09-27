import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { signUp } from "./helpers";

const here = dirname(fileURLToPath(import.meta.url));
// The E2E server uses the dev outbox (EMAIL_OUTBOX_DIR=.outbox-e2e, relative to apps/web).
const OUTBOX = resolve(here, "../.outbox-e2e");

function findVerificationLink(to: string): string | undefined {
  if (!existsSync(OUTBOX)) return undefined;
  for (const f of readdirSync(OUTBOX).filter((x) => x.endsWith(".json"))) {
    const mail = JSON.parse(readFileSync(join(OUTBOX, f), "utf8")) as { to: string; text: string };
    if (mail.to === to) {
      const link = /https?:\/\/\S+\/verify-email\?token=\S+/.exec(mail.text)?.[0];
      if (link) return link;
    }
  }
  return undefined;
}

test("new users must confirm their email address before sending; the emailed link confirms it", async ({ page }) => {
  const { email } = await signUp(page, "Verification Tester");
  await expect(page.getByTestId("verify-email-notice")).toBeVisible();
  await expect(page.getByTestId("verify-email-notice")).toContainText(email);

  let link: string | undefined;
  await expect(async () => {
    link = findVerificationLink(email);
    expect(link).toBeTruthy();
  }).toPass({ timeout: 15_000 });

  // A tampered link is rejected.
  await page.goto(`${link!}tampered`);
  await expect(page.getByTestId("verify-email-result")).toContainText("Could not confirm your email");

  // Opening the link alone changes nothing (mail scanners prefetch links); the user confirms explicitly.
  await page.goto(link!);
  await expect(page.getByTestId("verify-email-confirm")).toContainText(email);
  await page.goto("/settings");
  await expect(page.getByTestId("account-email-status")).toContainText("Not confirmed");
  await page.goto(link!);
  await page.getByTestId("confirm-email").click();
  await expect(page.getByTestId("verify-email-result")).toContainText("Email address confirmed");
  await page.goto("/settings");
  await expect(page.getByTestId("account-email-status")).toContainText("Confirmed");
  await expect(page.getByTestId("verify-email-notice")).toHaveCount(0);
});
