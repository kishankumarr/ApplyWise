import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma, seedDemoJobs } from "@applywise/database";
import { MailAuthError } from "@applywise/mail-sources";
import type * as MailSources from "@applywise/mail-sources";
import { normalizeRawJob, type RawImportedJob } from "@applywise/job-engine";
import { accountService } from "@/server/services/account.service";
import { authService } from "@/server/services/auth.service";
import { encryptText } from "@/server/crypto";
import { dayKey } from "@/server/services/automation-time";
import { jobFeedsService, NEW_MATCHES_BODY } from "@/server/services/job-feeds.service";
import { jobsService } from "@/server/services/jobs.service";
import { profileService } from "@/server/services/profile.service";

// Mailbox access is mocked: tests never open a network connection to a mail server.
vi.mock("@applywise/mail-sources", async (importOriginal) => {
  const actual = await importOriginal<typeof MailSources>();
  return { ...actual, fetchAlertEmailsImap: vi.fn(), testImapConnection: vi.fn() };
});

const GH = "https://boards-api.greenhouse.io/v1/boards/acmeindiatest";
const ghJobs = {
  jobs: [
    {
      id: 101,
      title: "Senior Frontend Engineer",
      company_name: "Acme India Test",
      absolute_url: "https://job-boards.greenhouse.io/acmeindiatest/jobs/101",
      location: { name: "Bengaluru, India" },
      content: "&lt;p&gt;Build our React product.&lt;/p&gt;&lt;h3&gt;Requirements&lt;/h3&gt;&lt;ul&gt;&lt;li&gt;5+ years of React and TypeScript&lt;/li&gt;&lt;/ul&gt;",
      first_published: "2026-09-20T10:00:00Z",
      updated_at: "2026-09-21T10:00:00Z",
      offices: [],
      departments: [],
    },
    { id: 102, title: "Enterprise Sales Manager", company_name: "Acme India Test", absolute_url: "https://job-boards.greenhouse.io/acmeindiatest/jobs/102", location: { name: "Mumbai, India" }, content: "&lt;p&gt;Sell software.&lt;/p&gt;", offices: [], departments: [] },
    { id: 103, title: "Frontend Engineer", company_name: "Acme India Test", absolute_url: "https://job-boards.greenhouse.io/acmeindiatest/jobs/103", location: { name: "London, United Kingdom" }, content: "&lt;p&gt;React in London.&lt;/p&gt;", offices: [], departments: [] },
  ],
  meta: { total: 3 },
};

