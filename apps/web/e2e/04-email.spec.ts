import { expect, test } from "@playwright/test";
import { openJob, prepareAndApprove, signIn } from "./helpers";

test("email application: generate preview -> inspect final confirmation -> mock send", async ({ page }) => {
  await signIn(page);

  // Email sending requires explicit consent (off by default for the demo user).
  await page.goto("/settings/privacy");
  const consent = page.getByRole("checkbox", { name: "Email sending" });
  await expect(consent).not.toBeChecked();
  await consent.check();
  await expect(page.getByText("Consent updated.")).toBeVisible();

  await openJob(page, "Frontend Developer (React)");
  await expect(page.getByText("hiring@kavach-studio.test").first()).toBeVisible();
  await prepareAndApprove(page);

  const workspace = page.getByTestId("application-workspace");
  await workspace.getByRole("tab", { name: "Email" }).click();
  await expect(workspace.getByLabel("To", { exact: true })).toHaveValue("hiring@kavach-studio.test");
  await expect(workspace.getByLabel("Subject", { exact: true })).toHaveValue(/Application for Frontend Developer \(React\)/);
  const body = await workspace.getByLabel("Body", { exact: true }).inputValue();
  const words = body.split(/\s+/).filter(Boolean).length;
  expect(words).toBeGreaterThanOrEqual(120);
  expect(words).toBeLessThanOrEqual(180);
  expect(body).toContain("Kavach Studio");
  expect(body).toMatch(/attached/i);

  // User edits the subject, attaches the cover letter, previews.
  await workspace.getByLabel("Subject", { exact: true }).fill("Application for Frontend Developer (React) - Aarav Mehta");
  await workspace.getByRole("checkbox", { name: "Attach cover letter" }).check();
  await workspace.getByTestId("email-preview").click();

  const dialog = page.getByTestId("email-confirmation");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("confirm-to")).toContainText("hiring@kavach-studio.test");
  await expect(dialog.getByTestId("confirm-subject")).toHaveText("Application for Frontend Developer (React) - Aarav Mehta");
  await expect(dialog.getByTestId("confirm-attachments")).toContainText("Resume.pdf");
  await expect(dialog.getByTestId("confirm-attachments")).toContainText("Cover_Letter.txt");
  await expect(dialog.getByTestId("confirm-body")).toContainText("Kavach Studio");
  await expect(dialog.getByRole("link", { name: "Open in my email client" })).toHaveAttribute("href", /^mailto:hiring%40kavach-studio\.test\?/);
  await expect(dialog.getByText(/Development outbox - no real email is sent/)).toBeVisible();

  // Send is disabled until the explicit confirmation checkbox is ticked.
  const send = dialog.getByTestId("confirm-send");
  await expect(send).toBeDisabled();
  await dialog.getByRole("checkbox", { name: "I confirm and consent to send" }).check();
  await send.click();

  await expect(workspace.getByTestId("application-status")).toHaveText("Email sent", { timeout: 20_000 });
  await workspace.getByRole("tab", { name: "Timeline" }).click();
  await expect(workspace.getByTestId("timeline")).toContainText("development - not delivered");
});
