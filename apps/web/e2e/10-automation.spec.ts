import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { signUp } from "./helpers";

/**
 * The automation layer end to end, through the UI (DEMO CONTENT, no network, inline queue):
 *
 *   sign up -> onboarding (CV, verified facts, preferences) -> Automation: Auto mode + consent + daily limit, ON ->
 *   "Try the demo" (demo provider + the real pipeline: discovery, dedupe, match, rules, preparation, routing,
 *   executors) -> run metrics -> review queue "Approve & apply" -> applications list -> NEEDS_INFORMATION answered ->
 *   APPLIED -> manual handoff -> job-source capabilities -> dashboard metrics.
 *
 * The demo provider's two browser-channel jobs point at this app's /demo/ats/greenhouse/<key> pages: the E2E server
 * runs with BROWSER_EXECUTOR_ENABLED=true, so real Chromium (playwright-core, inside the server process) fills and
 * submits one of them, and stops at the fake CAPTCHA on the other (MANUAL_ACTION_REQUIRED / CAPTCHA).
 */

const here = dirname(fileURLToPath(import.meta.url));

// packages/job-engine/src/demo/automation-jobs.ts
const WORK_AUTH_QUESTION = "Are you authorised to work in India?";
const PERMIT_QUESTION = "Do you hold a valid work permit for Singapore?";
/** Demo browser-channel jobs (applyUrl = /demo/ats/greenhouse/<key>). */
const BROWSER_JOB = { title: "Senior Frontend Engineer - Video Timeline", company: "Reelcraft Studio", slug: "aw-reelcraft-timeline" };
const CAPTCHA_JOB = { title: "Frontend Engineer - Creator Editor", company: "Framewise", slug: "aw-framewise-creator-editor" };

interface ApplicationListRow {
  id: string;
  status: string;
  method: string | null;
  manualActionReason: string | null;
  job: { title: string; company: string };
}

interface ApplicationDetail {
  id: string;
  status: string;
  job: { title: string; applyUrl: string | null };
  automation: {
    executorKind: string | null;
    executorId: string | null;
    manualActionReason: string | null;
    externalApplicationId: string | null;
    confirmation: string | null;
    approvalSource: string | null;
  };
}

const intOf = (text: string) => Number(/-?\d+/.exec(text.replace(/,/g, ""))?.[0] ?? NaN);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function getJson<T>(page: Page, path: string): Promise<T> {
  const res = await page.request.get(path);
  expect(res.status(), `GET ${path}`).toBe(200);
  return ((await res.json()) as { data: T }).data;
}

/** A metric card on the run page: its value is the first <dd>. */
async function runMetric(page: Page, key: string): Promise<number> {
  return intOf(await page.getByTestId(`run-metric-${key}`).locator("dd").first().innerText());
}

/** A dashboard metric card: "<label> <value> [of N] <hint>". */
async function dashboardMetric(page: Page, label: string): Promise<number> {
  const card = page.getByTestId("dashboard-metrics").getByRole("link", { name: new RegExp(`^${escapeRe(label)}`) });
  const text = await card.innerText();
  return intOf(text.slice(text.indexOf(label) + label.length));
}