function mockFetch(handler: (url: string) => Response | undefined) {
  const fn = vi.fn(async (input: string | URL | Request) => handler(String(input instanceof Request ? input.url : input)) ?? new Response("Not found", { status: 404 }));
  vi.stubGlobal("fetch", fn);
  return fn;
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function newUser(label: string) {
  const { userId } = await authService.signUp({ name: label, email: `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.test`, password: "Password123", acceptTerms: true });
  await profileService.update(userId, { targetRoles: ["Frontend Engineer"], preferredLocations: ["Bengaluru"], onboardingCompleted: true });
  return userId;
}

let a: string;
let b: string;

beforeAll(async () => {
  await seedDemoJobs(prisma, "http://localhost:3000");
  a = await newUser("feeds-a");
  b = await newUser("feeds-b");
});

afterEach(() => vi.unstubAllGlobals());

describe("following a company board", () => {
  it("imports only relevant jobs, links them to the source and hides demo jobs automatically", async () => {
    mockFetch((url) => (url.startsWith(`${GH}/jobs`) ? json(ghJobs) : undefined));
    const before = await jobsService.list(a, listQuery());
    expect(before.view.showDemo).toBe(true);
    expect(before.items.some((i) => i.isDemo)).toBe(true);

    const feed = await jobFeedsService.createBoard(a, { provider: "greenhouse", slug: "acmeindiatest", companyName: "Acme India Test", onlyRelevant: true });
    // Inline queue in tests: the first sync already ran.
    const row = await prisma.jobFeed.findUniqueOrThrow({ where: { id: feed.id } });
    expect(row.status).toBe("ACTIVE");
    expect(row.lastResult).toMatchObject({ fetched: 3, created: 1, skipped: 2 });
    const jobs = await prisma.job.findMany({ where: { ownerUserId: a, feedId: feed.id } });
    expect(jobs.map((j) => j.title)).toEqual(["Senior Frontend Engineer"]);
    expect(jobs[0]!.descriptionLevel).toBe("FULL");
    expect(jobs[0]!.description).toContain("5+ years of React and TypeScript");
    const run = await prisma.jobFeedRun.findFirstOrThrow({ where: { feedId: feed.id } });
    expect(run.finishedAt).not.toBeNull();

    const after = await jobsService.list(a, listQuery());
    expect(after.view.showDemo).toBe(false);
    expect(after.items.some((i) => i.isDemo)).toBe(false);
    const found = after.items.find((i) => i.title === "Senior Frontend Engineer")!;
    expect(found).toMatchObject({ isNew: true, feed: { id: feed.id } });
    expect(after.sources).toMatchObject({ total: 1, active: 1 });

    // Demo jobs can be shown again explicitly; "new" badges clear once seen.
    await jobsService.updateViewPrefs(a, { showDemoJobs: true, markSeen: true });
    const shown = await jobsService.list(a, listQuery());
    expect(shown.items.some((i) => i.isDemo)).toBe(true);
    expect(shown.items.find((i) => i.title === "Senior Frontend Engineer")!.isNew).toBe(false);
    expect(shown.view.newCount).toBe(0);
    await jobsService.updateViewPrefs(a, { showDemoJobs: null });

    // Re-sync does not duplicate.
    await jobFeedsService.syncNow(a, feed.id);
    expect(await prisma.job.count({ where: { ownerUserId: a, feedId: feed.id } })).toBe(1);
    await expect(jobFeedsService.createBoard(a, { provider: "greenhouse", slug: "acmeindiatest", companyName: null, onlyRelevant: true })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("backs off on provider errors and never exposes another user's source", async () => {
    mockFetch((url) => (url.startsWith(`${GH}/jobs`) ? json(ghJobs) : undefined));
    const feed = await jobFeedsService.createBoard(b, { provider: "greenhouse", slug: "acmeindiatest", companyName: "Acme India Test", onlyRelevant: false });
    mockFetch((url) => (url.startsWith(GH) ? new Response("busy", { status: 503 }) : undefined));
    await jobFeedsService.syncNow(b, feed.id);
    const row = await prisma.jobFeed.findUniqueOrThrow({ where: { id: feed.id } });
    expect(row.status).toBe("ERROR");
    expect(row.consecutiveFailures).toBe(1);
    expect(row.nextSyncAt!.getTime()).toBeGreaterThan(Date.now());
    expect(row.lastError).toMatch(/Greenhouse/i);
    // Jobs from the earlier successful sync stay.
    expect(await prisma.job.count({ where: { ownerUserId: b, feedId: feed.id } })).toBe(3);

    for (const call of [
      () => jobFeedsService.syncNow(a, feed.id),
      () => jobFeedsService.update(a, feed.id, { paused: true }),
      () => jobFeedsService.remove(a, feed.id),
    ]) {
      await expect(call()).rejects.toMatchObject({ status: 404 });
    }
    expect((await jobsService.list(a, { ...listQuery(), feedId: feed.id })).items).toHaveLength(0);
  });

  it("lets only one scheduler tick claim a due source", async () => {
    mockFetch((url) => (url.startsWith(`${GH}/jobs`) ? json(ghJobs) : undefined));
    const feed = await prisma.jobFeed.findFirstOrThrow({ where: { userId: a, kind: "COMPANY_BOARD" } });
    await prisma.jobFeed.update({ where: { id: feed.id }, data: { nextSyncAt: new Date(Date.now() - 60_000), status: "ACTIVE" } });
    // The unit database is shared across runs: feeds left over from earlier runs can be due too, and a tick only
    // claims the 25 most overdue. Push them out so this test observes its own feed.
    await prisma.jobFeed.updateMany({ where: { userId: { not: a } }, data: { nextSyncAt: new Date(Date.now() + 86_400_000) } });
    const runsBefore = await prisma.jobFeedRun.count({ where: { feedId: feed.id } });
    await Promise.all([jobFeedsService.tick(), jobFeedsService.tick()]);
    expect(await prisma.jobFeedRun.count({ where: { feedId: feed.id } })).toBe(runsBefore + 1);
    const row = await prisma.jobFeed.findUniqueOrThrow({ where: { id: feed.id } });
    expect(row.nextSyncAt!.getTime()).toBeGreaterThan(Date.now() + 60 * 60_000);
  });
});

describe("merging the same job across sources", () => {
  const snippet: RawImportedJob = {
    provider: "LINKEDIN",
    importMethod: "USER_MAILBOX_ALERT",
    externalId: "LINKEDIN:9001",
    sourceUrl: "https://www.linkedin.com/jobs/view/9001",
    attribution: "LinkedIn job alert (your email)",
    raw: { kind: "job_alert_email", platform: "LINKEDIN", jobId: "9001" },
    text: "Frontend Engineer\nGlobex Systems\nPune",
    descriptionLevel: "SNIPPET",
    hints: { title: "Frontend Engineer", company: "Globex Systems Pvt Ltd", location: "Pune, Maharashtra" },
  };
  const full: RawImportedJob = {
    ...snippet,
    provider: "OTHER",
    importMethod: "USER_INITIATED_BROWSER_IMPORT",
    externalId: null,
    sourceUrl: "https://careers.globex.test/jobs/frontend-engineer",
    attribution: "Imported with the browser extension",
    raw: { kind: "browser_import" },
    text: "Frontend Engineer at Globex Systems, Pune.\nAbout the role\nYou will own the customer-facing dashboard used by thousands of logistics teams.\nRequirements\n- 4+ years of React, TypeScript and Redux\n- Experience with design systems and accessibility\nResponsibilities\n- Build the customer dashboard\n- Work with product and design on new features",
    descriptionLevel: "FULL",
    hints: { title: "Frontend Engineer", company: "Globex Systems", location: "Pune" },
  };

  it("keeps one job, adds the second source and upgrades the summary to the full description", async () => {
    const first = await jobsService.importRaws(a, [snippet], { connector: "test", normalize: normalizeRawJob });
    expect(first.newJobIds).toHaveLength(1);
    const second = await jobsService.importRaws(a, [full], { connector: "test", normalize: normalizeRawJob });
    expect(second.newJobIds).toHaveLength(0);
    expect(second.results[0]).toMatchObject({ jobId: first.newJobIds[0], duplicate: true, merged: true, upgraded: true });
    const job = await prisma.job.findUniqueOrThrow({ where: { id: first.newJobIds[0] }, include: { sources: true, skillRequirements: true } });
    expect(job.descriptionLevel).toBe("FULL");
    expect(job.description).toContain("design systems");
    expect(job.sources).toHaveLength(2);
    expect(job.skillRequirements.map((s) => s.canonicalName)).toEqual(expect.arrayContaining(["React", "TypeScript"]));
    // A later summary never downgrades the full description.
    const third = await jobsService.importRaws(a, [{ ...snippet, externalId: "LINKEDIN:9002", sourceUrl: "https://www.linkedin.com/jobs/view/9002" }], { connector: "test", normalize: normalizeRawJob });
    expect(third.results[0]).toMatchObject({ merged: true, upgraded: false });
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).descriptionLevel).toBe("FULL");
  });
});

describe("mailbox sources", () => {
  it("marks a mailbox as needing attention when the app password is rejected, and never exports credentials", async () => {
    const { fetchAlertEmailsImap } = await import("@applywise/mail-sources");
    vi.mocked(fetchAlertEmailsImap).mockRejectedValueOnce(new MailAuthError("The app password was rejected. Create a new app password and reconnect."));
    const feed = await prisma.jobFeed.create({
      data: {
        userId: a,
        kind: "MAILBOX",
        provider: "imap",
        label: "Job alerts in test",
        config: { preset: "gmail", email: "someone@gmail.com", folder: "INBOX", onlyRelevant: false },
        secretEnc: encryptText("abcd efgh ijkl mnop"),
      },
    });
    await jobFeedsService.runSync(feed.id, "manual");
    const row = await prisma.jobFeed.findUniqueOrThrow({ where: { id: feed.id } });
    expect(row.status).toBe("NEEDS_ATTENTION");
    expect(row.nextSyncAt).toBeNull();
    expect(row.lastError).toMatch(/app password was rejected/);
    // IMAP (not the Gmail API) was used for an app-password Gmail mailbox.
    expect(vi.mocked(fetchAlertEmailsImap)).toHaveBeenCalledWith(expect.objectContaining({ host: "imap.gmail.com", password: "abcd efgh ijkl mnop" }), expect.anything());
    const notices = await prisma.notification.findMany({ where: { userId: a, type: "feeds.needs_attention" } });
    expect(notices).toHaveLength(1);
    // Keyed by the feed and its failure streak (the first failed sync of the streak).
    const failedRun = await prisma.jobFeedRun.findFirstOrThrow({ where: { feedId: feed.id } });
    expect(notices[0]!.dedupeKey).toBe(`feeds.needs_attention:${feed.id}:${failedRun.id}`);
    // The scheduler leaves it alone until the user reconnects.
    await jobFeedsService.tick();
    expect(await prisma.jobFeedRun.count({ where: { feedId: feed.id } })).toBe(1);

    const exported = JSON.stringify(await accountService.export(a));
    expect(exported).not.toContain("abcd efgh ijkl mnop");
    expect(exported).not.toContain(row.secretEnc!);
    expect(exported).toContain("Job alerts in test");

    const overview = await jobFeedsService.overview(a);
    const view = overview.feeds.find((f) => f.id === feed.id)!;
    expect(JSON.stringify(view)).not.toContain(row.secretEnc!);
    expect(view).toMatchObject({ status: "NEEDS_ATTENTION", connected: true });
  });

  it("reconnects in place with a new app password after a test connection", async () => {
    const { testImapConnection, fetchAlertEmailsImap } = await import("@applywise/mail-sources");
    const feed = await prisma.jobFeed.findFirstOrThrow({ where: { userId: a, provider: "imap" } });
    vi.mocked(testImapConnection).mockResolvedValueOnce({ ok: false, message: "The app password was rejected." });
    await expect(jobFeedsService.reconnectImap(a, feed.id, "wrong-password")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    vi.mocked(testImapConnection).mockResolvedValueOnce({ ok: true, message: "Connected" });
    vi.mocked(fetchAlertEmailsImap).mockResolvedValueOnce({ messages: [], cursor: { imap: { lastUid: 5 } } });
    const view = await jobFeedsService.reconnectImap(a, feed.id, "new-app-password");
    expect(view.status).toBe("ACTIVE");
    const row = await prisma.jobFeed.findUniqueOrThrow({ where: { id: feed.id } });
    expect(row.cursor).toMatchObject({ imap: { lastUid: 5 } });
    await expect(jobFeedsService.reconnectImap(b, feed.id, "x-password")).rejects.toMatchObject({ status: 404 });
  });

  it("notifies once per failure streak: a repeated failure does not notify again, a new streak after reconnecting does", async () => {
    const { fetchAlertEmailsImap } = await import("@applywise/mail-sources");
    const feed = await prisma.jobFeed.findFirstOrThrow({ where: { userId: a, provider: "imap" } });
    expect(feed).toMatchObject({ status: "ACTIVE", consecutiveFailures: 0 });
    const before = await prisma.notification.count({ where: { userId: a, type: "feeds.needs_attention" } });
    vi.mocked(fetchAlertEmailsImap).mockRejectedValue(new MailAuthError("The app password was rejected. Create a new app password and reconnect."));
    try {
      await jobFeedsService.runSync(feed.id, "manual");
      await jobFeedsService.runSync(feed.id, "manual");
    } finally {
      vi.mocked(fetchAlertEmailsImap).mockReset();
    }
    const notices = await prisma.notification.findMany({ where: { userId: a, type: "feeds.needs_attention" }, orderBy: { createdAt: "asc" } });
    expect(notices).toHaveLength(before + 1);
    expect(new Set(notices.map((n) => n.dedupeKey)).size).toBe(notices.length);
    expect(notices.every((n) => n.dedupeKey?.startsWith(`feeds.needs_attention:${feed.id}:`))).toBe(true);
  });
});

describe("new-match notifications", () => {
  it("one notification per local day that counts up as jobs arrive, with wording that is true in every mode", async () => {
    const u = await newUser("feeds-new-matches");
    mockFetch((url) => (url.startsWith(`${GH}/jobs`) ? json(ghJobs) : undefined));
    // Scoring is not under test here: every sync reports 2 strong matches among its new jobs.
    const delegate = prisma.jobMatchScore as unknown as { count: (args: unknown) => Promise<number> };
    const original = delegate.count.bind(delegate);
    const spy = vi.spyOn(delegate, "count").mockResolvedValue(2);
    try {
      const feed = await jobFeedsService.createBoard(u, { provider: "greenhouse", slug: "acmeindiatest", companyName: "Acme India Test", onlyRelevant: false });
      // A later sync with a new job adds to the same notification.
      mockFetch((url) => (url.startsWith(`${GH}/jobs`) ? json({ jobs: [{ ...ghJobs.jobs[0]!, id: 777, title: "Staff Platform Engineer", absolute_url: "https://job-boards.greenhouse.io/acmeindiatest/jobs/777" }], meta: { total: 1 } }) : undefined));
      await jobFeedsService.syncNow(u, feed.id);
    } finally {
      spy.mockImplementation(original);
    }
    const rows = await prisma.notification.findMany({ where: { userId: u, type: "jobs.new_matches" } });
    expect(rows).toHaveLength(1);
    // No automation settings: the default timezone decides the day.
    expect(rows[0]).toMatchObject({ title: "4 new jobs match your profile", body: NEW_MATCHES_BODY, dedupeKey: `new-matches:${dayKey(new Date(), "Asia/Kolkata")}`, link: "/jobs?new=true" });
    expect(rows[0]!.body).not.toMatch(/nothing is applied/i);
  });
});

describe("sync engine safeguards (review fixes)", () => {
  const himalayasJob = (i: number, title: string) => ({
    guid: `https://himalayas.app/companies/acme/jobs/${title.toLowerCase().replace(/\W+/g, "-")}-${i}`,
    title,
    companyName: `Remote Co ${i}`,
    locationRestrictions: ["India"],
    description: "<p>Build things with Python and Django.</p><ul><li>3+ years of Python</li></ul>",
    excerpt: "Build things",
    pubDate: Math.floor(Date.now() / 1000) - 3600,
    applicationLink: `https://himalayas.app/companies/acme/jobs/${i}`,
    categories: [],
  });

  it("queues one sync at a time and refuses manual syncs of sources that need reconnecting", async () => {
    mockFetch((url) => (url.startsWith(`${GH}/jobs`) ? json(ghJobs) : undefined));
    const u = await newUser("feeds-c");
    const feed = await jobFeedsService.createBoard(u, { provider: "greenhouse", slug: "acmeindiatest", companyName: "Acme India Test", onlyRelevant: true });
    // A sync is running (unfinished run within the lease): further clicks do not queue more work.
    await prisma.jobFeedRun.create({ data: { feedId: feed.id, userId: u, trigger: "manual" } });
    expect(await jobFeedsService.syncNow(u, feed.id)).toEqual({ queued: false, alreadyRunning: true });
    expect(await jobFeedsService.syncAll(u)).toEqual({ queued: 0, alreadyRunning: 1 });
    await prisma.jobFeedRun.updateMany({ where: { feedId: feed.id, finishedAt: null }, data: { finishedAt: new Date() } });
    await prisma.jobFeed.update({ where: { id: feed.id }, data: { status: "NEEDS_ATTENTION" } });
    await expect(jobFeedsService.syncNow(u, feed.id)).rejects.toMatchObject({ code: "INVALID_STATE" });
    // Paused while a sync runs: the pause survives the end of the sync.
    await prisma.jobFeed.update({ where: { id: feed.id }, data: { status: "ACTIVE", nextSyncAt: null } });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input instanceof Request ? input.url : input);
        if (!url.startsWith(`${GH}/jobs`)) return new Response("Not found", { status: 404 });
        // The user pauses the source while the sync is fetching.
        await prisma.jobFeed.update({ where: { id: feed.id }, data: { status: "PAUSED" } });
        return json(ghJobs);
      }),
    );
    await jobFeedsService.runSync(feed.id, "manual");
    expect((await prisma.jobFeed.findUniqueOrThrow({ where: { id: feed.id } })).status).toBe("PAUSED");
  });

  it("continues a large board where it left off instead of re-importing the first page forever", async () => {
    const u = await newUser("feeds-d");
    const many = { jobs: Array.from({ length: 130 }, (_, i) => ({ ...ghJobs.jobs[0]!, id: 5000 + i, title: `Frontend Engineer ${i}`, absolute_url: `https://job-boards.greenhouse.io/acmeindiatest/jobs/${5000 + i}` })), meta: { total: 130 } };
    mockFetch((url) => (url.startsWith(`${GH}/jobs`) ? json(many) : undefined));
    const feed = await jobFeedsService.createBoard(u, { provider: "greenhouse", slug: "acmeindiatest", companyName: "Acme India Test", onlyRelevant: false });
    expect(await prisma.job.count({ where: { ownerUserId: u, feedId: feed.id } })).toBe(100);
    await jobFeedsService.syncNow(u, feed.id);
    expect(await prisma.job.count({ where: { ownerUserId: u, feedId: feed.id } })).toBe(130);
    // Known jobs are not logged again on every sync.
    await jobFeedsService.syncNow(u, feed.id);
    expect(await prisma.jobImportEvent.count({ where: { userId: u, status: "DUPLICATE" } })).toBe(0);
    // "New" counts only automatically found jobs that were not dismissed.
    const job = await prisma.job.findFirstOrThrow({ where: { ownerUserId: u, feedId: feed.id } });
    await jobsService.setState(u, job.id, { ignored: true });
    await jobsService.importManual(u, { mode: "structured", title: "Manually Added Role", company: "Hand Picked", location: ["Pune"], description: "A role I added myself with React and TypeScript requirements.", requiredSkills: [], preferredSkills: [], applyUrl: null, hrEmail: null, sourceUrl: null });
    const list = await jobsService.list(u, listQuery());
    expect(list.view.newCount).toBe(129);
    const manual = await jobsService.list(u, { ...listQuery(), q: "Manually Added" });
    expect(manual.items.find((i) => i.title === "Manually Added Role")!.isNew).toBe(false);
    // Marking seen as of the list time leaves later arrivals new.
    await jobsService.updateViewPrefs(u, { markSeen: true, asOf: new Date(Date.parse(list.view.asOf) - 60_000).toISOString() });
    expect((await jobsService.list(u, listQuery())).view.newCount).toBe(129);
    await jobsService.updateViewPrefs(u, { markSeen: true, asOf: list.view.asOf });
    expect((await jobsService.list(u, listQuery())).view.newCount).toBe(0);
  });

  it("filters saved searches by their own keywords, shares identical API responses and counts only real calls", async () => {
    const u = await newUser("feeds-e");
    const fetchFn = mockFetch((url) =>
      url.startsWith("https://himalayas.app/jobs/api/search") ? json({ totalCount: 3, jobs: [himalayasJob(1, "Senior Python Developer"), himalayasJob(2, "Python Backend Engineer"), himalayasJob(3, "Sales Lead")] }) : undefined,
    );
    // The profile targets "Frontend Engineer", but this search is for Python: the search keywords decide.
    await jobFeedsService.createSearch(u, { provider: "himalayas", keywords: "python developer", location: null, remoteOnly: true, maxDaysOld: 7 });
    const titles = (await prisma.job.findMany({ where: { ownerUserId: u, feedId: { not: null } } })).map((j) => j.title).sort();
    expect(titles).toContain("Senior Python Developer");
    expect(titles).not.toContain("Sales Lead");
    const calls = fetchFn.mock.calls.length;
    // A second user with the identical search is served from the shared response cache.
    const v = await newUser("feeds-f");
    await jobFeedsService.createSearch(v, { provider: "himalayas", keywords: "python developer", location: null, remoteOnly: true, maxDaysOld: 7 });
    expect(fetchFn.mock.calls.length).toBe(calls);
    expect(await prisma.job.count({ where: { ownerUserId: v, feedId: { not: null } } })).toBeGreaterThan(0);

    // Adzuna: the operator budget counts real API calls only.
    process.env.ADZUNA_APP_ID = "test-id";
    process.env.ADZUNA_APP_KEY = "test-key";
    try {
      const day = new Date().toISOString().slice(0, 10);
      await prisma.feedProviderUsage.upsert({ where: { provider_day: { provider: "adzuna", day } }, create: { provider: "adzuna", day, calls: 10_000 }, update: { calls: 10_000 } });
      const adz = mockFetch(() => json({ count: 0, results: [] }));
      const feed = await jobFeedsService.createSearch(u, { provider: "adzuna", keywords: "react developer", location: "Bengaluru", remoteOnly: false, maxDaysOld: 7 });
      const row = await prisma.jobFeed.findUniqueOrThrow({ where: { id: feed.id } });
      expect(row.status).toBe("ERROR");
      expect(row.lastError).toMatch(/request limit/);
      expect(row.lastError).not.toMatch(/ADZUNA|test-key/);
      expect(adz).not.toHaveBeenCalled();
    } finally {
      delete process.env.ADZUNA_APP_ID;
      delete process.env.ADZUNA_APP_KEY;
      await prisma.feedProviderUsage.deleteMany({ where: { provider: "adzuna" } });
    }
  });
});

