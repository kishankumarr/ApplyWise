import "server-only";
import { prisma, type Prisma } from "@applywise/database";
import type { AutomationRunDetail, AutomationRunItemsPage, AutomationRunItemView, AutomationRunProviderDetail, AutomationRunSummary } from "@applywise/types";
import { Errors } from "../errors";

/** Run counters. Incremented atomically, so tasks finishing after the run (prepare/execute) still update it. */
export type RunCounter =
  | "providersChecked"
  | "jobsFound"
  | "newJobs"
  | "duplicates"
  | "jobsMatched"
  | "ignored"
  | "recommended"
  | "reviewRequired"
  | "autoEligible"
  | "applicationsPrepared"
  | "applicationsSubmitted"
  | "needsInformation"
  | "manualActions"
  | "failures";

type RunRow = Prisma.AutomationRunGetPayload<object>;

export function runSummary(r: RunRow): AutomationRunSummary {
  return {
    id: r.id,
    trigger: r.trigger,
    status: r.status,
    mode: r.mode,
    startedAt: r.startedAt.toISOString(),
    completedAt: r.completedAt?.toISOString() ?? null,
    providersChecked: r.providersChecked,
    jobsFound: r.jobsFound,
    newJobs: r.newJobs,
    duplicates: r.duplicates,
    jobsMatched: r.jobsMatched,
    ignored: r.ignored,
    recommended: r.recommended,
    reviewRequired: r.reviewRequired,
    autoEligible: r.autoEligible,
    applicationsPrepared: r.applicationsPrepared,
    applicationsSubmitted: r.applicationsSubmitted,
    needsInformation: r.needsInformation,
    manualActions: r.manualActions,
    failures: r.failures,
    error: r.error,
  };
}

export const automationRunsService = {
  async increment(runId: string | null | undefined, counters: Partial<Record<RunCounter, number>>): Promise<void> {
    if (!runId) return;
    const data: Prisma.AutomationRunUpdateInput = {};
    for (const [k, v] of Object.entries(counters)) if (v) (data as Record<string, unknown>)[k] = { increment: v };
    if (Object.keys(data).length === 0) return;
    await prisma.automationRun.updateMany({ where: { id: runId }, data: data as Prisma.AutomationRunUpdateManyMutationInput });
  },

  async item(
    runId: string | null | undefined,
    userId: string,
    item: { stage: string; outcome: string; message: string; jobId?: string | null; applicationId?: string | null; metadata?: Record<string, unknown> },
  ): Promise<void> {
    if (!runId) return;
    await prisma.automationRunItem.create({
      data: {
        runId,
        userId,
        stage: item.stage,
        outcome: item.outcome,
        message: item.message.slice(0, 500),
        jobId: item.jobId ?? null,
        applicationId: item.applicationId ?? null,
        metadata: (item.metadata ?? {}) as Prisma.InputJsonValue,
      },
    });
  },

  async list(userId: string, opts: { limit?: number; cursor?: string | null } = {}): Promise<{ runs: AutomationRunSummary[]; nextCursor: string | null }> {
    const take = Math.min(Math.max(opts.limit ?? 20, 1), 100);
    const rows = await prisma.automationRun.findMany({
      where: { userId },
      orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      take: take + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    });
    return { runs: rows.slice(0, take).map(runSummary), nextCursor: rows.length > take ? rows[take - 1]!.id : null };
  },

  /** Summary, counters and per-provider results. The timeline is paged separately: items(). */
  async get(userId: string, runId: string): Promise<AutomationRunDetail> {
    const run = await prisma.automationRun.findFirst({ where: { id: runId, userId } });
    if (!run) throw Errors.notFound("Automation run");
    const details = (run.details ?? {}) as { providers?: AutomationRunProviderDetail[] };
    return { ...runSummary(run), providers: details.providers ?? [] };
  },

  /**
   * One page of a run's timeline, oldest first (createdAt, then id: stable while the run keeps adding steps), narrowed
   * to a stage / outcome / message search, with facet counts for the filter chips. 404 unless the run is the user's.
   */
  async items(userId: string, runId: string, opts: { page?: number; pageSize?: number; stage?: string | null; outcome?: string | null; q?: string | null } = {}): Promise<AutomationRunItemsPage> {
    const page = Math.max(1, Math.floor(opts.page ?? 1));
    const pageSize = Math.min(Math.max(Math.floor(opts.pageSize ?? 50), 1), 100);
    const q = opts.q?.trim() || null;
    // userId on every item query as well: nothing leaks even before the ownership check below resolves.
    const base: Prisma.AutomationRunItemWhereInput = { runId, userId, ...(q ? { message: { contains: q, mode: "insensitive" } } : {}) };
    const byStage = opts.stage ? { stage: opts.stage } : {};
    const byOutcome = opts.outcome ? { outcome: opts.outcome } : {};
    const where = { ...base, ...byStage, ...byOutcome };
    const filtered = !!(q || opts.stage || opts.outcome);
    const [run, runTotal, filteredTotal, rows, stages, outcomes] = await Promise.all([
      prisma.automationRun.findFirst({ where: { id: runId, userId }, select: { id: true } }),
      prisma.automationRunItem.count({ where: { runId, userId } }),
      filtered ? prisma.automationRunItem.count({ where }) : null,
      prisma.automationRunItem.findMany({ where, orderBy: [{ createdAt: "asc" }, { id: "asc" }], skip: (page - 1) * pageSize, take: pageSize }),
      prisma.automationRunItem.groupBy({ by: ["stage"], where: { ...base, ...byOutcome }, _count: true }),
      prisma.automationRunItem.groupBy({ by: ["outcome"], where: { ...base, ...byStage }, _count: true }),
    ]);
    if (!run) throw Errors.notFound("Automation run");
    const jobIds = [...new Set(rows.map((i) => i.jobId).filter((x): x is string => !!x))];
    const jobs = jobIds.length ? await prisma.job.findMany({ where: { id: { in: jobIds } }, select: { id: true, title: true, company: true } }) : [];
    const byId = new Map(jobs.map((j) => [j.id, j]));
    return {
      items: rows.map((i): AutomationRunItemView => {
        const job = i.jobId ? byId.get(i.jobId) : undefined;
        return {
          id: i.id,
          stage: i.stage,
          outcome: i.outcome,
          message: i.message,
          jobId: i.jobId,
          applicationId: i.applicationId,
          job: job ? { title: job.title, company: job.company } : null,
          createdAt: i.createdAt.toISOString(),
        };
      }),
      total: filteredTotal ?? runTotal,
      page,
      pageSize,
      runTotal,
      stages: Object.fromEntries(stages.map((s) => [s.stage, s._count])),
      outcomes: Object.fromEntries(outcomes.map((o) => [o.outcome, o._count])),
    };
  },
};
