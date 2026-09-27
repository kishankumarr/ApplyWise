import "server-only";
import { Prisma, prisma, type ApplicationStatus } from "@applywise/database";
import { generateApplicationEmail, generateCoverLetter, planTailoredResume, validateClaims, type GenerationContext } from "@applywise/ai";
import { renderResumeHtml, resumeContentHash, type ResumeDocument } from "@applywise/resume-engine";
import {
  ATTENTION_STATUSES,
  MANUAL_ACTION_REASON_LABELS,
  PIPELINE_STATUSES,
  type ApplicationMode,
  type ClaimValidationResult,
  type JobMatchReport,
  type ManualHandoffPackage,
  type PendingQuestion,
  type RuleCheck,
  type TailoredResumePlan,
} from "@applywise/types";
import type { ApplicationListQuery, ApplicationUpdateInput } from "@applywise/validation";
import { audit } from "../audit";
import { manualTrackingOptions, type ApplicationAction } from "../domain/application-state";
import { Errors } from "../errors";
import { logger } from "../logger";
import { enqueue } from "../queue";
import { profileRepo } from "../repositories/profile.repo";
import { applicationExecutionService, executeDedupeKey } from "./application-execution.service";
import { resolveQuestions, routeAfterPreparation } from "./application-routing.service";
import { recordApplicationEvent, transitionApplication, type TransitionActor } from "./application-transitions";
import { automationRunsService } from "./automation-runs.service";
import { automationSettingsService } from "./automation-settings.service";
import { aiConfigFor, buildGenerationContext } from "./context.service";
import { jobsService } from "./jobs.service";
import { notificationService } from "./notification.service";
import { canonicalJobKey, loadProviderJob } from "./provider-job-ref";
import { resumeSelectionService } from "./resume-selection.service";
import { selectedResumeLabels } from "./selected-resume-labels";
import { documentFromProfile } from "./resume.service";

export const MAX_BATCH_PREPARE = 10;

type EditedBullet = { proposed: string; sourceFactIds: string[]; accepted: boolean };

/** runPrepare lost its fence: the application left PREPARING, or another task already wrote these drafts. */
class PreparationSuperseded extends Error {
  constructor() {
    super("The preparation was superseded.");
    this.name = "PreparationSuperseded";
  }
}

/** The application is being submitted or was sent: its content is final. */
const CONTENT_LOCKED: ApplicationStatus[] = ["PREPARING", "APPLYING", "APPLIED", "SUBMITTED", "EMAIL_SENT", "ASSESSMENT", "INTERVIEW", "OFFER", "REJECTED"];
/** Approved content the user may still edit; editing returns it to review. */
const APPROVED_EDITABLE: ApplicationStatus[] = ["APPROVED", "OPENED_APPLY_PAGE", "EMAIL_DRAFT_READY"];
/** The automation handed the application back to the user; a retry needs an approval of the current content. */
const HANDED_BACK: ApplicationStatus[] = ["FAILED", "MANUAL_ACTION_REQUIRED"];

const isAutomatedMode = (mode: ApplicationMode | null) => mode === "REVIEW" || mode === "AUTO";

async function loadOwned(userId: string, applicationId: string) {
  const app = await prisma.application.findFirst({
    where: { id: applicationId, userId },
    include: { job: true },
  });
  if (!app) throw Errors.notFound("Application");
  return app;
}

/** Status transitions are compare-and-set (see application-transitions.ts). */
function transition(
  userId: string,
  applicationId: string,
  action: ApplicationAction,
  opts: {
    to?: ApplicationStatus;
    message: string;
    data?: Prisma.ApplicationUncheckedUpdateManyInput;
    metadata?: Record<string, unknown>;
    tx?: Prisma.TransactionClient;
    actor?: TransitionActor;
    from?: ApplicationStatus[];
  },
) {
  return transitionApplication(userId, applicationId, action, opts);
}

/** Build the tailored resume document: base (verified facts) + accepted edits. No new claims. */
export function buildTailoredDocument(base: ResumeDocument, plan: TailoredResumePlan, editedSummary: string | null, editedBullets: EditedBullet[] | null, experienceOrder: string[]): ResumeDocument {
  const bullets = plan.bulletChanges.map((b, i) => ({
    ...b,
    proposed: editedBullets?.[i]?.proposed ?? b.proposed,
    accepted: editedBullets?.[i]?.accepted ?? true,
  }));
  const experience = base.experience.map((e, idx) => {
    const expId = experienceOrder[idx];
    const changes = bullets.filter((b) => b.experienceId === expId);
    if (changes.length === 0) return e;
    // Walk the original bullets in order: rewrite the ones with an accepted change and keep every
    // other original bullet (a proposal never silently deletes experience).
    const used = new Set<number>();
    const rewritten = e.bullets.map((text) => {
      const i = changes.findIndex((c, idx) => !used.has(idx) && c.original === text);
      if (i === -1) return text;
      used.add(i);
      return changes[i]!.accepted ? changes[i]!.proposed : text;
    });
    const added = changes.filter((c, idx) => !used.has(idx) && !c.original && c.accepted).map((c) => c.proposed);
    return { ...e, bullets: [...rewritten, ...added] };
  });
  const selected = plan.selectedSkills.map((s) => s.name);
  const skills = [...selected, ...base.skills.filter((s) => !selected.some((x) => x.toLowerCase() === s.toLowerCase()))];
  return {
    ...base,
    summary: editedSummary ?? plan.summary.text,
    experience,
    skills,
    sectionOrder: plan.sectionOrder.length ? plan.sectionOrder : base.sectionOrder,
  };
}

/** Statuses shown on the Applications page by default (pipeline/rule-filtered jobs live on the Jobs page). */
const PIPELINE: string[] = [...PIPELINE_STATUSES];

