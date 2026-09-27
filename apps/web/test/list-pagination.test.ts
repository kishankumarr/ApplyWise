import { afterAll, describe, expect, it } from "vitest";
import { prisma, type ApplicationStatus } from "@applywise/database";
import { applicationListQuerySchema, reviewQueueQuerySchema } from "@applywise/validation";
import { applicationService } from "@/server/services/application.service";
import { reviewQueueService } from "@/server/services/review-queue.service";
import { bareUser, disableTrackedUsers, fabricateApp } from "./automation-helpers";

/**
 * Server-side pagination of the Applications list and the review queue: pages never overlap, counts cover every row
 * (not just the loaded page), and the review queue is ranked on the server by the score the cards show.
 */

afterAll(disableTrackedUsers);

const REPORT = { summary: "Fixture", exactMatches: [], relatedMatches: [], missingMandatoryRequirements: [], missingPreferredRequirements: [] };

async function appsWith(userId: string, statuses: ApplicationStatus[]): Promise<string[]> {
  const ids: string[] = [];
  for (const [i, status] of statuses.entries()) {
    const { appId } = await fabricateApp(userId, { status, mode: "REVIEW", title: `Engineer ${i}` });
    // Distinct activity times, newest last.
    await prisma.application.update({ where: { id: appId }, data: { updatedAt: new Date(Date.now() - (statuses.length - i) * 60_000) } });
    ids.push(appId);
  }
  return ids;
}

describe("applications list pagination", () => {
  it("pages through a view without overlap, with per-view counts and the attention filter", async () => {
    const userId = await bareUser("list-pages", { profile: true });
    const statuses: ApplicationStatus[] = [
      ...Array<ApplicationStatus>(7).fill("APPLIED"),
      "NEEDS_INFORMATION",
      "MANUAL_ACTION_REQUIRED",
      "WAITING_APPROVAL",
      ...Array<ApplicationStatus>(3).fill("MATCHED"),
    ];
    const ids = await appsWith(userId, statuses);

    const first = await applicationService.list(userId, { view: "active", page: 1, pageSize: 4 });
    expect(first).toMatchObject({ total: 10, page: 1, pageSize: 4, counts: { active: 10, pipeline: 3, all: 13 }, attention: 3 });
    expect(first.items).toHaveLength(4);
    const seen = new Set<string>();
    for (let page = 1; page <= 3; page++) {
      const r = await applicationService.list(userId, { view: "active", page, pageSize: 4 });
      for (const a of r.items) seen.add(a.id);
      expect(r.items.every((a) => a.status !== "MATCHED")).toBe(true);
    }
    // Every active application exactly once, newest activity first.
    expect(seen.size).toBe(10);
    expect(first.items[0]!.id).toBe(ids[9]);
    expect((await applicationService.list(userId, { view: "active", page: 4, pageSize: 4 })).items).toHaveLength(0);

    const attention = await applicationService.list(userId, { view: "active", attention: true, page: 1, pageSize: 25 });
    expect(attention.total).toBe(3);
    expect(attention.items.map((a) => a.status).sort()).toEqual(["MANUAL_ACTION_REQUIRED", "NEEDS_INFORMATION", "WAITING_APPROVAL"]);
    expect((await applicationService.list(userId, { view: "pipeline", page: 1, pageSize: 25 })).total).toBe(3);
  });

  it("validates the query: 25 per page by default, at most 100", () => {
    expect(applicationListQuerySchema.parse({})).toMatchObject({ view: "active", page: 1, pageSize: 25, attention: false });
    expect(applicationListQuerySchema.parse({ page: "3", pageSize: "50", attention: "true" })).toMatchObject({ page: 3, pageSize: 50, attention: true });
    expect(applicationListQuerySchema.safeParse({ pageSize: "101" }).success).toBe(false);
    expect(applicationListQuerySchema.safeParse({ page: "0" }).success).toBe(false);
    expect(reviewQueueQuerySchema.parse({})).toMatchObject({ page: 1, pageSize: 10 });
    expect(reviewQueueQuerySchema.safeParse({ pageSize: "51" }).success).toBe(false);
  });
});

describe("review queue pagination", () => {
  it("ranks the whole queue on the server by the displayed score and pages it without overlap", async () => {
    const userId = await bareUser("review-pages", { profile: true });
    const scores = [40, 90, 65, 80, 55];
    const ids: string[] = [];
    for (const [i, score] of scores.entries()) {
      const { appId, jobId } = await fabricateApp(userId, { status: "WAITING_APPROVAL", mode: "REVIEW", title: `Reviewer ${i}` });
      await prisma.jobMatchScore.create({ data: { userId, jobId, score, label: "good", recommendation: "apply", report: REPORT, engineVersion: "test", factsVersion: 1 } });
      ids.push(appId);
    }
    // Not in the queue: another status, or skipped until later.
    await fabricateApp(userId, { status: "APPLIED", mode: "REVIEW" });
    const skipped = await fabricateApp(userId, { status: "WAITING_APPROVAL", mode: "REVIEW" });
    await prisma.application.update({ where: { id: skipped.appId }, data: { skippedUntil: new Date(Date.now() + 86_400_000) } });

    const p1 = await reviewQueueService.page(userId, { page: 1, pageSize: 2 });
    const p2 = await reviewQueueService.page(userId, { page: 2, pageSize: 2 });
    const p3 = await reviewQueueService.page(userId, { page: 3, pageSize: 2 });
    expect([p1.total, p2.total, p3.total]).toEqual([5, 5, 5]);
    expect([...p1.items, ...p2.items, ...p3.items].map((i) => i.match.score)).toEqual([90, 80, 65, 55, 40]);
    expect(p3.items).toHaveLength(1);
    expect(await reviewQueueService.count(userId)).toBe(5);

    // One item on its own, for any of the user's applications (the skipped one too); never another user's.
    expect((await reviewQueueService.item(userId, skipped.appId)).applicationId).toBe(skipped.appId);
    const other = await bareUser("review-pages-other", { profile: true });
    await expect(reviewQueueService.item(other, ids[0]!)).rejects.toMatchObject({ status: 404 });
  });
});
