import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, type ApplicationStatus } from "@applywise/database";
import type * as JobEngine from "@applywise/job-engine";
import { applicationProviderForJob, type JobProvider, type StatusCheckResult } from "@applywise/job-engine";
import { sha256Hex } from "@/server/crypto";
import { applicationEmailTrackingService } from "@/server/services/application-email-tracking.service";
import { applicationStatusSyncService, DEMO_STATUS_SYNC_INTERVAL_MS } from "@/server/services/application-status-sync.service";
import { authService } from "@/server/services/auth.service";
import { jobFeedsService } from "@/server/services/job-feeds.service";

// The provider registry is implemented by another workstream: only its resolver is replaced here.
vi.mock("@applywise/job-engine", async (importOriginal) => {
  const actual = await importOriginal<typeof JobEngine>();
  return { ...actual, applicationProviderForJob: vi.fn() };
});

const BODY_MARKER = "BODY-MARKER-7f3c";

async function newUser(label: string) {
  const { userId } = await authService.signUp({
    name: label,
    email: `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.test`,
    password: "Password123",
    acceptTerms: true,
  });
  return userId;
}

interface AppOpts {
  company: string;
  title: string;
  companyWebsite?: string | null;
  status?: ApplicationStatus;
  externalApplicationId?: string | null;
  isDemo?: boolean;
  lastStatusSyncAt?: Date | null;
  appliedAt?: Date;
}

async function sentApplication(userId: string, o: AppOpts) {
  const job = await prisma.job.create({
    data: {
      ownerUserId: userId,
      platform: "GREENHOUSE",
      title: o.title,
      company: o.company,
      companyWebsite: o.companyWebsite ?? null,
      description: "Test job.",
      importMethod: "MANUAL_ENTRY",
      applyMethod: "PLATFORM",
      dedupeKey: `email-tracking-test:${randomUUID()}`,
      isDemo: o.isDemo ?? false,
    },
  });
  return prisma.application.create({
    data: {
      userId,
      jobId: job.id,
      applyMethod: "PLATFORM",
      origin: "AUTOMATION",
      status: o.status ?? "APPLIED",
      appliedAt: o.appliedAt ?? new Date(Date.now() - 3 * 86_400_000),
      externalApplicationId: o.externalApplicationId ?? null,
      lastStatusSyncAt: o.lastStatusSyncAt ?? null,
    },
  });
}

