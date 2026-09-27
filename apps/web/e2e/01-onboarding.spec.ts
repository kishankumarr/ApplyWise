import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { signUp } from "./helpers";

const here = dirname(fileURLToPath(import.meta.url));

test("new user onboarding: upload CV -> parse -> verify facts -> YOE -> locations -> finish", async ({ page }) => {
  await signUp(page, "Onboarding Tester");

  // 1. Consent
  await expect(page.getByText("Step 1 of 11")).toBeVisible();
  await page.getByRole("checkbox", { name: "Consent to CV processing" }).check();
  await page.getByRole("button", { name: "Continue" }).click();

  // 2. Upload
  await page.locator("#cv-file").setInputFiles(resolve(here, ".fixtures/demo-cv.docx"));
  await page.getByRole("button", { name: "Upload and parse" }).click();

  // 3. Parse progress
  await expect(page.getByText(/Parsed demo-cv\.docx/)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/Found 2 roles/)).toBeVisible();
  await page.getByRole("button", { name: "Review facts" }).click();

  // 4. Verify facts: parsed facts start unverified; confirm one, reject one, then confirm the rest.
  const rows = page.getByTestId("fact-row");
  await expect(rows.first()).toBeVisible();
  await expect(page.locator('[data-testid="fact-row"][data-status="PARSED_UNVERIFIED"]').first()).toBeVisible();
  await page.getByRole("button", { name: /^Confirm: Built a multi-track video timeline/ }).click();
  await expect(page.locator('[data-testid="fact-row"][data-status="USER_VERIFIED"]').first()).toBeVisible();
  await page.getByRole("button", { name: /^Reject: Figma/ }).click();
  await expect(page.locator('[data-testid="fact-row"][data-status="USER_REJECTED"]')).toHaveCount(1);
  await page.getByRole("button", { name: "Confirm all remaining as accurate" }).click();
  await expect(page.locator('[data-testid="fact-row"][data-status="PARSED_UNVERIFIED"]')).toHaveCount(0);
  await page.getByRole("button", { name: "Continue" }).click();

  // 5. YOE (pre-filled from the CV, editable)
  await expect(page.getByLabel("Total years of professional experience")).toHaveValue("5");
  await page.getByLabel("Total years of professional experience").fill("5");
  await page.getByRole("button", { name: "Continue" }).click();

  // 6. Locations
  await page.getByRole("checkbox", { name: "Bengaluru" }).check();
  await page.getByRole("checkbox", { name: "Remote - India" }).check();
  await page.getByLabel("Custom location").fill("Noida");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("button", { name: "Continue" }).click();

  // 7. Work mode
  await page.getByText("Hybrid", { exact: true }).click();
  await page.getByRole("button", { name: "Continue" }).click();

  // 8. Target roles
  await page.getByRole("button", { name: "+ Frontend Engineer" }).click();
  await page.getByRole("button", { name: "+ React Developer" }).click();
  await page.getByRole("button", { name: "Continue" }).click();

  // 9. Notice & salary
  await page.getByLabel("Notice period").selectOption("30 days");
  await page.getByRole("button", { name: "Continue" }).click();

  // 10. Find jobs automatically (optional)
  await page.getByRole("button", { name: "Skip for now" }).click();

  // 11. Finish
  await expect(page.getByText("Locations: Bengaluru, Remote - India, Noida")).toBeVisible();
  await page.getByRole("button", { name: "Finish and go to dashboard" }).click();
  await page.waitForURL(/\/dashboard/);
  await expect(page.getByText("Top matches")).toBeVisible();
  await expect(page.getByText(/1 rejected/)).toBeVisible();
});