const utcMinute = (d: Date) => `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;

/** One-line "what happens next" for the Applications page. */
export function nextActionFor(a: { status: string; mode: ApplicationMode | null; pendingCount: number; nextActionAt: Date | null; manualActionReason: string | null }): string {
  const automated = a.mode === "REVIEW" || a.mode === "AUTO";
  switch (a.status) {
    case "READY_FOR_REVIEW":
      return "Review the drafts, then approve";
    case "WAITING_APPROVAL":
      return "Review and approve (or skip)";
    case "NEEDS_INFORMATION":
      return `Answer ${a.pendingCount || "the"} required question${a.pendingCount === 1 ? "" : "s"}`;
    case "MANUAL_ACTION_REQUIRED":
      return automated && a.nextActionAt ? `Retrying automatically after ${utcMinute(a.nextActionAt)}` : "Apply manually with the prepared handoff";
    case "FAILED":
      // An automatic retry is scheduled (the execution service sets nextActionAt only then): not a handoff yet.
      return automated && a.nextActionAt ? `Retrying automatically after ${utcMinute(a.nextActionAt)}` : "Retry or apply manually";
    case "APPROVED":
      return automated ? (a.nextActionAt ? `Queued - submits after ${utcMinute(a.nextActionAt)}` : "Queued for submission") : "Apply on the official page";
    case "APPLYING":
      return "Submitting...";
    case "OPENED_APPLY_PAGE":
      return "Finish on the official page, then mark as submitted";
    case "EMAIL_DRAFT_READY":
      return "Send the email";
    case "APPLIED":
    case "SUBMITTED":
    case "EMAIL_SENT":
      return "Wait for a response";
    case "ASSESSMENT":
      return "Complete the assessment";
    case "INTERVIEW":
      return "Prepare for the interview";
    case "OFFER":
      return "Review the offer";
    case "PREPARING":
      return "Preparing drafts...";
    case "DISCOVERED":
    case "MATCHING":
      return "Being matched by the automation";
    case "MATCHED":
      return "Recommended - prepare it if you are interested";
    case "AUTO_ELIGIBLE":
      return "Prepared on the next automation run";
    case "REJECTED_BY_RULES":
      return "Filtered out by your rules (prepare anyway if you like)";
    default:
      return "";
  }
}

export const applicationService = {
  /**
   * One page of the Applications list (newest activity first) with the per-view counts for the tabs and how many
   * applications in the view need the user's attention.
   */
  async list(userId: string, query: Partial<ApplicationListQuery> = {}) {
    const view = query.view ?? "all";
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 25;
    const viewWhere = (v: "active" | "pipeline" | "all"): Prisma.ApplicationWhereInput => ({
      userId,
      ...(v === "active" ? { status: { notIn: PIPELINE as ApplicationStatus[] } } : v === "pipeline" ? { status: { in: PIPELINE as ApplicationStatus[] } } : {}),
    });
    const attentionWhere: Prisma.ApplicationWhereInput = { AND: [viewWhere(view), { status: { in: [...ATTENTION_STATUSES] as ApplicationStatus[] } }] };
    const where = query.attention ? attentionWhere : viewWhere(view);
    const [groups, attention, apps] = await Promise.all([
      prisma.application.groupBy({ by: ["status"], where: { userId }, _count: true }),
      prisma.application.count({ where: attentionWhere }),
      prisma.application.findMany({
        where,
        orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        // Only what a row shows (the large JSON columns - decision reasons, runtime questions - stay in the database).
        select: {
          id: true,
          status: true,
          applyMethod: true,
          preparationError: true,
          approvedAt: true,
          submittedAt: true,
          emailSentAt: true,
          appliedAt: true,
          reminderAt: true,
          updatedAt: true,
          origin: true,
          mode: true,
          automationDecision: true,
          decisionScore: true,
          executorId: true,
          executorKind: true,
          selectedResumeVersionId: true,
          manualActionReason: true,
          pendingQuestions: true,
          nextActionAt: true,
          job: {
            select: {
              id: true,
              title: true,
              company: true,
              platform: true,
              applyMethod: true,
              locations: true,
              isDemo: true,
              matchScores: { where: { userId }, select: { score: true } },
              sources: { take: 1, orderBy: { createdAt: "asc" }, select: { attribution: true } },
            },
          },
          selectedResume: { select: { label: true, originalFileName: true } },
        },
      }),
    ]);
    const all = groups.reduce((n, g) => n + g._count, 0);
    const pipeline = groups.filter((g) => PIPELINE.includes(g.status)).reduce((n, g) => n + g._count, 0);
    const counts = { active: all - pipeline, pipeline, all };
    const resumeLabels = await selectedResumeLabels(userId, apps);
    const items = apps.map((a, i) => ({
      id: a.id,
      status: a.status,
      applyMethod: a.applyMethod,
      job: {
        id: a.job.id,
        title: a.job.title,
        company: a.job.company,
        platform: a.job.platform,
        applyMethod: a.job.applyMethod,
        locations: a.job.locations,
        isDemo: a.job.isDemo,
      },
      preparationError: a.preparationError,
      approvedAt: a.approvedAt,
      submittedAt: a.submittedAt,
      emailSentAt: a.emailSentAt,
      reminderAt: a.reminderAt,
      updatedAt: a.updatedAt,
      trackingOptions: manualTrackingOptions(a.status),
      origin: a.origin,
      mode: a.mode,
      automationDecision: a.automationDecision,
      matchScore: a.job.matchScores[0]?.score ?? a.decisionScore ?? null,
      source: a.job.sources[0]?.attribution ?? null,
      appliedAt: a.appliedAt ?? a.submittedAt ?? a.emailSentAt,
      method: a.executorId ?? null,
      executorKind: a.executorKind,
      resumeLabel: resumeLabels[i] ?? null,
      manualActionReason: a.manualActionReason,
      nextAction: nextActionFor({
        status: a.status,
        mode: a.mode,
        pendingCount: ((a.pendingQuestions ?? []) as unknown[]).length,
        nextActionAt: a.nextActionAt,
        manualActionReason: a.manualActionReason,
      }),
    }));
    return { items, total: query.attention ? attention : counts[view], page, pageSize, counts, attention };
  },

  async getOrCreate(userId: string, jobId: string) {
    const job = await jobsService.getRow(userId, jobId);
    const existing = await prisma.application.findUnique({
      where: { userId_jobId: { userId, jobId } },
    });
    if (existing) {
      if (!existing.canonicalJobKey)
        await prisma.application.update({
          where: { id: existing.id },
          data: { canonicalJobKey: canonicalJobKey(job) },
        });
      return existing;
    }
    const app = await prisma.application.create({
      data: {
        userId,
        jobId,
        applyMethod: job.applyMethod,
        status: "SAVED",
        canonicalJobKey: canonicalJobKey(job),
      },
    });
    await prisma.applicationEvent.create({
      data: {
        applicationId: app.id,
        userId,
        type: "created",
        toStatus: "SAVED",
        message: "Application created.",
      },
    });
    return app;
  },

  async prepare(userId: string, jobId: string, requestId?: string) {
    const app = await this.getOrCreate(userId, jobId);
    if (app.status === "PREPARING") return { applicationId: app.id, status: app.status };
    await transition(userId, app.id, "prepare", {
      message: "Preparation started (drafts are generated for your review; nothing is submitted).",
      data: { preparationError: null },
    });
    await enqueue("application.prepare", { applicationId: app.id, requestId }, { userId });
    const fresh = await prisma.application.findUniqueOrThrow({
      where: { id: app.id },
      select: { status: true },
    });
    return { applicationId: app.id, status: fresh.status };
  },

  async batchPrepare(userId: string, jobIds: string[], requestId?: string) {
    if (jobIds.length > MAX_BATCH_PREPARE) throw Errors.validation(`You can prepare at most ${MAX_BATCH_PREPARE} jobs at a time.`);
    const results: { jobId: string; applicationId?: string; status?: string; error?: string }[] = [];
    for (const jobId of [...new Set(jobIds)]) {
      try {
        const r = await this.prepare(userId, jobId, requestId);
        results.push({ jobId, ...r });
      } catch (e) {
        results.push({ jobId, error: e instanceof Error ? e.message : "Failed" });
      }
    }
    return { results };
  },

  /**
   * Background task: select the resume, generate the drafts (tailored resume, cover letter, email), answer the
   * application questions from verified data, validate claims, then route by application mode
   * (application-routing.service.ts). Never submits anything itself.
   */
  async runPrepare(userId: string, applicationId: string, requestId?: string) {
    const app = await loadOwned(userId, applicationId);
    // A retried/duplicate task after the application moved on must not regenerate or re-route it.
    if (app.status !== "PREPARING") return;
    // Only the first preparation counts on the run that created the application; preparing again later (answers
    // given, "Regenerate drafts", ...) is not a result of that run.
    const runId = app.preparedAt ? null : app.automationRunId;
    try {
      await resumeSelectionService.selectForApplication(userId, applicationId).catch((e: unknown) => {
        logger.warn("application.resume_selection_failed", {
          applicationId,
          error: e instanceof Error ? e.name : "unknown",
        });
      });
      const ctx: GenerationContext = await buildGenerationContext(userId, app.jobId);
      const config = await aiConfigFor(userId);
      const opts = { logger, config };
      // Automation settings apply to the applications the automation created ("Write a cover letter" off => none).
      const settings = app.origin === "AUTOMATION" ? (await automationSettingsService.ensure(userId)).settings : null;
      const wantCover = !settings || settings.generateCoverLetter;
      const plan = await planTailoredResume(ctx, opts);
      const cover = wantCover ? await generateCoverLetter(ctx, opts) : null;
      const answers = await resolveQuestions(userId, app.jobId, ctx, opts, applicationId);
      const email = ctx.job.hrEmail
        ? await generateApplicationEmail(ctx, plan.data.summary.text, {
            ...opts,
            hasCoverLetter: wantCover,
          })
        : null;
      const validation: ClaimValidationResult = validateClaims(
        [
          plan.data.summary,
          ...plan.data.bulletChanges.map((b) => ({
            text: b.proposed,
            sourceFactIds: b.sourceFactIds,
          })),
        ],
        ctx.facts,
      );

      await prisma.$transaction(
        async (tx) => {
          // Fence: only this preparation may write drafts. If the application left PREPARING (withdrawn, ...) or another
          // task already prepared it, nothing is written - the drafts can never change under an approval or an executor.
          // New drafts are unapproved: any earlier approval (and a deferred submission) no longer applies.
          const fenced = await tx.application.updateMany({
            where: { id: applicationId, userId, status: "PREPARING", preparedAt: app.preparedAt },
            data: {
              preparedAt: new Date(),
              preparationError: null,
              failureReason: null,
              approvedAt: null,
              approvalSource: null,
              nextActionAt: null,
            },
          });
          if (fenced.count === 0) throw new PreparationSuperseded();
          const planJson = plan.data as unknown as Prisma.InputJsonValue;
          await tx.tailoredResume.upsert({
            where: { applicationId },
            create: {
              userId,
              applicationId,
              jobId: app.jobId,
              plan: planJson,
              validation: validation as unknown as Prisma.InputJsonValue,
              provider: plan.meta.provider,
              modelId: plan.meta.modelId,
              promptVersion: plan.meta.promptVersion,
            },
            update: {
              plan: planJson,
              validation: validation as unknown as Prisma.InputJsonValue,
              editedSummary: null,
              editedBullets: Prisma.JsonNull,
              status: "PROPOSED",
              approvedAt: null,
              provider: plan.meta.provider,
              modelId: plan.meta.modelId,
              promptVersion: plan.meta.promptVersion,
            },
          });
          if (cover) {
            await tx.coverLetter.upsert({
              where: { applicationId },
              create: {
                userId,
                applicationId,
                body: cover.data.body,
                originalBody: cover.data.body,
                claims: cover.data.claims as unknown as Prisma.InputJsonValue,
                provider: cover.meta.provider,
                modelId: cover.meta.modelId,
                promptVersion: cover.meta.promptVersion,
              },
              update: {
                body: cover.data.body,
                originalBody: cover.data.body,
                claims: cover.data.claims as unknown as Prisma.InputJsonValue,
                status: "PROPOSED",
                approvedAt: null,
                provider: cover.meta.provider,
                modelId: cover.meta.modelId,
                promptVersion: cover.meta.promptVersion,
              },
            });
          } else {
            // No letter is written, and none left over from an earlier preparation is kept (so none can be sent).
            await tx.coverLetter.deleteMany({ where: { applicationId, userId } });
          }
          await tx.screeningAnswerDraft.deleteMany({ where: { applicationId, userId } });
          if (answers.drafts.length) {
            await tx.screeningAnswerDraft.createMany({
              data: answers.drafts.map((d, i) => ({
                userId,
                applicationId,
                question: d.question,
                answer: d.answer,
                originalAnswer: d.answer,
                canConfirm: d.canConfirm,
                claims: d.claims as unknown as Prisma.InputJsonValue,
                provider: d.provider,
                modelId: d.modelId,
                promptVersion: d.promptVersion,
                questionKey: d.questionKey,
                required: d.required,
                answerSource: d.answerSource,
                resolved: d.resolved,
                sortOrder: i,
              })),
            });
          }
          if (email && ctx.job.hrEmail) {
            await tx.applicationEmailDraft.upsert({
              where: { applicationId },
              create: {
                userId,
                applicationId,
                to: ctx.job.hrEmail,
                subject: email.data.subject,
                body: email.data.body,
                originalBody: email.data.body,
                claims: email.data.claims as unknown as Prisma.InputJsonValue,
                attachCoverLetter: false,
                provider: email.meta.provider,
                modelId: email.meta.modelId,
                promptVersion: email.meta.promptVersion,
              },
              update: {
                to: ctx.job.hrEmail,
                subject: email.data.subject,
                body: email.data.body,
                originalBody: email.data.body,
                claims: email.data.claims as unknown as Prisma.InputJsonValue,
                status: "DRAFT",
                previewDigest: null,
                previewedAt: null,
                provider: email.meta.provider,
                modelId: email.meta.modelId,
                promptVersion: email.meta.promptVersion,
              },
            });
          }
        },
        { timeout: 30_000 },
      );
      await recordApplicationEvent(userId, applicationId, "prepared", "Drafts generated from your verified profile.", {
        actor: "system",
        metadata: {
          providers: {
            resume: plan.meta.provider,
            coverLetter: cover?.meta.provider ?? null,
            email: email?.meta.provider ?? null,
          },
          promptVersions: {
            resume: plan.meta.promptVersion,
            coverLetter: cover?.meta.promptVersion ?? null,
          },
          unsupportedClaims: validation.unsupportedClaims.length,
          answers: {
            resolved: answers.drafts.filter((d) => d.resolved).length,
            unresolved: answers.drafts.filter((d) => !d.resolved).length,
            generated: answers.drafts.filter((d) => d.answerSource === "GENERATED").length,
            pending: answers.pending.length,
          },
        },
      });
      if (app.origin === "AUTOMATION") await automationRunsService.increment(runId, { applicationsPrepared: 1 });
      // Truth gate for automatic submission: tailored-resume claims and the cover letter's cited claims must all be backed.
      const coverValidation = cover
        ? validateClaims(cover.data.claims, ctx.facts, {
            allowedEntities: [ctx.job.company, ctx.job.title],
          })
        : null;
      const truthOk = validation.unsupportedClaims.length === 0 && (coverValidation?.unsupportedClaims.length ?? 0) === 0;
      await routeAfterPreparation(userId, applicationId, {
        pending: answers.pending,
        truthOk,
        warnings: answers.warnings,
        runId,
      });
      await audit(userId, "application.prepared", {
        requestId,
        entityType: "Application",
        entityId: applicationId,
        metadata: { provider: plan.meta.provider, modelId: plan.meta.modelId },
      });
    } catch (err) {
      if (err instanceof PreparationSuperseded) {
        // Not a failure: the application moved on (or another task prepared it) - leave it exactly as it is.
        logger.info("application.prepare_superseded", { applicationId });
        return;
      }
      const message = err instanceof Error ? err.message.slice(0, 300) : "Preparation failed";
      // The manual flow returns to SAVED (as before); automation-created applications surface as FAILED so they are visible.
      const to = app.origin === "AUTOMATION" ? "FAILED" : "SAVED";
      const moved = await transition(userId, applicationId, "preparation_failed", {
        to,
        actor: app.origin === "AUTOMATION" ? "system" : "user",
        message: "Preparation failed.",
        data: {
          preparationError: message,
          ...(to === "FAILED" ? { failureReason: "Preparation failed - retry from the application page." } : {}),
        },
      }).catch(() => null);
      if (moved && app.origin === "AUTOMATION") await automationRunsService.increment(runId, { failures: 1 });
      throw err;
    }
  },

  async get(userId: string, applicationId: string) {
    const app = await prisma.application.findFirst({
      where: { id: applicationId, userId },
      include: {
        job: { include: { skillRequirements: true } },
        events: { orderBy: { createdAt: "desc" } },
        tailoredResume: true,
        coverLetter: true,
        screeningDrafts: { orderBy: { sortOrder: "asc" } },
        emailDraft: true,
        resumeVersions: {
          orderBy: { createdAt: "desc" },
          select: { id: true, label: true, kind: true, createdAt: true, approvedAt: true },
        },
        selectedResume: { select: { id: true, label: true, originalFileName: true } },
        messages: {
          orderBy: { receivedAt: "desc" },
          take: 20,
          select: {
            id: true,
            category: true,
            confidence: true,
            subject: true,
            fromDomain: true,
            receivedAt: true,
            statusApplied: true,
          },
        },
      },
    });
    if (!app) throw Errors.notFound("Application");
    // Only automation applications (Review/Auto) are ever submitted by an executor.
    const executor = app.mode === "REVIEW" || app.mode === "AUTO" ? await applicationExecutionService.describeExecutor(userId, applicationId).catch(() => null) : null;
    const execution = await prisma.applicationExecution.findFirst({
      where: { applicationId, userId, status: "SUCCEEDED" },
      select: { confirmation: true },
    });
    let tailoredPreviewHtml: string | null = null;
    if (app.tailoredResume) {
      const profile = await profileRepo.ensure(userId);
      const doc = buildTailoredDocument(
        documentFromProfile(profile),
        app.tailoredResume.plan as unknown as TailoredResumePlan,
        app.tailoredResume.editedSummary,
        (app.tailoredResume.editedBullets as EditedBullet[] | null) ?? null,
        profile.experiences.filter((e) => e.status !== "USER_REJECTED").map((e) => e.id),
      );
      tailoredPreviewHtml = renderResumeHtml(doc);
    }
    return {
      id: app.id,
      status: app.status,
      applyMethod: app.applyMethod,
      notes: app.notes,
      preparationError: app.preparationError,
      approvedAt: app.approvedAt,
      openedApplyPageAt: app.openedApplyPageAt,
      submittedAt: app.submittedAt,
      emailSentAt: app.emailSentAt,
      reminderAt: app.reminderAt,
      job: {
        id: app.job.id,
        title: app.job.title,
        company: app.job.company,
        platform: app.job.platform,
        applyUrl: app.job.applyUrl,
        hrEmail: app.job.hrEmail,
        applicationInstructions: app.job.applicationInstructions,
        isDemo: app.job.isDemo,
      },
      tailored: app.tailoredResume
        ? {
            plan: app.tailoredResume.plan as unknown as TailoredResumePlan,
            editedSummary: app.tailoredResume.editedSummary,
            editedBullets: (app.tailoredResume.editedBullets as EditedBullet[] | null) ?? null,
            validation: app.tailoredResume.validation as unknown as ClaimValidationResult,
            status: app.tailoredResume.status,
            provider: app.tailoredResume.provider,
            modelId: app.tailoredResume.modelId,
            promptVersion: app.tailoredResume.promptVersion,
            previewHtml: tailoredPreviewHtml,
          }
        : null,
      coverLetter: app.coverLetter
        ? {
            body: app.coverLetter.body,
            status: app.coverLetter.status,
            provider: app.coverLetter.provider,
            modelId: app.coverLetter.modelId,
            promptVersion: app.coverLetter.promptVersion,
            edited: app.coverLetter.body !== app.coverLetter.originalBody,
          }
        : null,
      screeningAnswers: app.screeningDrafts.map((s) => ({
        id: s.id,
        question: s.question,
        answer: s.answer,
        canConfirm: s.canConfirm,
        provider: s.provider,
        modelId: s.modelId,
        edited: s.answer !== s.originalAnswer,
        questionKey: s.questionKey,
        required: s.required,
        source: s.answerSource,
        resolved: s.resolved,
      })),
      emailDraft: app.emailDraft
        ? {
            to: app.emailDraft.to,
            cc: app.emailDraft.cc,
            subject: app.emailDraft.subject,
            body: app.emailDraft.body,
            status: app.emailDraft.status,
            attachCoverLetter: app.emailDraft.attachCoverLetter,
            resumeVersionId: app.emailDraft.resumeVersionId,
            provider: app.emailDraft.provider,
            modelId: app.emailDraft.modelId,
            sentAt: app.emailDraft.sentAt,
          }
        : null,
      resumeVersions: app.resumeVersions,
      events: app.events.map((e) => ({
        id: e.id,
        type: e.type,
        message: e.message,
        fromStatus: e.fromStatus,
        toStatus: e.toStatus,
        actor: e.actor,
        createdAt: e.createdAt,
      })),
      trackingOptions: manualTrackingOptions(app.status),
      automation: {
        origin: app.origin,
        mode: app.mode,
        decision: app.automationDecision,
        decisionScore: app.decisionScore,
        decisionChecks: (app.decisionReasons ?? []) as unknown as RuleCheck[],
        evaluatedAt: app.evaluatedAt,
        approvalSource: app.approvalSource,
        executorKind: app.executorKind,
        executorId: app.executorId,
        manualActionReason: app.manualActionReason,
        manualActionLabel: app.manualActionReason ? MANUAL_ACTION_REASON_LABELS[app.manualActionReason] : null,
        manualActionDetail: app.manualActionDetail,
        pendingQuestions: (app.pendingQuestions ?? []) as unknown as PendingQuestion[],
        failureReason: app.failureReason,
        appliedAt: app.appliedAt,
        externalApplicationId: app.externalApplicationId,
        nextActionAt: app.nextActionAt,
        preparedAt: app.preparedAt,
        nextAction: nextActionFor({
          status: app.status,
          mode: app.mode,
          pendingCount: ((app.pendingQuestions ?? []) as unknown[]).length,
          nextActionAt: app.nextActionAt,
          manualActionReason: app.manualActionReason,
        }),
        executor,
        confirmation: execution?.confirmation ?? null,
      },
      resumeSelection: {
        resumeId: app.selectedResumeId,
        versionId: app.selectedResumeVersionId,
        label: (await selectedResumeLabels(userId, [app]))[0] ?? null,
        score: app.resumeSelectionScore,
        reason: app.resumeSelectionReason,
        overridden: app.resumeSelectionOverridden,
      },
      messages: app.messages,
    };
  },

  async update(userId: string, applicationId: string, input: ApplicationUpdateInput, requestId?: string) {
    const app = await loadOwned(userId, applicationId);
    const contentEdited = input.tailoredSummary !== undefined || input.tailoredBullets !== undefined || input.coverLetter !== undefined || input.screeningAnswers !== undefined;
    const warnings: string[] = [];
    const automated = isAutomatedMode(app.mode);

    if (contentEdited) {
      if (CONTENT_LOCKED.includes(app.status)) {
        throw Errors.invalidState(
          app.status === "PREPARING"
            ? "The drafts are being prepared right now - edit them once they are ready."
            : "This application is being submitted or was already sent, so its content can no longer be changed.",
        );
      }
      // A retry after an uncertain submission sends the approved content again only after the user checked it was not
      // received; changing that content first would hide a possible duplicate behind a new review.
      if (HANDED_BACK.includes(app.status) && app.manualActionReason === "SUBMISSION_UNCERTAIN") {
        throw Errors.invalidState("The last attempt may already have been submitted. Check on the official page first: mark it as submitted, or retry once you confirmed it was not sent.");
      }
    }

    // Validation of resume edits (reads the verified facts) happens before the fenced write below.
    let tailoredData: Prisma.TailoredResumeUpdateInput | null = null;
    if (input.tailoredSummary !== undefined || input.tailoredBullets !== undefined) {
      const tr = await prisma.tailoredResume.findUnique({ where: { applicationId } });
      if (!tr) throw Errors.invalidState("Prepare the application before editing the tailored resume.");
      const plan = tr.plan as unknown as TailoredResumePlan;
      if (input.tailoredBullets && input.tailoredBullets.length !== plan.bulletChanges.length) throw Errors.validation("Bullet edits do not match the proposal.");
      // User edits are allowed, but we flag content the verified profile does not support.
      const ctx = await buildGenerationContext(userId, app.jobId);
      const claims = [
        ...(input.tailoredSummary ? [{ text: input.tailoredSummary, sourceFactIds: plan.summary.sourceFactIds }] : []),
        ...(input.tailoredBullets ?? []).filter((b) => b.accepted).map((b) => ({ text: b.proposed, sourceFactIds: b.sourceFactIds })),
      ];
      const v = validateClaims(claims, ctx.facts, {
        lenientSkillCitations: true,
        allowedEntities: [ctx.job.company, ctx.job.title],
      });
      warnings.push(...v.requiredRevisions);
      tailoredData = {
        ...(input.tailoredSummary !== undefined ? { editedSummary: input.tailoredSummary } : {}),
        ...(input.tailoredBullets !== undefined ? { editedBullets: input.tailoredBullets as unknown as Prisma.InputJsonValue } : {}),
        status: "EDITED",
        validation: v as unknown as Prisma.InputJsonValue,
      };
    }

    if (contentEdited) {
      await prisma.$transaction(async (tx) => {
        // Fence first (row lock on the application): the content only changes while the application is still in the
        // status this edit was checked against. If an executor moved it to APPLYING meanwhile, the whole edit rolls
        // back, so a submission only ever sends approved content.
        if (APPROVED_EDITABLE.includes(app.status)) {
          await transition(userId, applicationId, "edit", {
            tx,
            from: [app.status],
            // Review/Auto applications go back to the automation's review state ("Approve & apply").
            to: app.status === "APPROVED" && automated ? "WAITING_APPROVAL" : undefined,
            message: "Content changed after approval - please review and approve again.",
            // A deferred submission (quiet hours, daily limit) belonged to the old approval.
            data: { approvedAt: null, approvalSource: null, nextActionAt: null },
          });
        } else {
          const fenced = await tx.application.updateMany({
            where: { id: applicationId, userId, status: app.status },
            // A handed-back application needs a new approval of the edited content before any retry (the pending
            // automatic retry, if any, is cancelled with it).
            data: HANDED_BACK.includes(app.status) ? { approvedAt: null, approvalSource: null, nextActionAt: null } : { updatedAt: new Date() },
          });
          if (fenced.count === 0) throw Errors.conflict("The application changed while you were editing it. Reload and try again.");
        }
        if (tailoredData) await tx.tailoredResume.update({ where: { applicationId }, data: tailoredData });
        if (input.coverLetter !== undefined) {
          await tx.coverLetter.updateMany({
            where: { applicationId, userId },
            data: { body: input.coverLetter, status: "EDITED" },
          });
        }
        if (input.screeningAnswers?.length) {
          const current = new Map(
            (
              await tx.screeningAnswerDraft.findMany({
                where: {
                  applicationId,
                  userId,
                  id: { in: input.screeningAnswers.map((s) => s.id) },
                },
                select: { id: true, answer: true },
              })
            ).map((d) => [d.id, d.answer]),
          );
          for (const s of input.screeningAnswers) {
            // Unchanged answers keep their source: saving the form never turns a generated suggestion (or an unanswered
            // question) into an answer "written by you".
            if (!current.has(s.id) || current.get(s.id) === s.answer) continue;
            // An answer the user typed is theirs: it becomes a resolved, user-authored answer the executor may send.
            const typed = s.answer.trim().length > 0;
            await tx.screeningAnswerDraft.updateMany({
              where: { id: s.id, applicationId, userId },
              data: {
                answer: s.answer,
                status: "EDITED",
                ...(typed ? { resolved: true, canConfirm: true, answerSource: "CANDIDATE_ANSWER" } : { resolved: false, answerSource: "UNKNOWN" }),
              },
            });
          }
        }
        await tx.applicationEvent.create({
          data: {
            applicationId,
            userId,
            type: "edited",
            message: "You edited the generated content.",
            metadata: { warnings: warnings.length },
          },
        });
      });
      await audit(userId, "application.edited", {
        requestId,
        entityType: "Application",
        entityId: applicationId,
      });
    }
    if (input.notes !== undefined)
      await prisma.application.update({
        where: { id: applicationId },
        data: { notes: input.notes },
      });
    if (input.reminderAt !== undefined) {
      const at = input.reminderAt ? new Date(input.reminderAt) : null;
      await prisma.application.update({ where: { id: applicationId }, data: { reminderAt: at } });
      if (at) await enqueue("reminder.dispatch", { applicationId, at: at.toISOString() }, { userId, runAt: at });
    }
    if (input.status && input.status !== app.status) {
      await transition(userId, applicationId, "track", {
        to: input.status,
        message: `Status set to ${input.status.replace(/_/g, " ").toLowerCase()} by you.`,
      });
      await audit(userId, "application.status_changed", {
        requestId,
        entityType: "Application",
        entityId: applicationId,
        metadata: { from: app.status, to: input.status },
      });
    }
    return { application: await this.get(userId, applicationId), warnings };
  },

  /**
   * "Approve" (the user reviewed the content). Manual flow (no mode / Manual mode): the content is frozen and the user
   * applies on the official page - nothing is submitted. Review/Auto applications: the user's explicit approval IS the
   * Review-mode approval, so the application is also queued for submission (like "Approve & apply"); a handed-off or
   * failed one is approved and queued again, never after an uncertain submission (that needs "Retry", which asks the
   * user to confirm it was not sent).
   */
  async approve(userId: string, applicationId: string, requestId?: string) {
    const app = await loadOwned(userId, applicationId);
    if (isAutomatedMode(app.mode)) {
      if (app.status === "READY_FOR_REVIEW" || app.status === "WAITING_APPROVAL") return this.applyNow(userId, applicationId, {}, requestId);
      if (HANDED_BACK.includes(app.status)) {
        if (app.manualActionReason === "SUBMISSION_UNCERTAIN") {
          throw Errors.invalidState("The last attempt may already have been submitted. Check on the official page first, then mark it as submitted or retry the automation.");
        }
        // Drafts that never went through the verified answer resolver are never submitted: prepare them again first.
        if (!app.preparedAt) throw Errors.invalidState("Prepare the application again before approving it for automatic submission.");
        await this.approveContent(userId, applicationId, "user", null, requestId);
        await enqueue("application.execute", { applicationId }, { userId, dedupeKey: executeDedupeKey(applicationId, `approved:${Date.now()}`) });
        return this.get(userId, applicationId);
      }
    }
    await this.approveContent(userId, applicationId, "user", null, requestId);
    return this.get(userId, applicationId);
  },

  /**
   * Approve the prepared content: freezes the resume that will be sent as a TAILORED-kind version of this application
   * (the tailored resume, or - when an automation application is configured to use the selected resume as-is - that
   * resume if the user approved it, else the resume built from verified facts; never the unreviewed CV parse) and
   * approves every draft. source "user" = explicit review; "policy" = AUTO mode after every safety check
   * (routeAfterPreparation only).
   */
  async approveContent(userId: string, applicationId: string, source: "user" | "policy", runId: string | null = null, requestId?: string) {
    const app = await loadOwned(userId, applicationId);
    if (!(await prisma.tailoredResume.count({ where: { applicationId } }))) throw Errors.invalidState("Nothing to approve yet - prepare the application first.");
    const settings = app.origin === "AUTOMATION" ? (await automationSettingsService.ensure(userId)).settings : null;
    const useTailored = !settings || settings.tailorResume;
    const profile = await profileRepo.ensure(userId);
    const handedBack = HANDED_BACK.includes(app.status);
    await prisma.$transaction(async (tx) => {
      // Fence first (row lock): the approval covers exactly the content read below. A concurrent edit either commits
      // before (and is approved) or fails its own fence after this approval.
      const fenced = await tx.application.updateMany({
        where: { id: applicationId, userId, status: app.status },
        data: { updatedAt: new Date() },
      });
      if (fenced.count === 0) throw Errors.conflict("The application changed meanwhile. Reload it and review it again.");
      const tr = await tx.tailoredResume.findUniqueOrThrow({ where: { applicationId } });
      let doc: ResumeDocument;
      let label: string;
      if (useTailored) {
        doc = buildTailoredDocument(
          documentFromProfile(profile),
          tr.plan as unknown as TailoredResumePlan,
          tr.editedSummary,
          (tr.editedBullets as EditedBullet[] | null) ?? null,
          profile.experiences.filter((e) => e.status !== "USER_REJECTED").map((e) => e.id),
        );
        label = `Tailored for ${app.job.title} at ${app.job.company}`;
      } else {
        // Tailoring off: the selected resume as-is when the user approved that version (their own edited variant);
        // never the raw CV parse (ORIGINAL, unreviewed) - then the resume built from verified facts only.
        const selected = app.selectedResumeVersionId ? await tx.resumeVersion.findFirst({ where: { id: app.selectedResumeVersionId, userId } }) : null;
        doc = selected && selected.kind !== "ORIGINAL" && selected.approvedAt ? (selected.content as unknown as ResumeDocument) : documentFromProfile(profile);
        label = `Resume for ${app.job.title} at ${app.job.company}`;
      }
      const version = await tx.resumeVersion.create({
        data: {
          userId,
          applicationId,
          kind: "TAILORED",
          label,
          content: doc as unknown as Prisma.InputJsonValue,
          contentHash: resumeContentHash(doc),
          approvedAt: new Date(),
        },
      });
      const resumeVersionId = version.id;
      await tx.tailoredResume.update({
        where: { applicationId },
        data: { status: "APPROVED", approvedAt: new Date(), resumeVersionId },
      });
      await tx.coverLetter.updateMany({
        where: { applicationId },
        data: { status: "APPROVED", approvedAt: new Date() },
      });
      await tx.screeningAnswerDraft.updateMany({
        where: { applicationId },
        data: { status: "APPROVED" },
      });
      await tx.applicationEmailDraft.updateMany({
        where: { applicationId, resumeVersionId: null },
        data: { resumeVersionId },
      });
      // A deferred submission (quiet hours / daily limit) belonged to an earlier approval.
      const approval = { approvedAt: new Date(), nextActionAt: null };
      if (source === "policy") {
        await transition(userId, applicationId, "policy_approve", {
          tx,
          actor: "policy",
          message: `Approved automatically by your Auto policy: match score ${app.decisionScore ?? "?"} met the auto-apply threshold and every rule and safety check passed.`,
          data: { ...approval, approvalSource: "policy" },
          metadata: { resumeVersionId, runId },
        });
      } else {
        await transition(userId, applicationId, "approve", {
          tx,
          message: "You reviewed and approved the application content.",
          data: {
            ...approval,
            approvalSource: "user",
            // Approved again after a handoff / failure: the old reason no longer describes it (a new attempt records its own).
            ...(handedBack
              ? {
                  manualActionReason: null,
                  manualActionDetail: null,
                  failureReason: null,
                  executorKind: null,
                  executorId: null,
                }
              : {}),
          },
          metadata: { resumeVersionId },
        });
      }
    });
    await audit(userId, source === "policy" ? "application.auto_approved" : "application.approved", { requestId, entityType: "Application", entityId: applicationId });
  },

  /**
   * "Approve & apply" (review queue) or "Retry" after a manual fix: approves the content if needed and queues the
   * executor. Only for REVIEW/AUTO applications - Manual mode never submits. A retry never approves anything: it
   * resends content the user (or the Auto policy) approved, so edited or never-approved content is reviewed first.
   */
  async applyNow(userId: string, applicationId: string, opts: { retry?: boolean; acknowledgeUncertain?: boolean } = {}, requestId?: string) {
    const app = await loadOwned(userId, applicationId);
    const { settings } = await automationSettingsService.ensure(userId);
    const mode: ApplicationMode | null = app.mode ?? (settings.mode === "MANUAL" ? null : "REVIEW");
    if (!mode || mode === "MANUAL") {
      throw Errors.invalidState("Automatic submission is off in Manual mode. Switch to Review or Auto mode on the Automation page, or apply on the official page yourself.");
    }
    if (!app.mode) await prisma.application.update({ where: { id: applicationId }, data: { mode } });
    // Drafts prepared before the automation layer never went through the verified answer resolver: prepare again.
    if (!app.preparedAt && (app.status === "READY_FOR_REVIEW" || app.status === "WAITING_APPROVAL" || app.status === "APPROVED")) {
      await transition(userId, applicationId, "prepare", {
        message: "Preparing again with verified answers before submitting.",
        data: { preparationError: null },
      });
      await enqueue("application.prepare", { applicationId, requestId }, { userId, dedupeKey: `application.prepare:${applicationId}` });
      return this.get(userId, applicationId);
    }
    const isRetry = HANDED_BACK.includes(app.status);
    if (app.status === "READY_FOR_REVIEW" || app.status === "WAITING_APPROVAL") {
      await this.approveContent(userId, applicationId, "user", null, requestId);
    } else if (isRetry) {
      if (!opts.retry) throw Errors.invalidState("This application needs a retry: confirm that you want the automation to try again.");
      // Never approved (handed off right after preparation) or edited since the approval: review it first.
      if (!app.approvedAt) throw Errors.invalidState("Review and approve the prepared content before the automation submits it.");
      // An attempt that may already have reached the employer is only retried after the user checked it and says so;
      // that explicit acknowledgement lifts the lock of this application's own attempt - automatic tasks never do.
      if (app.manualActionReason === "SUBMISSION_UNCERTAIN") {
        if (!opts.acknowledgeUncertain) {
          throw Errors.invalidState("The previous attempt may already have been submitted. Check on the employer's page first, then confirm that it was not received.");
        }
        await applicationExecutionService.acknowledgeUncertainSubmission(userId, applicationId);
      }
    } else if (app.status !== "APPROVED") {
      throw Errors.invalidState(`This application cannot be submitted from status ${app.status.replace(/_/g, " ").toLowerCase()}.`);
    }
    // The user explicitly asked for this submission: it no longer depends on the Auto policy (mode/consent) staying on.
    // Compare-and-set: nothing is queued if the application changed meanwhile (e.g. edited back into review).
    const stamped = await prisma.application.updateMany({
      where: {
        id: applicationId,
        userId,
        status: isRetry ? app.status : "APPROVED",
        approvedAt: { not: null },
      },
      // A retry is a new approval of the current content: re-stamping approvedAt invalidates every older deferred task
      // (they carry the approval they were scheduled under), so only this attempt can run.
      data: {
        approvalSource: "user",
        nextActionAt: null,
        ...(isRetry ? { approvedAt: new Date(), manualActionReason: null, manualActionDetail: null } : {}),
      },
    });
    if (stamped.count === 0) throw Errors.conflict("The application changed meanwhile. Reload it and try again.");
    // A user retry gets its own queue key, so it can never be absorbed by an older queued task without the retry flag.
    await enqueue(
      "application.execute",
      { applicationId, retry: isRetry },
      {
        userId,
        dedupeKey: executeDedupeKey(applicationId, isRetry ? `user-retry:${Date.now()}` : undefined),
      },
    );
    return this.get(userId, applicationId);
  },

  /** The user declines an application that was not sent (review queue "Reject"); the job is hidden from the inbox. */
  async decline(userId: string, applicationId: string, reason?: string, requestId?: string) {
    const app = await loadOwned(userId, applicationId);
    await transition(userId, applicationId, "decline", {
      message: reason ? `You declined this application: ${reason}` : "You declined this application.",
    });
    await prisma.userJobState.upsert({
      where: { userId_jobId: { userId, jobId: app.jobId } },
      create: { userId, jobId: app.jobId, ignored: true },
      update: { ignored: true },
    });
    await audit(userId, "application.declined", {
      requestId,
      entityType: "Application",
      entityId: applicationId,
    });
    return this.get(userId, applicationId);
  },

  /** Review queue "Skip": hide it for a while without deciding. */
  async skip(userId: string, applicationId: string, days = 1) {
    await loadOwned(userId, applicationId);
    const until = new Date(Date.now() + days * 86_400_000);
    await prisma.application.update({
      where: { id: applicationId },
      data: { skippedUntil: until },
    });
    await recordApplicationEvent(userId, applicationId, "skipped", `You skipped this for ${days} day${days === 1 ? "" : "s"}.`, { actor: "user" });
    return { skippedUntil: until.toISOString() };
  },

  /** Everything the user needs to finish an application by hand (also used by the extension). */
  async handoff(userId: string, applicationId: string): Promise<ManualHandoffPackage> {
    const a = await prisma.application.findFirst({
      where: { id: applicationId, userId },
      include: {
        job: { include: { matchScores: { where: { userId }, include: { factors: true } } } },
        coverLetter: true,
        screeningDrafts: { where: { resolved: true }, orderBy: { sortOrder: "asc" } },
        resumeVersions: {
          where: { kind: "TAILORED" },
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { id: true, label: true },
        },
        selectedResume: { select: { label: true, originalFileName: true } },
      },
    });
    if (!a) throw Errors.notFound("Application");
    const { provider, sourceProviderId } = await loadProviderJob(userId, a.jobId);
    const info = provider.info(process.env);
    const score = a.job.matchScores[0];
    const report = score?.report as unknown as JobMatchReport | undefined;
    const instructions = [
      a.job.applyUrl
        ? "Open the official apply page (link above) in your own browser."
        : a.job.hrEmail
          ? `Email your application to ${a.job.hrEmail} (the draft is prepared).`
          : "Follow the employer's application instructions.",
      "Use the prepared resume, cover letter and answers below - they only contain your verified information.",
      "Optional: the ApplyWise browser extension can prefill the form fields you select (it never submits).",
      "After you submit, mark the application as submitted so tracking continues.",
    ];
    return {
      applicationId: a.id,
      status: a.status,
      job: {
        id: a.job.id,
        title: a.job.title,
        company: a.job.company,
        locations: a.job.locations,
        applyUrl: a.job.applyUrl,
        hrEmail: a.job.hrEmail,
        providerId: sourceProviderId,
        providerLabel: info.label,
      },
      reason: a.manualActionReason,
      reasonLabel: a.manualActionReason ? MANUAL_ACTION_REASON_LABELS[a.manualActionReason] : null,
      reasonDetail: a.manualActionDetail,
      match: {
        score: score?.score ?? null,
        summary: report?.summary ?? null,
        factors: (score?.factors ?? []).map((f) => ({
          key: f.key,
          label: f.label,
          points: f.points,
          maxPoints: f.maxPoints,
          explanation: f.explanation,
        })),
      },
      resume: {
        resumeId: a.selectedResumeId,
        label: (await selectedResumeLabels(userId, [a]))[0] ?? null,
        versionId: a.selectedResumeVersionId,
        reason: a.resumeSelectionReason,
      },
      tailoredResume: a.resumeVersions[0] ? { versionId: a.resumeVersions[0].id, label: a.resumeVersions[0].label } : null,
      coverLetter: a.coverLetter?.body ?? null,
      screeningAnswers: a.screeningDrafts.map((d) => ({
        question: d.question,
        answer: d.answer,
        source: d.answerSource,
      })),
      instructions,
    };
  },

  /** Records that the user opened the OFFICIAL apply page themselves. Returns the URL; never submits. */
  async markOpened(userId: string, applicationId: string, requestId?: string) {
    const app = await loadOwned(userId, applicationId);
    if (!app.job.applyUrl) throw Errors.invalidState("This job has no official apply URL.");
    await transition(userId, applicationId, "open_apply_page", {
      message: "You opened the official apply page. Complete and submit the form yourself.",
      data: { openedApplyPageAt: new Date() },
    });
    await audit(userId, "application.opened_apply_page", {
      requestId,
      entityType: "Application",
      entityId: applicationId,
    });
    return { applyUrl: app.job.applyUrl };
  },

  async markSubmitted(userId: string, applicationId: string, note: string | undefined, requestId?: string) {
    await loadOwned(userId, applicationId);
    await transition(userId, applicationId, "mark_submitted", {
      message: note ? `You marked this as submitted: ${note}` : "You marked this application as submitted.",
      data: { submittedAt: new Date() },
    });
    await audit(userId, "application.marked_submitted", {
      requestId,
      entityType: "Application",
      entityId: applicationId,
    });
    return this.get(userId, applicationId);
  },

  async dispatchReminder(userId: string, applicationId: string) {
    const app = await prisma.application.findFirst({
      where: { id: applicationId, userId },
      include: { job: { select: { title: true, company: true } } },
    });
    if (!app || !app.reminderAt || app.reminderAt.getTime() > Date.now() + 60_000) return;
    // One notification per reminder time (a retried task never reminds twice); held back during quiet hours.
    await notificationService.notify(userId, {
      type: "application.reminder",
      title: `Reminder: ${app.job.title} at ${app.job.company}`,
      body: `Your application is ${app.status.replace(/_/g, " ").toLowerCase()}. Review the next step.`,
      link: `/applications/${app.id}`,
      dedupeKey: `reminder:${app.id}:${app.reminderAt.toISOString()}`,
    });
  },
};