/** Sign up and onboard like 01-onboarding: CV upload, every fact verified, preferences incl. notice period and salary. */
async function onboard(page: Page) {
  await signUp(page, "Automation Tester");
  await expect(page.getByText("Step 1 of 11")).toBeVisible();
  await page.getByRole("checkbox", { name: "Consent to CV processing" }).check();
  await page.getByRole("button", { name: "Continue" }).click();

  await page.locator("#cv-file").setInputFiles(resolve(here, ".fixtures/demo-cv.docx"));
  await page.getByRole("button", { name: "Upload and parse" }).click();
  await expect(page.getByText(/Parsed demo-cv\.docx/)).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "Review facts" }).click();

  await expect(page.getByTestId("fact-row").first()).toBeVisible();
  await page.getByRole("button", { name: "Confirm all remaining as accurate" }).click();
  await expect(page.locator('[data-testid="fact-row"][data-status="PARSED_UNVERIFIED"]')).toHaveCount(0);
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page.getByLabel("Total years of professional experience")).toHaveValue("5");
  await page.getByRole("button", { name: "Continue" }).click();

  await page.getByRole("checkbox", { name: "Bengaluru" }).check();
  await page.getByRole("checkbox", { name: "Remote - India" }).check();
  await page.getByRole("button", { name: "Continue" }).click();

  await page.getByText("Any", { exact: true }).click();
  await page.getByRole("button", { name: "Continue" }).click();

  await page.getByRole("button", { name: "+ Frontend Engineer" }).click();
  await page.getByRole("button", { name: "+ React Developer" }).click();
  await page.getByRole("button", { name: "+ Full-Stack Developer" }).click();
  await page.getByRole("button", { name: "Continue" }).click();

  await page.getByLabel("Notice period").selectOption("30 days");
  await page.getByLabel("Expected CTC min (LPA, optional)").fill("28");
  await page.getByLabel("Expected CTC max (LPA, optional)").fill("38");
  await page.getByRole("button", { name: "Continue" }).click();

  await page.getByRole("button", { name: "Skip for now" }).click();
  await expect(page.getByText("Locations: Bengaluru, Remote - India")).toBeVisible();
  await page.getByRole("button", { name: "Finish and go to dashboard" }).click();
  await page.waitForURL(/\/dashboard/);
}

/** Rows of the Applications list (active view) whose status badge reads exactly `status`. */
function rowsWithStatus(page: Page, status: string): Locator {
  return page.getByTestId("application-row").filter({ has: page.getByText(status, { exact: true }) });
}

