import { expect, test } from "@playwright/test";
import { openJob, prepareAndApprove, signIn } from "./helpers";

test("career page application: prepare -> open official page -> mark submitted", async ({ page, context }) => {
  await signIn(page);
  await openJob(page, "Frontend Engineer, Workflow Builder");
  await prepareAndApprove(page);

  const workspace = page.getByTestId("application-workspace");
  await workspace.getByRole("tab", { name: "Apply" }).click();
  await expect(workspace.getByText(/never clicks Submit/)).toBeVisible();

  // Opening the official page happens in a new tab that the user controls.
  const [popup] = await Promise.all([context.waitForEvent("page"), workspace.getByTestId("open-apply-page").click()]);
  await popup.waitForLoadState();
  expect(popup.url()).toContain("/demo/ats/lever/flowdesk-frontend");
  await expect(popup.getByText(/DEMO CONTENT - fictional Lever-like application page/)).toBeVisible();
  // Nothing was submitted on the official page by the app.
  await expect(popup.getByText("Demo only - nothing was sent")).toHaveCount(0);
  await popup.close();

  await expect(workspace.getByTestId("application-status")).toHaveText("Opened apply page");

  // A prefill code can be issued for the extension (short-lived).
  await workspace.getByRole("button", { name: "Create prefill code" }).click();
  await expect(workspace.getByLabel("Prefill code")).not.toHaveValue("");

  // The user confirms they submitted it themselves.
  await workspace.getByRole("button", { name: "I submitted it myself" }).click();
  const confirm = page.getByRole("button", { name: "Mark submitted" });
  await expect(confirm).toBeDisabled();
  await page.getByRole("checkbox", { name: "I submitted it myself" }).check();
  await confirm.click();
  await expect(workspace.getByTestId("application-status")).toHaveText("Submitted");

  await page.goto("/applications");
  await expect(page.getByRole("row", { name: /Frontend Engineer, Workflow Builder/ })).toContainText("Submitted");
});
