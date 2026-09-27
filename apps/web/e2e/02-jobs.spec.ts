import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

test("jobs view: filter, sort, open job and see the transparent match report", async ({ page }) => {
  await signIn(page);
  await page.goto("/jobs");
  await expect(page.getByText(/This score is a transparent heuristic/)).toBeVisible();
  const rows = page.getByTestId("job-row");
  await expect(rows.first()).toBeVisible();
  // 25 matches per page; the pager shows the full count ("1–25 of N").
  const total = await rows.count();
  expect(total).toBe(25);
  const pager = page.getByRole("navigation", { name: "Job matches pages" });
  expect(Number(/of (\d+)/.exec(await pager.innerText())?.[1])).toBeGreaterThanOrEqual(30);

  // Default sort: match score descending.
  const scores = (await page.getByTestId("job-score").allInnerTexts()).map(Number);
  expect([...scores].sort((a, b) => b - a)).toEqual(scores);

  // The next page continues the ranking.
  await page.getByRole("button", { name: "Next page" }).click();
  await expect(pager).toContainText("26–");
  await expect(async () => {
    const next = (await page.getByTestId("job-score").allInnerTexts()).map(Number);
    expect(next.length).toBeGreaterThan(0);
    expect(Math.max(...next)).toBeLessThanOrEqual(Math.min(...scores));
  }).toPass();

  // Filter by location and work mode.
  await page.getByLabel("Location").selectOption("Bengaluru");
  await page.getByLabel("Work mode").selectOption("hybrid");
  await expect(async () => {
    const n = await rows.count();
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThan(total);
  }).toPass();

  // Filter by platform.
  await page.getByLabel("Platform").selectOption("GREENHOUSE");
  await expect(async () => {
    const texts = await page.getByTestId("job-row").allInnerTexts();
    expect(texts.length).toBeGreaterThan(0);
    for (const t of texts) expect(t).toContain("Greenhouse");
  }).toPass();

  // Reset and sort by company A-Z.
  await page.getByRole("button", { name: "Reset" }).click();
  await page.getByRole("button", { name: "Sort by company" }).click();
  await expect(async () => {
    const companies = await page.getByTestId("job-company").allInnerTexts();
    expect(companies.length).toBeGreaterThan(10);
    expect([...companies].sort((a, b) => a.localeCompare(b))).toEqual(companies);
  }).toPass();

  // Search and open a job.
  await page.getByLabel("Search title, company or description").fill("Video Editor");
  await page.getByTestId("job-title").filter({ hasText: "Senior Frontend Engineer - Video Editor" }).click();
  await expect(page.getByTestId("job-detail-title")).toHaveText("Senior Frontend Engineer - Video Editor");

  const report = page.getByTestId("match-report");
  await expect(report.getByText("Estimated resume-to-job match")).toBeVisible();
  await expect(report.getByText("Required-skill coverage")).toBeVisible();
  await expect(report.getByText("Evidence strength (verified experience/projects)")).toBeVisible();
  await expect(report.getByText(/does not guarantee ATS selection/)).toBeVisible();
  await expect(page.getByText(/official ATS score/i)).toHaveCount(0);
  const score = Number(await page.getByTestId("match-score").innerText().then((t) => t.replace("/100", "")));
  expect(score).toBeGreaterThan(60);

  const matrix = page.getByTestId("requirement-matrix");
  await expect(matrix.getByRole("cell", { name: /^React/ }).first()).toBeVisible();
  await expect(matrix.getByText("Verified experience").first()).toBeVisible();
  await expect(page.getByTestId("job-description")).toContainText("[DEMO CONTENT]");
});
