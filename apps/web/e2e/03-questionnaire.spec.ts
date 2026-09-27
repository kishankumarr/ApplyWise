import { expect, test } from "@playwright/test";
import { openJob, signIn } from "./helpers";

test("questionnaire: answer questions -> generate tailored application -> edit -> approve", async ({ page }) => {
  await signIn(page);
  await openJob(page, "Senior Frontend Engineer - Video Editor");

  await page.getByRole("button", { name: "Generate questions" }).click();
  const q = page.getByTestId("questionnaire");
  await expect(q).toBeVisible();
  const questionCount = await q.locator("fieldset").count();
  expect(questionCount).toBeGreaterThanOrEqual(3);
  expect(questionCount).toBeLessThanOrEqual(8);

  // Employer screening questions are asked first.
  await expect(q.locator("fieldset").first()).toContainText("How many years of professional React experience");
  await q.getByTestId("question-screening_1").getByRole("textbox").fill("5 years of professional React experience.");
  await q.getByTestId("question-screening_2").getByRole("textbox").fill("Yes - I built a multi-track video timeline editor with canvas preview at Clipverse Media.");
  await q.getByRole("button", { name: "Save answers" }).click();
  await expect(page.getByText(/Answers saved/)).toBeVisible();
  await expect(q.getByText("completed")).toBeVisible();

  // Generate the tailored application (drafts only).
  await page.getByTestId("prepare-application").click();
  const workspace = page.getByTestId("application-workspace");
  await expect(workspace.getByTestId("application-status")).toHaveText("Ready for review", { timeout: 60_000 });
  await expect(workspace.getByText(/Every claim cites your verified facts/)).toBeVisible();
  await expect(workspace.getByTestId("bullet-change").first()).toBeVisible();

  // Edit the summary and a bullet, save.
  const summary = workspace.getByLabel("Professional summary");
  await summary.fill("Senior Frontend Engineer with 5 years of professional experience building video editing tools in React and TypeScript.");
  await workspace.getByRole("checkbox", { name: "Use suggestion 2" }).uncheck();
  await workspace.getByRole("button", { name: "Save resume edits" }).click();
  await expect(page.getByText(/Saved/).first()).toBeVisible();
  await expect(workspace.locator(".resume")).toContainText("building video editing tools in React and TypeScript");

  // Screening answers were drafted from the answers above.
  await workspace.getByRole("tab", { name: /Screening answers/ }).click();
  await expect(workspace.getByLabel("How many years of professional React experience do you have?")).not.toHaveValue("");

  // Approve.
  await workspace.getByRole("button", { name: "Review & approve" }).click();
  const approve = page.getByRole("button", { name: "Approve", exact: true });
  await expect(approve).toBeDisabled();
  await page.getByRole("checkbox", { name: "I reviewed all content" }).check();
  await approve.click();
  await expect(workspace.getByTestId("application-status")).toHaveText("Approved");

  // Approved content produced a tailored resume version.
  await page.goto("/resume");
  await expect(page.getByText("Tailored for Senior Frontend Engineer - Video Editor at Framecraft Labs").first()).toBeVisible();
});
