import "server-only";
import { prisma, type ApplicationStatus, type Prisma } from "@applywise/database";
import type { ClaimValidationResult, JobMatchReport, Paginated, PendingQuestion, ReviewQueueItem, RuleCheck, TailoredResumePlan } from "@applywise/types";
import type { PaginationQuery } from "@applywise/validation";
import { Errors } from "../errors";
import { applicationExecutionService } from "./application-execution.service";
import { loadProviderJob } from "./provider-job-ref";
import { selectedResumeLabels } from "./selected-resume-labels";

/** Applications waiting for the user's decision. */
export const REVIEW_STATUSES: ApplicationStatus[] = ["WAITING_APPROVAL", "READY_FOR_REVIEW", "NEEDS_INFORMATION"];

/** In the queue now: a review status and not skipped until later. */
function queueWhere(userId: string, now: Date): Prisma.ApplicationWhereInput {
  return {
    userId,
    status: { in: REVIEW_STATUSES },
    OR: [{ skippedUntil: null }, { skippedUntil: { lte: now } }],
  };
}

/** Best matches first (the order the UI shows and pages through). */
const QUEUE_ORDER: Prisma.ApplicationOrderByWithRelationInput[] = [{ decisionScore: { sort: "desc", nulls: "last" } }, { updatedAt: "desc" }, { id: "asc" }];

const itemInclude = (userId: string) =>
  ({
    job: {
      include: {
        matchScores: { where: { userId }, include: { factors: true } },
        sources: { take: 1, orderBy: { createdAt: "asc" }, select: { metadata: true } },
        feed: { select: { provider: true } },
      },
    },
    tailoredResume: true,
    coverLetter: true,
    screeningDrafts: { orderBy: { sortOrder: "asc" } },
    selectedResume: { select: { label: true, originalFileName: true } },
  }) satisfies Prisma.ApplicationInclude;

type QueueRow = Prisma.ApplicationGetPayload<{ include: ReturnType<typeof itemInclude> }>;

/** Everything needed to decide on one application in one place. */
async function toItem(userId: string, a: QueueRow, resumeLabel: string | null): Promise<ReviewQueueItem> {
  const score = a.job.matchScores[0];
  const report = score?.report as unknown as JobMatchReport | undefined;
  const checks = (a.decisionReasons ?? []) as unknown as RuleCheck[];
  const validation = a.tailoredResume?.validation as unknown as ClaimValidationResult | undefined;
  const pending = (a.pendingQuestions ?? []) as unknown as PendingQuestion[];
  const warnings = [
    ...checks.filter((c) => c.outcome === "warn" || c.outcome === "fail").map((c) => c.detail),
    ...(validation?.requiredRevisions ?? []),
    ...a.screeningDrafts.filter((d) => d.required && !d.resolved).map((d) => `No verified answer yet: ${d.question}`),
  ];
  const [executor, { sourceProviderId }] = await Promise.all([
    applicationExecutionService.describeExecutor(userId, a.id).catch(() => null),
    loadProviderJob(userId, a.jobId).catch(() => ({ sourceProviderId: "unknown" })),
  ]);
  return {
    applicationId: a.id,
    status: a.status,
    mode: a.mode,
    job: {
      id: a.job.id,
      title: a.job.title,
      company: a.job.company,
      locations: a.job.locations,
      workMode: a.job.workMode,
      platform: a.job.platform,
      providerId: sourceProviderId,
      salaryMin: a.job.salaryMin,
      salaryMax: a.job.salaryMax,
      currency: a.job.currency,
      experienceMinYears: a.job.experienceMinYears,
      experienceMaxYears: a.job.experienceMaxYears,
      postedAt: a.job.postedAt?.toISOString() ?? null,
      applyUrl: a.job.applyUrl,
      isDemo: a.job.isDemo,
    },
    match: {
      score: score?.score ?? null,
      label: score?.label ?? null,
      summary: report?.summary ?? null,
      factors: (score?.factors ?? []).map((f) => ({
        key: f.key,
        label: f.label,
        points: f.points,
        maxPoints: f.maxPoints,
        explanation: f.explanation,
      })),
      matchedSkills: report ? [...report.exactMatches, ...report.relatedMatches].map((m) => m.requirement) : [],
      missingSkills: report ? [...report.missingMandatoryRequirements, ...report.missingPreferredRequirements].map((m) => m.requirement) : [],
    },
    decision: {
      decision: a.automationDecision,
      reasons: checks
        .filter((c) => c.outcome !== "skip" && c.outcome !== "pass")
        .map((c) => c.detail)
        .slice(0, 6),
    },
    resume: {
      selectedResumeId: a.selectedResumeId,
      label: resumeLabel,
      score: a.resumeSelectionScore,
      reason: a.resumeSelectionReason,
      overridden: a.resumeSelectionOverridden,
    },
    tailored: a.tailoredResume
      ? {
          summary: a.tailoredResume.editedSummary ?? (a.tailoredResume.plan as unknown as TailoredResumePlan).summary.text,
          unsupportedClaims: validation?.unsupportedClaims.length ?? 0,
          status: a.tailoredResume.status,
        }
      : null,
    coverLetter: a.coverLetter?.body ?? null,
    answers: a.screeningDrafts.map((d) => ({
      id: d.id,
      key: d.questionKey,
      question: d.question,
      answer: d.answer,
      source: d.answerSource,
      resolved: d.resolved,
      required: d.required,
    })),
    pendingQuestions: pending,
    warnings: [...new Set(warnings)].slice(0, 10),
    executor: executor
      ? {
          kind: executor.kind,
          id: executor.id,
          label: executor.label,
          automatic: executor.automatic,
          detail: executor.detail,
        }
      : null,
    manualActionReason: a.manualActionReason,
    manualActionDetail: a.manualActionDetail,
    updatedAt: a.updatedAt.toISOString(),
  };
}

