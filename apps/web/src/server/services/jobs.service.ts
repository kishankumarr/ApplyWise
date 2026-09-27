import "server-only";
import { jobRowToNormalized, persistNormalizedJob, prisma, recomputeMatchScores, type Prisma } from "@applywise/database";
import { parseJob } from "@applywise/ai";
import {
  CONNECTORS,
  ConnectorInputError,
  SEARCH_PROVIDERS,
  MATCH_DISCLAIMER,
  MATCH_ENGINE_VERSION,
  type ConnectorKey,
  type JobSourceConnector,
  type RawImportedJob,
} from "@applywise/job-engine";
import type { NormalizedJob } from "@applywise/types";
import type { JobMatchReport } from "@applywise/types";
import type { BrowserImportInput, JobListQuery, JobViewPrefsInput, ManualJobInput } from "@applywise/validation";
import { audit } from "../audit";
import { Errors } from "../errors";
import { logger } from "../logger";
import { jobVisibleTo } from "../repositories/ownership";
import { consentService } from "./consent.service";

/** Only the columns the list shows and ranks on (never the description: the list scans up to 2 x LIST_SCAN rows). */
const listSelect = (userId: string) =>
  ({
    id: true,
    title: true,
    company: true,
    platform: true,
    locations: true,
    workMode: true,
    experienceMinYears: true,
    experienceMaxYears: true,
    postedAt: true,
    applyMethod: true,
    importMethod: true,
    isDemo: true,
    descriptionLevel: true,
    createdAt: true,
    ownerUserId: true,
    feedId: true,
    salaryMin: true,
    salaryMax: true,
    currency: true,
    matchScores: { where: { userId }, select: { score: true, label: true, recommendation: true, factsVersion: true, engineVersion: true } },
    states: { where: { userId }, select: { saved: true, ignored: true } },
    applications: { where: { userId }, select: { id: true, status: true, automationDecision: true } },
    sources: { select: { attribution: true, integrationClass: true }, take: 1 },
    feed: { select: { id: true, label: true, kind: true } },
  }) satisfies Prisma.JobSelect;

/**
 * Demo jobs are shown to new users (so the app is not empty) and hidden automatically once the
 * user has real jobs, unless they chose otherwise.
 */
async function viewState(userId: string) {
  const pref = await prisma.candidatePreference.findFirst({ where: { userId }, select: { showDemoJobs: true, jobsSeenAt: true } });
  const ownJobs = await prisma.job.count({ where: { ownerUserId: userId } });
  // (Jobs from the user's own demo provider source count as the user's jobs.)
  const demoAvailable = (await prisma.job.count({ where: { isDemo: true, ownerUserId: null }, take: 1 })) > 0;
  const showDemo = demoAvailable && (pref?.showDemoJobs ?? ownJobs === 0);
  return { showDemo, demoAvailable, demoPreference: pref?.showDemoJobs ?? null, ownJobs, seenAt: pref?.jobsSeenAt ?? null };
}

/**
 * "New" = found automatically (by a job source) after the user last marked the inbox as seen, and
 * not dismissed. Manually imported jobs are not "new": the user just added them.
 */
function newJobsWhere(userId: string, seenAt: Date | null): Prisma.JobWhereInput {
  return {
    ownerUserId: userId,
    feedId: { not: null },
    ...(seenAt ? { createdAt: { gt: seenAt } } : {}),
    NOT: { states: { some: { userId, ignored: true } } },
  };
}

/** Credit links required by search-API terms ("Jobs by Adzuna", "via Himalayas"...). */
const ATTRIBUTION_URLS = new Map(SEARCH_PROVIDERS.map((p) => [p.attribution.text, p.attribution.url]));
export function attributionUrl(attribution: string | null | undefined): string | null {
  return attribution ? (ATTRIBUTION_URLS.get(attribution) ?? null) : null;
}

/** Enough rows to rank: the user's best-scoring jobs plus the most recently found ones. */
const LIST_SCAN = 600;