function listQuery() {
  return { sort: "score" as const, order: "desc" as const, page: 1, pageSize: 100, platform: [], workMode: [], status: [], applyMethod: [], includeIgnored: true, savedOnly: false, newOnly: false };
}

describe("private forwarding address (signed inbound webhook)", () => {
  const fixture = (name: string) => readFileSync(resolve(__dirname, "../../../packages/job-engine/test/fixtures/alerts", name));

  it("imports every job of a forwarded alert, handles hand-forwarded mail and Gmail's confirmation, and ignores unknown recipients", async () => {
    const feed = await jobFeedsService.createForwarding(b);
    const address = String(feed.config.address);
    expect(address).toMatch(/^jobs-[a-z0-9]+@in\.applywise\.test$/);
    expect(feed.config.token).toBeUndefined();

    // Gmail's forwarding confirmation is surfaced for the user to confirm themselves.
    const confirmation = [
      "From: Gmail Team <forwarding-noreply@google.com>",
      "To: " + address,
      "Subject: (#123456789) Gmail Forwarding Confirmation - Receive Mail from someone@gmail.com",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "someone@gmail.com has requested to automatically forward mail to your email address.",
      "To allow someone@gmail.com to automatically forward mail to your address, please click the link below to confirm the request:",
      "https://mail-settings.google.com/mail/vf-%5BANGjdJ_example%5D-abc",
      "Confirmation code: 123456789",
    ].join("\r\n");
    expect(await jobFeedsService.handleInbound(address, Buffer.from(confirmation))).toMatchObject({ kind: "forwarding_confirmation" });
    // A relay retry (or a repeated confirmation) does not notify twice.
    expect(await jobFeedsService.handleInbound(address, Buffer.from(confirmation))).toMatchObject({ kind: "forwarding_confirmation" });
    const confirmationNotices = await prisma.notification.findMany({ where: { userId: b, type: "feeds.forwarding_confirmation" } });
    expect(confirmationNotices.map((n) => n.dedupeKey)).toEqual([`feeds.forwarding_confirmation:${feed.id}`]);
    const overview = await jobFeedsService.overview(b);
    const fwdFeed = overview.feeds.find((f) => f.id === feed.id)!;
    expect(fwdFeed.forwardingConfirmation).toMatchObject({ code: "123456789" });
    expect(fwdFeed.forwardingConfirmation!.confirmUrl).toMatch(/^https:\/\/mail-settings\.google\.com\/mail\/vf-/);

    // The first forwarded alert proves forwarding works: the prompt goes away.
    const r = await jobFeedsService.handleInbound(address, fixture("linkedin-digest.eml"));
    expect(r).toMatchObject({ accepted: true, kind: "job_alert" });
    const jobs = await prisma.job.findMany({ where: { ownerUserId: b, feedId: feed.id }, orderBy: { createdAt: "asc" } });
    expect(jobs.length).toBeGreaterThanOrEqual(3);
    expect(jobs.every((j) => j.descriptionLevel === "SNIPPET")).toBe(true);
    expect(jobs.map((j) => j.title)).toContain("Senior Python Developer");
    // Stored source metadata never contains the email subject or the recipient.
    const events = await prisma.jobImportEvent.findMany({ where: { userId: b, jobId: { in: jobs.map((j) => j.id) } } });
    expect(JSON.stringify(events)).not.toMatch(/asha@example\.test|python developer": Northwind/);

    // The same alert again: nothing new.
    await jobFeedsService.handleInbound(address, fixture("linkedin-digest.eml"));
    expect(await prisma.job.count({ where: { ownerUserId: b, feedId: feed.id } })).toBe(jobs.length);

    // A hand-forwarded Naukri alert (the user is the sender) still imports its jobs.
    const before = await prisma.job.count({ where: { ownerUserId: b } });
    const fwd = await jobFeedsService.handleInbound(address, fixture("naukri-forwarded.eml"));
    expect(fwd).toMatchObject({ accepted: true, kind: "job_alert" });
    expect(await prisma.job.count({ where: { ownerUserId: b } })).toBeGreaterThan(before);

    expect((await jobFeedsService.overview(b)).feeds.find((f) => f.id === feed.id)!.forwardingConfirmation).toBeNull();
    expect(await jobFeedsService.handleInbound("jobs-doesnotexist12345@in.applywise.test", fixture("linkedin-digest.eml"))).toMatchObject({ accepted: false });
    expect(await jobFeedsService.handleInbound("someone@else.test", fixture("linkedin-digest.eml"))).toMatchObject({ accepted: false });
  });
});