const statusOf = async (id: string) => (await prisma.application.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;

function message(subject: string, text: string, from = "Acme Talent <talent@acme-test.com>", messageId = `<${randomUUID()}@mail.test>`) {
  return { messageId, from, subject, text, receivedAt: new Date() };
}

describe("application status email tracking (ingest)", () => {
  let userId: string;
  let acme: { id: string };
  let globex: { id: string };

  beforeEach(async () => {
    userId = await newUser("email-tracking");
    acme = await sentApplication(userId, { company: "Acme Test Pvt Ltd", title: "Frontend Engineer", companyWebsite: "https://www.acme-test.com" });
    globex = await sentApplication(userId, { company: "Globex Systems", title: "Data Analyst" });
  });

  it("moves APPLIED -> INTERVIEW for a confident, associated email and stores metadata only", async () => {
    const m = message(
      "Interview invitation - Frontend Engineer",
      `Hi Asha, we reviewed your profile and would like to invite you to a technical interview. Please share your availability for a call. ${BODY_MARKER}`,
    );
    const r = await applicationEmailTrackingService.ingest(userId, m, "inbound");
    expect(r).toEqual({ stored: true, duplicate: false, category: "INTERVIEW", applicationId: acme.id, statusApplied: "INTERVIEW" });
    expect(await statusOf(acme.id)).toBe("INTERVIEW");
    expect(await statusOf(globex.id)).toBe("APPLIED");

    const event = await prisma.applicationEvent.findFirstOrThrow({ where: { applicationId: acme.id, type: "status_update" } });
    expect(event).toMatchObject({ fromStatus: "APPLIED", toStatus: "INTERVIEW", actor: "system", message: "Detected from an email: interview" });

    // Metadata only: a hash of the message id, the sender domain and the subject - never the body or the address.
    const row = await prisma.applicationMessage.findFirstOrThrow({ where: { userId } });
    expect(row).toMatchObject({
      applicationId: acme.id,
      category: "INTERVIEW",
      messageHash: sha256Hex(m.messageId),
      fromDomain: "acme-test.com",
      subject: "Interview invitation - Frontend Engineer",
      statusApplied: true,
      source: "inbound",
    });
    expect(row.associatedBy).toContain("domain");
    const everything = JSON.stringify([
      row,
      await prisma.applicationEvent.findMany({ where: { userId } }),
      await prisma.notification.findMany({ where: { userId } }),
      await prisma.auditLog.findMany({ where: { userId } }),
    ]);
    expect(everything).not.toContain(BODY_MARKER);
    expect(everything).not.toContain("talent@acme-test.com");
    expect(everything).not.toContain(m.messageId);

    const notification = await prisma.notification.findFirstOrThrow({ where: { userId, type: "application.interview" } });
    expect(notification).toMatchObject({ dedupeKey: `msg:${row.messageHash}`, link: `/applications/${acme.id}` });
    expect(notification.title).toContain("Frontend Engineer at Acme Test Pvt Ltd");
    expect(await prisma.auditLog.count({ where: { userId, action: "application.status_detected", entityId: acme.id } })).toBe(1);
  });

  it("deduplicates the same message", async () => {
    const m = message("Interview invitation - Frontend Engineer", "We would like to invite you to an interview. Please share your availability.");
    expect((await applicationEmailTrackingService.ingest(userId, m, "inbound")).stored).toBe(true);
    const again = await applicationEmailTrackingService.ingest(userId, { ...m, subject: "changed", text: "changed" }, "inbound");
    expect(again).toMatchObject({ stored: false, duplicate: true, category: "INTERVIEW", applicationId: acme.id, statusApplied: null });
    expect(await prisma.applicationMessage.count({ where: { userId } })).toBe(1);
    expect(await prisma.notification.count({ where: { userId, type: "application.interview" } })).toBe(1);
    expect(await prisma.applicationEvent.count({ where: { applicationId: acme.id, type: "status_update" } })).toBe(1);
  });

  it("does not change the status below the confidence threshold", async () => {
    const r = await applicationEmailTrackingService.ingest(userId, message("Globex Systems - Data Analyst", "We are updating our interview process and will share details soon.", "hr@mail.test"), "inbound");
    expect(r).toMatchObject({ stored: true, category: "INTERVIEW", applicationId: globex.id, statusApplied: null });
    expect(await statusOf(globex.id)).toBe("APPLIED");
    const row = await prisma.applicationMessage.findFirstOrThrow({ where: { userId } });
    expect(row.statusApplied).toBe(false);
    expect(row.confidence).toBeLessThan(0.7);
    expect(await prisma.applicationEvent.count({ where: { applicationId: globex.id, type: "status_email" } })).toBe(1);
    expect(await prisma.notification.count({ where: { userId } })).toBe(0);
  });

  it("does not transition from a status that does not allow it", async () => {
    await prisma.application.update({ where: { id: acme.id }, data: { status: "INTERVIEW" } });
    const r = await applicationEmailTrackingService.ingest(userId, message("Second round interview - Frontend Engineer", "We would like to schedule your final round interview. Please share your availability."), "inbound");
    expect(r).toMatchObject({ category: "INTERVIEW", applicationId: acme.id, statusApplied: null });
    expect(await statusOf(acme.id)).toBe("INTERVIEW");
    expect(await prisma.applicationEvent.count({ where: { applicationId: acme.id, type: "status_update" } })).toBe(0);
    // A new interview email is still worth a notification.
    expect(await prisma.notification.count({ where: { userId, type: "application.interview" } })).toBe(1);

    // Applications that were never sent are not candidates at all.
    const draft = await sentApplication(userId, { company: "Initech", title: "QA Engineer", status: "READY_FOR_REVIEW" });
    const r2 = await applicationEmailTrackingService.ingest(userId, message("Initech - QA Engineer", "Unfortunately, we will not be moving forward.", "jobs@initech.test"), "inbound");
    expect(r2).toMatchObject({ category: "REJECTION", applicationId: null, statusApplied: null });
    expect(await statusOf(draft.id)).toBe("READY_FOR_REVIEW");
  });

  it("records an application confirmation as a timeline event only", async () => {
    const r = await applicationEmailTrackingService.ingest(
      userId,
      message("Thank you for applying to Globex Systems", "We have received your application for the Data Analyst role. If shortlisted, we will contact you to schedule an interview.", "no-reply@greenhouse.io"),
      "inbound",
    );
    expect(r).toMatchObject({ category: "APPLICATION_CONFIRMATION", applicationId: globex.id, statusApplied: null });
    expect(await statusOf(globex.id)).toBe("APPLIED");
    const event = await prisma.applicationEvent.findFirstOrThrow({ where: { applicationId: globex.id, type: "status_email" } });
    expect(event.message).toMatch(/^Application confirmation received by email/);
    expect(event.fromStatus).toBeNull();
    expect(await prisma.notification.count({ where: { userId } })).toBe(0);
  });

  it("stores an unassociated email without touching any application", async () => {
    const r = await applicationEmailTrackingService.ingest(userId, message("Interview invitation", "We would like to invite you to an interview.", "talent@unknown-co.test"), "inbound");
    expect(r).toMatchObject({ stored: true, category: "INTERVIEW", applicationId: null, statusApplied: null });
    const row = await prisma.applicationMessage.findFirstOrThrow({ where: { userId } });
    expect(row).toMatchObject({ applicationId: null, associatedBy: null, fromDomain: "unknown-co.test" });
    expect(await statusOf(acme.id)).toBe("APPLIED");
    expect(await statusOf(globex.id)).toBe("APPLIED");
    expect(await prisma.notification.count({ where: { userId } })).toBe(0);
  });

  it("truncates long subjects", async () => {
    await applicationEmailTrackingService.ingest(userId, message(`Update ${"x".repeat(400)}`, "Hello"), "mailbox");
    const row = await prisma.applicationMessage.findFirstOrThrow({ where: { userId } });
    expect(row.subject.length).toBe(200);
    expect(row).toMatchObject({ category: "OTHER", source: "mailbox" });
  });
});

describe("provider status sync", () => {
  const mockedResolver = vi.mocked(applicationProviderForJob);

  function provider(check: JobProvider["checkApplicationStatus"]): JobProvider {
    return { id: "test-ats", info: () => ({}) as never, matchesJob: () => true, ...(check ? { checkApplicationStatus: check } : {}) };
  }

  it("applies provider statuses, runs demo messages through email tracking and respects the interval", async () => {
    const userId = await newUser("status-sync");
    const hourAgo = new Date(Date.now() - 60 * 60_000);
    const demo = await sentApplication(userId, { company: "Demo Nimbus Labs", title: "Platform Engineer", isDemo: true, externalApplicationId: "demo-1", lastStatusSyncAt: hourAgo });
    const recent = await sentApplication(userId, { company: "Hooli", title: "Backend Engineer", externalApplicationId: "gh-recent", lastStatusSyncAt: hourAgo });
    const never = await sentApplication(userId, { company: "Pied Piper", title: "Data Engineer", externalApplicationId: "gh-never" });
    const noExternal = await sentApplication(userId, { company: "Vandelay", title: "Sales Engineer" });

    const check = vi.fn(async (ref: { externalApplicationId: string }): Promise<StatusCheckResult> => {
      if (ref.externalApplicationId === "demo-1") {
        return {
          status: "INTERVIEW",
          detail: "Interview scheduled (demo)",
          message: {
            from: "Demo Nimbus Labs Recruiting <careers@demo-nimbus-labs.example>",
            subject: "Interview invitation - Platform Engineer at Demo Nimbus Labs",
            text: "Hi, we would like to invite you to a technical interview. Please share your availability for a call.",
            receivedAt: new Date().toISOString(),
            category: "INTERVIEW",
          },
        };
      }
      return { status: "REJECTED", detail: "Not selected", message: null };
    });
    mockedResolver.mockImplementation(() => provider(check));

    expect(await applicationStatusSyncService.dueUsers(new Date(), 100_000)).toContain(userId);

    const first = await applicationStatusSyncService.syncUser(userId);
    expect(first).toMatchObject({ checked: 2, updated: 2, messages: 1, failed: 0 });
    expect(check).toHaveBeenCalledTimes(2);
    // The demo message went through classification + association and moved the application itself.
    expect(await statusOf(demo.id)).toBe("INTERVIEW");
    const demoMessage = await prisma.applicationMessage.findFirstOrThrow({ where: { userId } });
    expect(demoMessage).toMatchObject({ applicationId: demo.id, source: "demo", category: "INTERVIEW", statusApplied: true });
    // The provider's own status for a job without a message.
    expect(await statusOf(never.id)).toBe("REJECTED");
    const syncEvent = await prisma.applicationEvent.findFirstOrThrow({ where: { applicationId: never.id, type: "status_update" } });
    expect(syncEvent).toMatchObject({ actor: "system", toStatus: "REJECTED" });
    expect(await prisma.notification.count({ where: { userId, type: "application.rejected", dedupeKey: `status:${never.id}:APPLIED->REJECTED` } })).toBe(1);
    // Checked within 6 hours: skipped. Without an external id: never checked.
    expect(await statusOf(recent.id)).toBe("APPLIED");
    expect(await statusOf(noExternal.id)).toBe("APPLIED");
    const synced = await prisma.application.findMany({ where: { id: { in: [demo.id, never.id, noExternal.id] } }, select: { id: true, lastStatusSyncAt: true } });
    expect(synced.find((a) => a.id === noExternal.id)!.lastStatusSyncAt).toBeNull();
    expect(synced.find((a) => a.id === never.id)!.lastStatusSyncAt!.getTime()).toBeGreaterThan(hourAgo.getTime());

    // Demo jobs are due again after 10 minutes (not on every tick); the same simulated message is not stored twice and nothing changes.
    check.mockClear();
    expect((await applicationStatusSyncService.syncUser(userId)).checked).toBe(0);
    await prisma.application.update({ where: { id: demo.id }, data: { lastStatusSyncAt: new Date(Date.now() - DEMO_STATUS_SYNC_INTERVAL_MS - 1_000) } });
    const second = await applicationStatusSyncService.syncUser(userId);
    expect(second).toMatchObject({ checked: 1, updated: 0, messages: 1 });
    expect(await prisma.applicationMessage.count({ where: { userId } })).toBe(1);
    expect(await prisma.notification.count({ where: { userId, type: "application.interview" } })).toBe(1);

    // force checks the recently synced application too.
    const forced = await applicationStatusSyncService.syncUser(userId, { force: true });
    expect(forced.checked).toBe(2);
    expect(await statusOf(recent.id)).toBe("REJECTED");
  });

  it("notifies each status change, including a later change back to a status seen before (keys name the transition)", async () => {
    const userId = await newUser("status-sync-rounds");
    const app = await sentApplication(userId, { company: "Initech", title: "Platform Engineer", externalApplicationId: "rounds-1" });
    let reported: "INTERVIEW" | "ASSESSMENT" = "INTERVIEW";
    mockedResolver.mockImplementation(() => provider(async () => ({ status: reported, detail: "Status from the provider", message: null })));

    await applicationStatusSyncService.syncUser(userId, { force: true }); // APPLIED -> INTERVIEW
    await applicationStatusSyncService.syncUser(userId, { force: true }); // same report again: no change, no notice
    reported = "ASSESSMENT";
    await applicationStatusSyncService.syncUser(userId, { force: true }); // INTERVIEW -> ASSESSMENT
    reported = "INTERVIEW";
    await applicationStatusSyncService.syncUser(userId, { force: true }); // ASSESSMENT -> INTERVIEW: a second interview round
    expect(await statusOf(app.id)).toBe("INTERVIEW");

    const notices = await prisma.notification.findMany({ where: { userId } });
    expect(notices.map((n) => n.dedupeKey).sort()).toEqual([`status:${app.id}:APPLIED->INTERVIEW`, `status:${app.id}:ASSESSMENT->INTERVIEW`, `status:${app.id}:INTERVIEW->ASSESSMENT`]);
    expect(notices.filter((n) => n.type === "application.interview")).toHaveLength(2);
  });

  it("skips providers without status tracking and survives provider errors", async () => {
    const userId = await newUser("status-sync-errors");
    const a = await sentApplication(userId, { company: "Umbrella", title: "Analyst", externalApplicationId: "x-1" });
    const b = await sentApplication(userId, { company: "Soylent", title: "Chemist", externalApplicationId: "x-2" });

    mockedResolver.mockImplementation((job) => {
      if (job.company === "Umbrella") return provider(undefined);
      return provider(async () => {
        throw new Error("provider down");
      });
    });
    const r = await applicationStatusSyncService.syncUser(userId);
    expect(r).toMatchObject({ checked: 1, updated: 0, failed: 1 });
    expect(await statusOf(a.id)).toBe("APPLIED");
    expect(await statusOf(b.id)).toBe("APPLIED");
    // Both are marked as checked: neither is retried before the interval.
    const rows = await prisma.application.findMany({ where: { id: { in: [a.id, b.id] } }, select: { lastStatusSyncAt: true } });
    expect(rows.every((x) => x.lastStatusSyncAt !== null)).toBe(true);
    expect(await applicationStatusSyncService.dueUsers(new Date(), 100_000)).not.toContain(userId);
    expect(await applicationStatusSyncService.dueUsers(new Date(Date.now() + 7 * 60 * 60_000), 100_000)).toContain(userId);
  });
});

describe("forwarding address: application status emails", () => {
  function rawEmail(headers: Record<string, string>, body: string): Buffer {
    const lines = Object.entries(headers).map(([k, v]) => `${k}: ${v}`);
    return Buffer.from([...lines, "Content-Type: text/plain; charset=utf-8", "", body].join("\r\n"));
  }

  it("tracks an employer email that is not a job alert, deduplicates relay retries and unwraps hand-forwarded mail", async () => {
    const userId = await newUser("inbound-status");
    const feed = await jobFeedsService.createForwarding(userId);
    const address = String(feed.config.address);
    const acme = await sentApplication(userId, { company: "Acme Test", title: "Frontend Engineer", companyWebsite: "acme-test.com" });
    const globex = await sentApplication(userId, { company: "Globex Systems", title: "Data Analyst" });

    const rejection = rawEmail(
      {
        From: "Acme Test Careers <careers@acme-test.com>",
        To: address,
        Subject: "Your application for Frontend Engineer at Acme Test",
        Date: new Date().toUTCString(),
        "Message-ID": `<${randomUUID()}@acme-test.com>`,
      },
      `Thank you for your interest in Acme Test. Unfortunately, we have decided to move forward with other candidates. ${BODY_MARKER}`,
    );
    const r = await jobFeedsService.handleInbound(address, rejection);
    expect(r).toEqual({ accepted: true, kind: "status_email", category: "REJECTION", duplicate: false, associated: true, statusApplied: true });
    expect(await statusOf(acme.id)).toBe("REJECTED");
    expect(await prisma.job.count({ where: { ownerUserId: userId, feedId: feed.id } })).toBe(0);
    expect(await prisma.notification.count({ where: { userId, type: "application.rejected" } })).toBe(1);

    // The relay retries the same delivery: nothing happens twice.
    expect(await jobFeedsService.handleInbound(address, rejection)).toMatchObject({ kind: "status_email", duplicate: true });
    expect(await prisma.applicationMessage.count({ where: { userId } })).toBe(1);

    // Hand-forwarded by the user: the original employer message inside is classified and associated.
    const forwarded = rawEmail(
      { From: "Asha <asha@example.test>", To: address, Subject: "Fwd: Next steps", Date: new Date().toUTCString(), "Message-ID": `<${randomUUID()}@example.test>` },
      [
        "Forwarding this one.",
        "",
        "---------- Forwarded message ---------",
        "From: Globex Systems Hiring <hiring@globexsystems.com>",
        "Date: Mon, 21 Sep 2026 at 10:00",
        "Subject: Next steps for the Data Analyst role",
        "To: <asha@example.test>",
        "",
        "Hi Asha, we would like to invite you to complete an online assessment on HackerRank within 5 days.",
      ].join("\r\n"),
    );
    expect(await jobFeedsService.handleInbound(address, forwarded)).toMatchObject({ kind: "status_email", category: "ASSESSMENT", associated: true, statusApplied: true });
    expect(await statusOf(globex.id)).toBe("ASSESSMENT");
    const stored = await prisma.applicationMessage.findFirstOrThrow({ where: { userId, applicationId: globex.id } });
    expect(stored).toMatchObject({ fromDomain: "globexsystems.com", subject: "Next steps for the Data Analyst role", source: "inbound" });

    // The job-feed run is recorded without jobs, and no email content reaches any stored row.
    const runs = await prisma.jobFeedRun.findMany({ where: { feedId: feed.id } });
    expect(runs.every((run) => run.finishedAt !== null && run.fetched === 0 && run.error === null)).toBe(true);
    const everything = JSON.stringify([await prisma.applicationMessage.findMany({ where: { userId } }), runs, await prisma.jobFeed.findUnique({ where: { id: feed.id } })]);
    expect(everything).not.toContain(BODY_MARKER);
    expect(everything).not.toContain("careers@acme-test.com");
  });
});