async function toItems(userId: string, rows: QueueRow[]): Promise<ReviewQueueItem[]> {
  const labels = await selectedResumeLabels(userId, rows);
  return Promise.all(rows.map((a, i) => toItem(userId, a, labels[i] ?? null)));
}

export const reviewQueueService = {
  /** One page of the queue, best matches first. Only the visible page is loaded and described. */
  async page(userId: string, query: Partial<PaginationQuery> = {}, now = new Date()): Promise<Paginated<ReviewQueueItem>> {
    const pageSize = query.pageSize ?? 10;
    const page = query.page ?? 1;
    // Rank the whole queue on a light projection (the displayed match score, else the score at decision time),
    // then load and describe only the requested page.
    const ranked = await prisma.application.findMany({
      where: queueWhere(userId, now),
      orderBy: QUEUE_ORDER,
      select: {
        id: true,
        decisionScore: true,
        job: { select: { matchScores: { where: { userId }, select: { score: true } } } },
      },
    });
    const score = (r: (typeof ranked)[number]) => r.job.matchScores[0]?.score ?? r.decisionScore ?? -1;
    const ids = ranked
      .map((r, index) => ({ id: r.id, score: score(r), index }))
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .slice((page - 1) * pageSize, page * pageSize)
      .map((r) => r.id);
    const rows = ids.length
      ? await prisma.application.findMany({
          where: { id: { in: ids }, userId },
          include: itemInclude(userId),
        })
      : [];
    const byId = new Map(rows.map((r) => [r.id, r]));
    const ordered = ids.map((id) => byId.get(id)).filter((r): r is QueueRow => !!r);
    return { items: await toItems(userId, ordered), total: ranked.length, page, pageSize };
  },

  /** How many applications wait for the user's decision now. */
  count(userId: string, now = new Date()): Promise<number> {
    return prisma.application.count({ where: queueWhere(userId, now) });
  },

  /**
   * The review view of one of the user's applications (any status, skipped or not): the confirmation dialogs use
   * it to show how the application would be sent without loading the whole queue.
   */
  async item(userId: string, applicationId: string): Promise<ReviewQueueItem> {
    const row = await prisma.application.findFirst({
      where: { id: applicationId, userId },
      include: itemInclude(userId),
    });
    if (!row) throw Errors.notFound("Application");
    return (await toItems(userId, [row]))[0]!;
  },
};