async function ensureFreshScores(userId: string, jobs: { id: string; matchScores: { factsVersion: number; engineVersion: string }[] }[]) {
  const profile = await prisma.candidateProfile.findUnique({ where: { userId }, select: { factsVersion: true } });
  if (!profile) return false;
  const stale = jobs
    .filter((j) => !j.matchScores[0] || j.matchScores[0].factsVersion !== profile.factsVersion || j.matchScores[0].engineVersion !== MATCH_ENGINE_VERSION)
    .map((j) => j.id);
  if (stale.length === 0) return false;
  await recomputeMatchScores(prisma, userId, stale);
  return true;
}

export const jobsService = {
  async list(userId: string, q: JobListQuery) {
    const asOf = new Date();
    const view = await viewState(userId);
    const where: Prisma.JobWhereInput = { AND: [jobVisibleTo(userId)] };
    const and = where.AND as Prisma.JobWhereInput[];
    if (!view.showDemo) and.push({ NOT: { isDemo: true, ownerUserId: null } });
    if (q.feedId) and.push({ feedId: q.feedId, ownerUserId: userId });
    if (q.newOnly) and.push(newJobsWhere(userId, view.seenAt));
    if (q.q) and.push({ OR: [{ title: { contains: q.q, mode: "insensitive" } }, { company: { contains: q.q, mode: "insensitive" } }, { description: { contains: q.q, mode: "insensitive" } }] });
    if (q.company) and.push({ company: { contains: q.company, mode: "insensitive" } });
    if (q.platform.length) and.push({ platform: { in: q.platform as never } });
    if (q.workMode.length) and.push({ workMode: { in: q.workMode as never } });
    if (q.applyMethod.length) and.push({ applyMethod: { in: q.applyMethod as never } });
    if (q.location) and.push({ locations: { hasSome: [q.location] } });
    if (q.minYoe != null) and.push({ OR: [{ experienceMaxYears: null }, { experienceMaxYears: { gte: q.minYoe } }] });
    if (q.maxYoe != null) and.push({ OR: [{ experienceMinYears: null }, { experienceMinYears: { lte: q.maxYoe } }] });
    if (q.postedWithinDays) and.push({ postedAt: { gte: new Date(Date.now() - q.postedWithinDays * 86_400_000) } });

    // Rank over a deterministic window: the highest-scoring jobs and the newest ones (never an arbitrary slice).
    const loadRows = async () => {
      const [top, recent] = await Promise.all([
        prisma.jobMatchScore.findMany({ where: { userId, job: where }, orderBy: { score: "desc" }, select: { jobId: true }, take: LIST_SCAN }),
        prisma.job.findMany({ where, orderBy: { createdAt: "desc" }, select: { id: true }, take: LIST_SCAN }),
      ]);
      const ids = [...new Set([...top.map((t) => t.jobId), ...recent.map((r) => r.id)])];
      return prisma.job.findMany({ where: { id: { in: ids } }, select: listSelect(userId) });
    };
    let rows = await loadRows();
    if (await ensureFreshScores(userId, rows)) rows = await loadRows();

    let items = rows.map((j) => ({
      id: j.id,
      title: j.title,
      company: j.company,
      platform: j.platform,
      locations: j.locations,
      workMode: j.workMode,
      experienceMinYears: j.experienceMinYears,
      experienceMaxYears: j.experienceMaxYears,
      postedAt: j.postedAt?.toISOString() ?? null,
      applyMethod: j.applyMethod,
      importMethod: j.importMethod,
      isDemo: j.isDemo,
      attribution: j.sources[0]?.attribution ?? null,
      attributionUrl: attributionUrl(j.sources[0]?.attribution),
      descriptionLevel: j.descriptionLevel,
      feed: j.feed ? { id: j.feed.id, label: j.feed.label, kind: j.feed.kind } : null,
      foundAt: j.createdAt.toISOString(),
      isNew: j.ownerUserId === userId && !!j.feedId && (!view.seenAt || j.createdAt > view.seenAt) && !j.states[0]?.ignored,
      score: j.matchScores[0]?.score ?? null,
      scoreLabel: j.matchScores[0]?.label ?? null,
      recommendation: j.matchScores[0]?.recommendation ?? null,
      saved: j.states[0]?.saved ?? false,
      ignored: j.states[0]?.ignored ?? false,
      applicationId: j.applications[0]?.id ?? null,
      applicationStatus: j.applications[0]?.status ?? null,
      automationDecision: j.applications[0]?.automationDecision ?? null,
      salaryMin: j.salaryMin,
      salaryMax: j.salaryMax,
      currency: j.currency,
      matchedSkills: [] as string[],
      missingSkills: [] as string[],
    }));

    if (!q.includeIgnored) items = items.filter((i) => !i.ignored);
    if (q.savedOnly) items = items.filter((i) => i.saved);
    if (q.minScore != null) items = items.filter((i) => (i.score ?? 0) >= q.minScore!);
    if (q.status.length) items = items.filter((i) => (q.status.includes("NONE") && !i.applicationStatus) || (i.applicationStatus && q.status.includes(i.applicationStatus)));
    const decisions = q.decision ?? [];
    if (decisions.length) items = items.filter((i) => (decisions.includes("NONE") && !i.automationDecision) || (i.automationDecision && decisions.includes(i.automationDecision)));

    const dir = q.order === "asc" ? 1 : -1;
    items.sort((a, b) => {
      switch (q.sort) {
        case "posted":
          return dir * ((a.postedAt ? Date.parse(a.postedAt) : 0) - (b.postedAt ? Date.parse(b.postedAt) : 0));
        case "company":
          return dir * a.company.localeCompare(b.company);
        case "title":
          return dir * a.title.localeCompare(b.title);
        case "found":
          return dir * (Date.parse(a.foundAt) - Date.parse(b.foundAt));
        default:
          return dir * ((a.score ?? -1) - (b.score ?? -1)) || a.title.localeCompare(b.title);
      }
    });
    const total = items.length;
    const start = (q.page - 1) * q.pageSize;
    // Matched / missing skills for the visible page only (reports are large).
    const pageItems = items.slice(start, start + q.pageSize);
    if (pageItems.length) {
      const reports = await prisma.jobMatchScore.findMany({ where: { userId, jobId: { in: pageItems.map((i) => i.id) } }, select: { jobId: true, report: true } });
      const byJob = new Map(reports.map((r) => [r.jobId, r.report as unknown as JobMatchReport]));
      for (const item of pageItems) {
        const r = byJob.get(item.id);
        if (!r) continue;
        item.matchedSkills = [...r.exactMatches, ...r.relatedMatches].map((m) => m.requirement).slice(0, 8);
        item.missingSkills = [...r.missingMandatoryRequirements, ...r.missingPreferredRequirements].map((m) => m.requirement).slice(0, 8);
      }
    }
    const feeds = await prisma.jobFeed.findMany({ where: { userId }, select: { status: true, lastSyncAt: true } });
    const newCount = await prisma.job.count({ where: newJobsWhere(userId, view.seenAt) });
    return {
      items: pageItems,
      total,
      page: q.page,
      pageSize: q.pageSize,
      disclaimer: MATCH_DISCLAIMER,
      view: { showDemo: view.showDemo, demoAvailable: view.demoAvailable, demoPreference: view.demoPreference, ownJobs: view.ownJobs, newCount, seenAt: view.seenAt?.toISOString() ?? null, asOf: asOf.toISOString() },
      sources: {
        total: feeds.length,
        active: feeds.filter((f) => f.status === "ACTIVE" || f.status === "ERROR").length,
        needsAttention: feeds.filter((f) => f.status === "NEEDS_ATTENTION").length,
        lastSyncAt: feeds.reduce<Date | null>((m, f) => (f.lastSyncAt && (!m || f.lastSyncAt > m) ? f.lastSyncAt : m), null)?.toISOString() ?? null,
      },
    };
  },

  async updateViewPrefs(userId: string, input: JobViewPrefsInput) {
    const profile = await prisma.candidateProfile.findUnique({ where: { userId }, select: { id: true } });
    if (!profile) throw Errors.notFound("Profile");
    const data = {
      ...(input.showDemoJobs !== undefined ? { showDemoJobs: input.showDemoJobs } : {}),
      // Jobs that arrived after the user loaded the list stay "new".
      ...(input.markSeen ? { jobsSeenAt: input.asOf ? new Date(Math.min(Date.parse(input.asOf), Date.now())) : new Date() } : {}),
    };
    await prisma.candidatePreference.upsert({ where: { profileId: profile.id }, create: { profileId: profile.id, userId, ...data }, update: data });
    const view = await viewState(userId);
    return { showDemo: view.showDemo, demoPreference: view.demoPreference, seenAt: view.seenAt?.toISOString() ?? null };
  },

  async getRow(userId: string, jobId: string) {
    const job = await prisma.job.findFirst({ where: { id: jobId, ...jobVisibleTo(userId) }, include: { skillRequirements: true } });
    if (!job) throw Errors.notFound("Job");
    return job;
  },

  async get(userId: string, jobId: string) {
    const job = await prisma.job.findFirst({
      where: { id: jobId, ...jobVisibleTo(userId) },
      include: {
        skillRequirements: true,
        requirements: true,
        contacts: true,
        sources: true,
        matchScores: { where: { userId }, include: { factors: true } },
        states: { where: { userId } },
        applications: { where: { userId }, select: { id: true, status: true } },
        questionnaires: { where: { userId }, select: { id: true, status: true } },
      },
    });
    if (!job) throw Errors.notFound("Job");
    await ensureFreshScores(userId, [{ id: job.id, matchScores: job.matchScores }]);
    const score = await prisma.jobMatchScore.findUnique({ where: { userId_jobId: { userId, jobId } } });
    return {
      job: jobRowToNormalized(job),
      sources: job.sources.map((s) => ({ attribution: s.attribution, attributionUrl: attributionUrl(s.attribution), integrationClass: s.integrationClass, sourceUrl: s.sourceUrl, importMethod: s.importMethod, createdAt: s.createdAt })),
      /** "SNIPPET" = only a summary so far (alert email / search snippet); the extension can add the full text. */
      descriptionLevel: job.descriptionLevel,
      contacts: job.contacts.map((c) => ({ email: c.email, role: c.role })),
      match: score ? (score.report as unknown as JobMatchReport) : null,
      disclaimer: MATCH_DISCLAIMER,
      state: { saved: job.states[0]?.saved ?? false, ignored: job.states[0]?.ignored ?? false },
      application: job.applications[0] ?? null,
      questionnaire: job.questionnaires[0] ?? null,
    };
  },

  /** POST /api/jobs/[jobId]/analyze - recompute the deterministic match (and record the analysis). */
  async analyze(userId: string, jobId: string, requestId?: string) {
    const job = await this.getRow(userId, jobId);
    await recomputeMatchScores(prisma, userId, [job.id]);
    const score = await prisma.jobMatchScore.findUnique({ where: { userId_jobId: { userId, jobId } } });
    await prisma.jobAnalysis.create({
      data: { jobId, userId, provider: "rules", promptVersion: MATCH_ENGINE_VERSION, result: { score: score?.score ?? null, label: score?.label ?? null } },
    });
    await audit(userId, "job.analyzed", { requestId, entityType: "Job", entityId: jobId });
    return { match: score?.report as unknown as JobMatchReport, disclaimer: MATCH_DISCLAIMER };
  },

  async setState(userId: string, jobId: string, input: { saved?: boolean; ignored?: boolean }) {
    await this.getRow(userId, jobId);
    return prisma.userJobState.upsert({
      where: { userId_jobId: { userId, jobId } },
      create: { userId, jobId, saved: input.saved ?? false, ignored: input.ignored ?? false },
      update: input,
      select: { saved: true, ignored: true },
    });
  },

  async importVia(userId: string, key: ConnectorKey, payload: unknown, opts: { useAi?: boolean; requestId?: string } = {}) {
    const connector: JobSourceConnector = CONNECTORS[key];
    if (!connector.isConfigured()) throw Errors.providerNotConfigured("This integration is not configured.");
    let raws;
    try {
      raws = await connector.importJobs({ payload, userId });
    } catch (e) {
      if (e instanceof ConnectorInputError) throw Errors.validation(e.message);
      throw e;
    }
    const { results } = await this.importRaws(userId, raws, { connector: key, normalize: (r) => connector.normalize(r), useAi: opts.useAi, requestId: opts.requestId });
    return { imported: results };
  },

  /**
   * Shared import pipeline for every source (manual, CSV, extension, automatic feeds): normalise,
   * optionally improve extraction with AI (consent-gated), persist with dedupe/merge, and score.
   */
  async importRaws(
    userId: string,
    raws: RawImportedJob[],
    opts: { connector: string; normalize: (raw: RawImportedJob) => Promise<NormalizedJob>; useAi?: boolean; feedId?: string | null; requestId?: string },
  ) {
    const aiAllowed = opts.useAi ? (await consentService.get(userId)).aiProcessing : false;
    const results: { jobId: string; duplicate: boolean; merged: boolean; upgraded: boolean; title: string; company: string }[] = [];
    const automatic = opts.connector.startsWith("feed:");
    let failed = 0;
    for (const raw of raws) {
      try {
        let job = await opts.normalize(raw);
        if (aiAllowed) {
          // The AI model can improve extraction from free text; explicit fields still win.
          const ai = await parseJob(raw.text, { importMethod: raw.importMethod, platform: job.platform, title: raw.hints.title, company: raw.hints.company, applyUrl: raw.hints.applyUrl, hrEmail: raw.hints.hrEmail, sourceUrl: raw.sourceUrl, sourceExternalId: raw.externalId }, { logger });
          job = { ...ai.data, importMethod: raw.importMethod, sourceUrl: raw.sourceUrl, sourceExternalId: raw.externalId };
        }
        const saved = await persistNormalizedJob(prisma, { job, raw, ownerUserId: userId, importedByUserId: userId, connector: opts.connector, feedId: opts.feedId ?? null, recordDuplicates: !automatic });
        results.push({ ...saved, title: job.title, company: job.company });
      } catch (e) {
        // Automatic sources: one malformed job must not stop the rest. User imports surface the error.
        if (!automatic) throw e;
        failed++;
        logger.warn("job.import_failed", { connector: opts.connector, error: e instanceof Error ? e.name : "unknown" });
      }
    }
    // New jobs and jobs whose summary was replaced by the full description need (re)scoring.
    const rescore = [...new Set(results.filter((r) => !r.duplicate || r.upgraded).map((r) => r.jobId))];
    if (rescore.length) await recomputeMatchScores(prisma, userId, rescore);
    await audit(userId, "job.imported", {
      requestId: opts.requestId,
      metadata: {
        connector: opts.connector,
        count: results.length,
        duplicates: results.filter((r) => r.duplicate && !r.merged).length,
        merged: results.filter((r) => r.merged).length,
        upgraded: results.filter((r) => r.upgraded).length,
        failed,
      },
    });
    return { results, newJobIds: results.filter((r) => !r.duplicate).map((r) => r.jobId) };
  },

  async importManual(userId: string, input: ManualJobInput, requestId?: string) {
    const key: ConnectorKey = input.mode === "paste" ? "paste" : input.mode === "career_page_url" ? "careerPageUrl" : "manual";
    return this.importVia(userId, key, input, { useAi: input.mode === "paste", requestId });
  },

  importCsv(userId: string, csv: string, requestId?: string) {
    return this.importVia(userId, "csv", { csv }, { requestId });
  },

  importEmail(userId: string, raw: string, requestId?: string) {
    return this.importVia(userId, "email", { raw }, { useAi: true, requestId });
  },

  importBrowser(userId: string, input: BrowserImportInput, requestId?: string) {
    return this.importVia(userId, "browser", input, { requestId });
  },
};
