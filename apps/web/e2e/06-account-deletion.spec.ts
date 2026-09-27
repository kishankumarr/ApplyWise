import { expect, test } from "@playwright/test";
import { signUp } from "./helpers";

test("account deletion request removes the account", async ({ page }) => {
  const { email, password } = await signUp(page, "Deletion Tester");
  await page.goto("/settings");
  await page.getByRole("button", { name: "Delete my account" }).click();
  const confirm = page.getByRole("button", { name: "Permanently delete" });
  await expect(confirm).toBeDisabled();
  await page.getByLabel("Type DELETE to confirm").fill("delete");
  await expect(confirm).toBeDisabled();
  await page.getByLabel("Type DELETE to confirm").fill("DELETE");
  await confirm.click();
  await page.waitForURL((url) => url.pathname === "/");

  // The account no longer exists.
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Invalid email or password.")).toBeVisible();
});