async function applicationIdOf(row: Locator): Promise<string> {
  const href = await row.getByRole("link").first().getAttribute("href");
  const id = /\/applications\/([^/?#]+)/.exec(href ?? "")?.[1];
  expect(id, "application link").toBeTruthy();
  return id!;
}

test.describe.configure({ mode: "serial" });

test.describe("automation layer (demo provider, Auto mode)", () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000);
    page = await browser.newPage();
    await onboard(page);
  });

  test.afterAll(async () => {
    await page?.close();
  });

  test("a reusable answer is saved once", async () => {
    await page.goto("/settings/answers");
    await page.getByLabel("Question", { exact: true }).fill(WORK_AUTH_QUESTION);
    await page.getByLabel("Your answer", { exact: true }).fill("Yes");
    await page.getByRole("button", { name: "Save answer" }).click();
    await expect(page.getByText("Answer saved. It will be reused in future applications.").first()).toBeVisible();
    await expect(page.getByText(WORK_AUTH_QUESTION).first()).toBeVisible();
  });

  test("automation: Auto mode with consent, turned on, then the demo runs the real pipeline", async () => {
    test.setTimeout(300_000);
    await page.goto("/automation");
    await expect(page.getByRole("heading", { name: "Automation", level: 1 })).toBeVisible();

    // Auto mode is never saved without the explicit consent.
    // The mode cards are labels around visually hidden radios: click the card like a user.
    const auto = page.getByRole("radio", { name: "Auto" });
    await page.locator("label").filter({ has: auto }).click();
    await expect(auto).toBeChecked();
    const consent = page.getByRole("checkbox", { name: /I allow ApplyWise to submit job applications on my behalf/ });
    await expect(consent).not.toBeChecked();
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Auto mode needs this consent before it can be saved.")).toBeVisible();

    await consent.check();
    await page.getByLabel("Maximum applications per day").fill("30");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("All changes saved.")).toBeVisible();

    // Turn automation on (takes effect immediately).
    const toggle = page.getByRole("switch", { name: "Automation" });
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect(page.getByText("Ready to submit automatically")).toBeVisible();

    // The demo provider is added + connected, and the real pipeline runs once (inline queue: within the request).
    await page.getByRole("button", { name: "Try the demo" }).click();
    await expect(page.getByText(/Demo job provider added and connected/)).toBeVisible({ timeout: 240_000 });
    await expect(page.getByRole("link", { name: "View run details" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: "Run the demo again" })).toBeVisible();
  });

  test("the run shows discovery, dedupe, rule and submission metrics", async () => {
    await page.goto("/automation/runs");
    const row = page.getByTestId("run-row").first();
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute("data-status", "COMPLETED");
    await expect(row).toContainText("Demo");
    await row.getByRole("link").first().click();
    await page.waitForURL(/\/automation\/runs\/[^/]+$/);
    await expect(page.getByRole("heading", { name: "Automation run" })).toBeVisible();
    await expect(page.getByTestId("run-status-text")).toContainText("Completed");

    expect(await runMetric(page, "jobsFound")).toBeGreaterThanOrEqual(100);
    expect(await runMetric(page, "newJobs")).toBeGreaterThanOrEqual(100);
    expect(await runMetric(page, "duplicates")).toBeGreaterThan(0);
    expect(await runMetric(page, "jobsMatched")).toBeGreaterThanOrEqual(100);
    expect(await runMetric(page, "ignored")).toBeGreaterThan(0);
    expect(await runMetric(page, "reviewRequired")).toBeGreaterThan(0);
    expect(await runMetric(page, "autoEligible")).toBeGreaterThan(0);
    expect(await runMetric(page, "applicationsPrepared")).toBeGreaterThan(0);
    expect(await runMetric(page, "applicationsSubmitted")).toBeGreaterThan(0);
    expect(await runMetric(page, "needsInformation")).toBeGreaterThan(0);
    expect(await runMetric(page, "manualActions")).toBeGreaterThan(0);
  });

  test("review queue: a prepared medium match is approved and applied", async () => {
    test.setTimeout(120_000);
    await page.goto("/review");
    await expect(page.getByRole("heading", { name: "Review queue" })).toBeVisible();
    await expect(page.getByTestId("review-count")).toContainText(/\d+ applications? waiting for your decision/);

    // A medium match: rule decision "Review", prepared, submittable through the demo provider after approval.
    const card = page
      .getByTestId("review-card")
      .filter({ hasText: "Waiting for approval" })
      .filter({ has: page.getByText("Review", { exact: true }) })
      .filter({ has: page.getByRole("button", { name: "Approve & apply" }) })
      .first();
    // The queue is paginated (10 per page, best matches first): page through until such a card shows up.
    await expect(page.getByTestId("review-card").first()).toBeVisible();
    for (let n = 1; n < 20 && (await card.count()) === 0; n++) {
      const next = page.getByRole("button", { name: "Next page" });
      if ((await next.count()) === 0) break;
      await next.click();
      await expect(page.getByTestId("pager")).toContainText(`${n * 10 + 1}–`);
      // The previous page stays on screen (dimmed, aria-busy) until the next one arrives.
      await expect(page.getByRole("list", { name: "Applications to review" })).not.toHaveAttribute("aria-busy", "true");
    }
    await expect(card).toBeVisible();
    await expect(card.getByText("Tailored resume summary")).toBeVisible();
    await expect(card.getByText("Show cover letter")).toBeVisible();
    const title = (await card.getByRole("heading", { level: 2 }).innerText()).trim();
    const editHref = await card.getByRole("link", { name: /^Edit the application for/ }).getAttribute("href");
    const applicationId = /\/applications\/([^/?#]+)/.exec(editHref ?? "")?.[1];
    expect(applicationId).toBeTruthy();

    await card.getByRole("button", { name: "Approve & apply" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: `Approve and apply to ${title}`, exact: false })).toBeVisible();
    await expect(dialog.getByText("What will be submitted")).toBeVisible();
    const confirm = dialog.getByRole("button", { name: "Approve & apply" });
    await expect(confirm).toBeDisabled();
    await dialog.getByRole("checkbox").check();
    await confirm.click();
    await expect(page.getByText(new RegExp(`Approved ${escapeRe(title)}`)).first()).toBeVisible();

    await page.goto(`/applications/${applicationId}`);
    await expect(page.getByTestId("application-status")).toHaveText("Applied", { timeout: 60_000 });
    const panel = page.getByTestId("automation-panel");
    await expect(panel.getByText("Automatic (demo API)")).toBeVisible();
    await expect(panel.getByText("You", { exact: true })).toBeVisible(); // approved by the user, not by policy
  });

  test("applications list: applied rows with their application method, and rows that need the user", async () => {
    await page.goto("/applications");
    await expect(page.getByRole("heading", { name: "Applications" })).toBeVisible();
    const applied = rowsWithStatus(page, "Applied");
    await expect(applied.first()).toBeVisible();
    expect(await applied.count()).toBeGreaterThanOrEqual(2);
    await expect(applied.filter({ hasText: "Automatic (demo API)" }).first()).toBeVisible();
    await expect(applied.filter({ hasText: "Automatic (browser)" }).first()).toBeVisible();
    await expect(page.getByText(/needs? your attention/)).toBeVisible();
    // The list is paginated; "Show only these" narrows it to the rows that need the user.
    await page.getByTestId("attention-filter").click();
    await expect(page).toHaveURL(/attention=true/);
    await expect(rowsWithStatus(page, "Needs information").first()).toBeVisible();
    await expect(rowsWithStatus(page, "Manual action required").first()).toBeVisible();
    await expect(rowsWithStatus(page, "Applied")).toHaveCount(0);
  });

  test("NEEDS_INFORMATION: the missing answer is given once and the application resumes to Applied", async () => {
    test.setTimeout(120_000);
    await page.goto("/applications?attention=true");
    const rows = rowsWithStatus(page, "Needs information");
    await expect(rows.first()).toBeVisible();
    const ids: string[] = [];
    for (let i = 0; i < (await rows.count()); i++) ids.push(await applicationIdOf(rows.nth(i)));
    expect(ids.length).toBeGreaterThan(0);

    // Open the application that asks the question the profile cannot answer (never guessed).
    let found = false;
    for (const id of ids) {
      await page.goto(`/applications/${id}`);
      await expect(page.getByTestId("application-status")).toHaveText("Needs information");
      const form = page.getByTestId("needs-information");
      await expect(form).toBeVisible();
      if ((await form.getByText(PERMIT_QUESTION).count()) === 0) continue;
      found = true;
      await form.getByRole("combobox", { name: new RegExp(escapeRe(PERMIT_QUESTION)) }).selectOption("No");
      await expect(form.getByRole("checkbox", { name: `Save for future applications: ${PERMIT_QUESTION}` })).toBeChecked();
      await form.getByRole("button", { name: "Save answers and continue" }).click();
      await expect(page.getByTestId("application-status")).toHaveText("Applied", { timeout: 60_000 });
      await expect(page.getByTestId("needs-information")).toHaveCount(0);
      break;
    }
    expect(found, `an application asks "${PERMIT_QUESTION}"`).toBe(true);

    // The answer was saved for reuse.
    await page.goto("/settings/answers");
    await expect(page.getByText(PERMIT_QUESTION).first()).toBeVisible();
  });

  test("MANUAL_ACTION_REQUIRED: the manual handoff has the reason, the apply link, the cover letter and the answers", async () => {
    await page.goto("/applications?attention=true");
    const row = rowsWithStatus(page, "Manual action required").filter({ hasText: "The provider does not permit automated applications" }).first();
    await expect(row).toBeVisible();
    await page.goto(`/applications/${await applicationIdOf(row)}`);

    await expect(page.getByTestId("application-status")).toHaveText("Manual action required");
    const handoff = page.getByTestId("manual-handoff");
    await expect(handoff).toBeVisible();
    await expect(handoff.getByText("Manual handoff")).toBeVisible();
    await expect(handoff.getByText("The provider does not permit automated applications")).toBeVisible();
    await expect(handoff.getByTestId("handoff-open-apply-page")).toHaveAttribute("href", /^https?:\/\//);
    await expect(handoff.getByRole("heading", { name: "Cover letter" })).toBeVisible();
    const letter = handoff.getByRole("region", { name: "Cover letter text" });
    await expect(letter).toBeVisible();
    expect((await letter.innerText()).trim().length).toBeGreaterThan(50);
    await expect(handoff.getByRole("heading", { name: "Prepared answers" })).toBeVisible();
    await expect(handoff.getByText(WORK_AUTH_QUESTION)).toBeVisible();
    await expect(handoff.getByRole("heading", { name: "Resume to attach" })).toBeVisible();
    await expect(handoff.getByRole("button", { name: "I submitted it myself" })).toBeVisible();
  });

  test("browser executor: real Chromium submitted the demo ATS page, and stopped at the CAPTCHA", async () => {
    const all = (await getJson<{ items: ApplicationListRow[] }>(page, "/api/applications?view=all&pageSize=100")).items;

    // Submitted by the worker-side browser executor through the page's own submit button.
    const submitted = all.find((a) => a.job.title === BROWSER_JOB.title && a.job.company === BROWSER_JOB.company);
    expect(submitted, BROWSER_JOB.title).toBeDefined();
    expect(submitted).toMatchObject({ status: "APPLIED", method: "browser:demo-ats" });
    const detail = await getJson<ApplicationDetail>(page, `/api/applications/${submitted!.id}`);
    expect(detail.job.applyUrl).toContain(`/demo/ats/greenhouse/${BROWSER_JOB.slug}`);
    expect(detail.automation).toMatchObject({ executorKind: "BROWSER", executorId: "browser:demo-ats", approvalSource: "policy" });
    expect(detail.automation.externalApplicationId).toMatch(/^DEMO-[A-Z0-9]+$/);
    expect(detail.automation.confirmation).toMatch(/Application received \(demo\)/);

    await page.goto(`/applications/${submitted!.id}`);
    await expect(page.getByTestId("application-status")).toHaveText("Applied");
    const panel = page.getByTestId("automation-panel");
    await expect(panel.getByText("Automatic (browser)")).toBeVisible();
    await expect(panel.getByText(detail.automation.externalApplicationId!)).toBeVisible();

    // The CAPTCHA page: detected, never touched, handed to the user.
    const challenged = all.find((a) => a.job.title === CAPTCHA_JOB.title && a.job.company === CAPTCHA_JOB.company);
    expect(challenged, CAPTCHA_JOB.title).toBeDefined();
    expect(challenged).toMatchObject({ status: "MANUAL_ACTION_REQUIRED", manualActionReason: "CAPTCHA" });
    const captcha = await getJson<ApplicationDetail>(page, `/api/applications/${challenged!.id}`);
    expect(captcha.automation.executorId).toBe("browser:demo-ats");
    expect(captcha.automation.externalApplicationId).toBeNull();

    await page.goto(`/applications/${challenged!.id}`);
    await expect(page.getByTestId("application-status")).toHaveText("Manual action required");
    const handoff = page.getByTestId("manual-handoff");
    await expect(handoff.getByText("The application page shows a CAPTCHA").first()).toBeVisible();
    await expect(handoff.getByTestId("handoff-open-apply-page")).toHaveAttribute("href", new RegExp(`/demo/ats/greenhouse/${CAPTCHA_JOB.slug}`));
  });

  test("job sources: LinkedIn cannot be automated, the demo provider is connected and can submit", async () => {
    await page.goto("/settings/job-sources");
    const linkedin = page.getByTestId("job-source-linkedin");
    await expect(linkedin).toBeVisible();
    await expect(linkedin.getByTestId("capability-AUTO_APPLY")).toContainText("Not allowed by the provider");
    await expect(linkedin.getByText(/Never submitted automatically/)).toBeVisible();

    const demo = page.getByTestId("job-source-demo");
    await expect(demo).toBeVisible();
    await expect(demo.getByTestId("source-card-status")).toHaveText(/Connected|Working/);
    await expect(demo.getByTestId("capability-AUTO_APPLY")).toContainText("Supported");
    await expect(demo.getByTestId("source-feeds")).toContainText(/1 automatic source/);
  });

  test("dashboard: automation metrics", async () => {
    await page.goto("/dashboard");
    await expect(page.getByTestId("automation-status-card")).toContainText("Auto mode");
    await expect(page.getByTestId("automation-status-card")).toContainText("On");
    expect(await dashboardMetric(page, "Applications today")).toBeGreaterThan(0);
    expect(await dashboardMetric(page, "Jobs discovered today")).toBeGreaterThanOrEqual(100);
    expect(await dashboardMetric(page, "90%+ matches")).toBeGreaterThan(0);
    expect(await dashboardMetric(page, "Waiting approval")).toBeGreaterThan(0);
    expect(await dashboardMetric(page, "Manual action required")).toBeGreaterThan(0);
  });
});
