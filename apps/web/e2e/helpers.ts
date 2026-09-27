import { expect, type Page } from "@playwright/test";

export const DEMO = { email: "demo@applywise.test", password: "DemoPass2026!" };

export async function signIn(page: Page, email = DEMO.email, password = DEMO.password) {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/(dashboard|onboarding)/);
}

export async function signUp(page: Page, name: string) {
  const email = `e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
  const password = "E2ePassword123";
  await page.goto("/sign-up");
  await page.getByLabel("Full name").fill(name);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL(/\/onboarding/);
  return { email, password };
}

/** Open a seeded demo job by its title from the inbox search. */
export async function openJob(page: Page, title: string) {
  await page.goto("/jobs");
  await page.getByLabel("Search title, company or description").fill(title);
  const link = page.getByTestId("job-title").filter({ hasText: title }).first();
  await expect(link).toBeVisible();
  await link.click();
  await expect(page.getByTestId("job-detail-title")).toHaveText(title);
}

export async function prepareAndApprove(page: Page) {
  await page.getByTestId("prepare-application").click();
  const status = page.getByTestId("application-status").first();
  await expect(status).toHaveText("Ready for review", { timeout: 60_000 });
  await page.getByRole("button", { name: "Review & approve" }).click();
  await page.getByRole("checkbox", { name: "I reviewed all content" }).check();
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(status).toHaveText("Approved");
}
