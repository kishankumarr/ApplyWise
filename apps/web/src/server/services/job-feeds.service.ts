import "server-only";
import { prisma, type Prisma } from "@applywise/database";
import {
  ALERT_SETUP_GUIDES,
  assessRelevance,
  BOARD_ADAPTERS,
  detectBoardFromUrl,
  FeedProviderError,
  findCompanyBoards,
  generateDemoAutomationJobs,
  isDemoProviderEnabled,
  getBoardAdapter,
  getSearchProvider,
  JOB_ALERT_SENDER_DOMAINS,
  normalizeRawJob,
  parseAlertJobsFromRawEmail,
  parseJobAlertEmail,
  SEARCH_PROVIDERS,
  statusEmailPlainText,
  SUGGESTED_COMPANIES,
  type BoardProbe,
  type RawImportedJob,
  type RelevancePrefs,
} from "@applywise/job-engine";
import {
  createPkcePair,
  fetchAlertEmailsGmail,
  fetchAlertEmailsImap,
  gmailAccessToken,
  gmailAuthUrl,
  gmailExchangeCode,
  gmailForwardingConfirmation,
  gmailRevoke,
  IMAP_PRESETS,
  MailAuthError,
  microsoftAccessToken,
  microsoftPollDeviceCode,
  microsoftStartDeviceCode,
  parseRawEmail,
  testImapConnection,
  type MailCursor,
} from "@applywise/mail-sources";
import type { FeedBoardCreateInput, FeedImapConnectInput, FeedSearchCreateInput, FeedUpdateInput } from "@applywise/validation";
import { env } from "@/env";
import { audit } from "../audit";
import { decryptText, encryptText, randomToken, sha256Hex, signToken, verifyToken } from "../crypto";
import { Errors } from "../errors";
import { logger } from "../logger";
import { enqueue } from "../queue";
import { applicationEmailTrackingService } from "./application-email-tracking.service";
import { jobsService } from "./jobs.service";
import { notificationService } from "./notification.service";

/**
 * Automatic job sources ("feeds"): saved searches on job-search APIs, followed company job
 * boards (official public ATS APIs) and job-alert emails in the user's own mailbox (read-only).
 *
 * Compliance: every adapter uses an official API or the user's own email. No job-site page is
 * ever fetched and nothing is submitted here: feeds only discover jobs. Whether and how a job is
 * applied to is decided later by the user's automation mode (Manual / Review / Auto).
 */

type FeedKind = "SEARCH" | "COMPANY_BOARD" | "MAILBOX" | "DEMO";
type FeedRow = Prisma.JobFeedGetPayload<object>;

/** Default refresh intervals (minutes). Search APIs have tight quotas; mailboxes are cheap. */
export const FEED_INTERVALS: Record<FeedKind, number> = { SEARCH: 12 * 60, COMPANY_BOARD: 12 * 60, MAILBOX: 30, DEMO: 6 * 60 };
export const FEED_LIMITS: Record<FeedKind, number> = { SEARCH: 12, COMPANY_BOARD: 60, MAILBOX: 2, DEMO: 1 };
/**
 * New jobs imported per board/search sync, so one huge board cannot flood the inbox. Jobs already
 * known are skipped before this cap, so the next sync continues with the rest.
 */
const MAX_NEW_JOBS_PER_RUN = 100;
/** Mailbox syncs read at most this many emails; every job in them is imported (the cursor moves past them). */
const MAILBOX_MESSAGES_PER_RUN = 25;
/** Minimum refresh interval a user can set, per kind (API quotas and politeness). */
const MIN_INTERVALS: Record<FeedKind, number> = { SEARCH: 6 * 60, COMPANY_BOARD: 3 * 60, MAILBOX: 15, DEMO: 15 };
/** A crashed sync is retried after this lease expires. */
const LEASE_MS = 10 * 60_000;
/** First mailbox sync looks this far back. */
const MAILBOX_LOOKBACK_DAYS = 14;
/** Search-API responses are shared per URL for an hour (identical searches cost one call; Jobicy asks for <= 1/hour). */
const RESPONSE_CACHE_TTL_MS = 60 * 60_000;
/** Failed calls are not retried against the provider for a while (per URL). */
const FAILURE_CACHE_TTL_MS = 15 * 60_000;
const PROVIDER_FAILURE_TTL_MS: Record<string, number> = { jobicy: 60 * 60_000 };
const FEED_INCLUDE = { _count: { select: { jobs: true } }, runs: { where: { finishedAt: null }, orderBy: { startedAt: "desc" }, take: 1, select: { startedAt: true } } } satisfies Prisma.JobFeedInclude;

interface SearchConfig {
  keywords: string;
  location: string | null;
  remoteOnly: boolean;
  maxDaysOld: number;
  onlyRelevant: boolean;
}
interface BoardConfig {
  slug: string;
  companyName: string | null;
  boardUrl: string;
  onlyRelevant: boolean;
}
interface MailboxConfig {
  /** imap | gmail */
  preset: string;
  host?: string;
  port?: number;
  secure?: boolean;
  email: string;
  folder?: string;
  onlyRelevant: boolean;
}

// ---------------------------------------------------------------- helpers

function feedEnv() {
  return process.env as Record<string, string | undefined>;
}

type CachedResponse = { at: number; status: number; body: string; headers: [string, string][] } | { at: number; failed: true };
/** Per-URL response cache for search APIs (in-process). Keys may contain API keys: never logged. */
const responseCache = new Map<string, CachedResponse>();

/**
 * fetch() for search providers: serves identical requests from the cache, remembers failures for
 * a while, and counts only real network calls against the operator's provider quota.
 */
function cachingFetch(provider: string): typeof fetch {
  return async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    const hit = responseCache.get(url);
    const failureTtl = PROVIDER_FAILURE_TTL_MS[provider] ?? FAILURE_CACHE_TTL_MS;
    if (hit) {
      const failed = "failed" in hit || hit.status >= 400;
      if (Date.now() - hit.at < (failed ? failureTtl : RESPONSE_CACHE_TTL_MS)) {
        if ("failed" in hit) throw new TypeError("recently failed");
        return new Response(hit.body, { status: hit.status, headers: hit.headers });
      }
    }
    if (!(await reserveProviderCall(provider))) {
      throw new FeedProviderError(`${providerLabel(provider)} has reached this server's request limit for now; it will refresh automatically.`, true);
    }
    try {
      const res = await fetch(input, init);
      const body = await res.text();
      if (body.length <= 3_000_000) responseCache.set(url, { at: Date.now(), status: res.status, body, headers: [...res.headers.entries()] });
      if (responseCache.size > 300) responseCache.delete(responseCache.keys().next().value!);
      return new Response(body, { status: res.status, headers: res.headers });
    } catch (e) {
      responseCache.set(url, { at: Date.now(), failed: true });
      throw e;
    }
  };
}

function providerLabel(id: string): string {
  return getSearchProvider(id)?.label ?? id;
}

/** Operator quotas for keyed providers (Adzuna default terms: 250/day, 1000/week, 2500/month). */
function providerBudget(provider: string): { day: number; week: number; month: number } | null {
  if (provider === "adzuna") return { day: env().ADZUNA_DAILY_LIMIT, week: env().ADZUNA_WEEKLY_LIMIT, month: env().ADZUNA_MONTHLY_LIMIT };
  return null;
}

const utcDay = (offsetDays = 0) => new Date(Date.now() - offsetDays * 86_400_000).toISOString().slice(0, 10);

async function budgetExhausted(provider: string): Promise<boolean> {
  const budget = providerBudget(provider);
  if (!budget) return false;
  const days = Array.from({ length: 30 }, (_, i) => utcDay(i));
  const rows = await prisma.feedProviderUsage.findMany({ where: { provider, day: { in: days } }, select: { day: true, calls: true } });
  const used = (n: number) => rows.filter((r) => days.slice(0, n).includes(r.day)).reduce((sum, r) => sum + r.calls, 0);
  return used(1) >= budget.day || used(7) >= budget.week || used(30) >= budget.month;
}

/** Count one real API call against the provider's day/week/month budget; false when a limit is reached. */
async function reserveProviderCall(provider: string): Promise<boolean> {
  if (!providerBudget(provider)) return true;
  if (await budgetExhausted(provider)) return false;
  await prisma.feedProviderUsage.upsert({
    where: { provider_day: { provider, day: utcDay() } },
    create: { provider, day: utcDay(), calls: 1 },
    update: { calls: { increment: 1 } },
  });
  return true;
}

/** A forwarding confirmation is only useful until alerts start arriving (and at most a week). */
function pendingConfirmation(f: FeedRow) {
  if (f.provider !== "forwarding" || f.lastSyncAt) return null;
  const c = ((f.cursor ?? {}) as { forwardingConfirmation?: { code: string | null; confirmUrl: string | null; requester: string | null; receivedAt: string } }).forwardingConfirmation;
  if (!c || Date.now() - Date.parse(c.receivedAt) > 7 * 86_400_000) return null;
  return c;
}

function safeFeed(f: FeedRow & { _count?: { jobs: number }; runs?: { startedAt: Date }[] }) {
  const config = { ...(f.config as Record<string, unknown>) };
  // Internal capability token of forwarding feeds is not needed by the UI (the address is).
  delete config.token;
  const running = f.runs?.[0];
  return {
    id: f.id,
    kind: f.kind,
    provider: f.provider,
    label: f.label,
    config,
    /** A sync is running right now (runs older than the lease are treated as crashed). */
    syncing: !!running && Date.now() - running.startedAt.getTime() < LEASE_MS,
    status: f.status,
    intervalMinutes: f.intervalMinutes,
    lastSyncAt: f.lastSyncAt,
    nextSyncAt: f.nextSyncAt,
    lastError: f.lastError,
    lastResult: f.lastResult as { fetched?: number; created?: number; merged?: number; skipped?: number },
    jobCount: f._count?.jobs ?? null,
    connected: !!f.secretEnc || f.kind !== "MAILBOX" || f.provider === "forwarding",
    /** Gmail's forwarding confirmation for a forwarding address, so the user can confirm it in Gmail. */
    forwardingConfirmation: pendingConfirmation(f),
    createdAt: f.createdAt,
  };
}
export type FeedView = ReturnType<typeof safeFeed>;

async function relevancePrefs(userId: string): Promise<RelevancePrefs> {
  const profile = await prisma.candidateProfile.findUnique({
    where: { userId },
    select: { currentTitle: true, preference: true, skills: { where: { status: { in: ["USER_VERIFIED", "USER_EDITED"] } }, select: { canonicalName: true } } },
  });
  const pref = profile?.preference;
  return {
    targetRoles: pref?.targetRoles.length ? pref.targetRoles : profile?.currentTitle ? [profile.currentTitle] : [],
    preferredLocations: pref?.preferredLocations ?? [],
    workModePreference: pref?.workModePreference ?? "any",
    openToRelocation: pref?.openToRelocation ?? false,
    skills: profile?.skills.map((s) => s.canonicalName) ?? [],
  };
}

async function countFeeds(userId: string, kind: FeedKind) {
  return prisma.jobFeed.count({ where: { userId, kind } });
}

async function assertCapacity(userId: string, kind: FeedKind) {
  if ((await countFeeds(userId, kind)) >= FEED_LIMITS[kind]) {
    throw Errors.validation(`You can have at most ${FEED_LIMITS[kind]} ${kind === "SEARCH" ? "saved searches" : kind === "COMPANY_BOARD" ? "followed companies" : kind === "DEMO" ? "demo provider" : "connected mailboxes"}.`);
  }
}

async function loadOwned(userId: string, feedId: string) {
  const feed = await prisma.jobFeed.findFirst({ where: { id: feedId, userId } });
  if (!feed) throw Errors.notFound("Job source");
  return feed;
}

/** Mailbox provider errors during user-facing requests become friendly API errors (not generic 500s). */
async function mailCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof MailAuthError) throw Errors.validation(e.message);
    if (e instanceof FeedProviderError) throw Errors.providerNotConfigured(e.message);
    if (e instanceof Error && e.name === "MailTransientError") throw Errors.providerUnavailable("Microsoft sign-in is not responding right now. Try again in a minute.");
    throw e;
  }
}

/** A sync of this feed started less than a lease ago and has not finished. */
async function runInProgress(feedId: string): Promise<boolean> {
  return (await prisma.jobFeedRun.count({ where: { feedId, finishedAt: null, startedAt: { gt: new Date(Date.now() - LEASE_MS) } } })) > 0;
}

/** Map any failure to a short, user-facing message; never includes credentials or email content. */
function describeError(e: unknown): { message: string; needsAttention: boolean } {
  if (e instanceof MailAuthError) return { message: e.message, needsAttention: true };
  if (e instanceof FeedProviderError) return { message: e.message.slice(0, 200), needsAttention: !e.retryable };
  return { message: "The source could not be reached. It will be retried automatically.", needsAttention: false };
}

// ---------------------------------------------------------------- fetching per kind

async function fetchSearch(feed: FeedRow): Promise<RawImportedJob[]> {
  const provider = getSearchProvider(feed.provider);
  if (!provider) throw new FeedProviderError("This search provider is no longer available.", false);
  if (!provider.isAvailable(feedEnv())) {
    logger.warn("feed.provider_unavailable", { provider: provider.id, missing: provider.requiredEnv });
    throw new FeedProviderError(`${provider.label} is not available on this server right now.`, false);
  }
  const c = feed.config as unknown as SearchConfig;
  if (await budgetExhausted(provider.id)) {
    throw new FeedProviderError(`${provider.label} has reached this server's request limit for now; it will refresh automatically.`, true);
  }
  return provider.search({ keywords: c.keywords, location: c.location, remoteOnly: c.remoteOnly, maxDaysOld: c.maxDaysOld, limit: 50 }, { env: feedEnv(), fetch: cachingFetch(provider.id) });
}

async function fetchBoard(feed: FeedRow): Promise<RawImportedJob[]> {
  const adapter = getBoardAdapter(feed.provider);
  if (!adapter) throw new FeedProviderError("This job-board provider is no longer supported.", false);
  const c = feed.config as unknown as BoardConfig;
  const { jobs } = await adapter.fetchJobs(c.slug, { env: feedEnv() });
  return jobs;
}

/** The demo provider (DEMO CONTENT) is available outside production, or when the operator enables it explicitly. */
export function demoProviderEnabled(): boolean {
  return isDemoProviderEnabled(process.env);
}

function fetchDemo(): RawImportedJob[] {
  if (!demoProviderEnabled()) throw new FeedProviderError("The demo provider is disabled on this server.", false);
  return generateDemoAutomationJobs({ appUrl: env().APP_URL });
}

async function fetchMailbox(feed: FeedRow): Promise<{ raws: RawImportedJob[]; cursor: MailCursor; messages: number }> {
  if (!feed.secretEnc) throw new MailAuthError("Reconnect this mailbox.");
  const c = feed.config as unknown as MailboxConfig;
  const cursor = (feed.cursor ?? {}) as MailCursor;
  const since = new Date(Date.now() - MAILBOX_LOOKBACK_DAYS * 86_400_000);
  const opts = { since, senderDomains: JOB_ALERT_SENDER_DOMAINS, maxMessages: MAILBOX_MESSAGES_PER_RUN, cursor };
  let result: { messages: Parameters<typeof parseJobAlertEmail>[0][]; cursor: MailCursor };
  // Route on the connection type, not the preset: an app-password Gmail mailbox uses IMAP.
  if (feed.provider === "gmail") {
    const { clientId, clientSecret } = gmailClient();
    const accessToken = await gmailAccessToken({ clientId, clientSecret, refreshToken: decryptText(feed.secretEnc) });
    result = await fetchAlertEmailsGmail(accessToken, opts);
  } else if (feed.provider === "outlook") {
    // Microsoft accounts only allow OAuth (app passwords stopped working in 2024); refresh tokens rotate.
    const token = await microsoftAccessToken({ clientId: microsoftClient(), tenant: env().MICROSOFT_TENANT, refreshToken: decryptText(feed.secretEnc) });
    if (token.refreshToken) await prisma.jobFeed.update({ where: { id: feed.id }, data: { secretEnc: encryptText(token.refreshToken) } });
    const preset = IMAP_PRESETS.outlook!;
    result = await fetchAlertEmailsImap({ host: preset.host, port: preset.port, secure: preset.secure, user: c.email, accessToken: token.accessToken }, { ...opts, folder: c.folder || "INBOX" });
  } else {
    const preset = IMAP_PRESETS[c.preset];
    const host = preset?.host ?? c.host;
    if (!host) throw new MailAuthError("Mailbox settings are incomplete. Reconnect this mailbox.");
    result = await fetchAlertEmailsImap(
      { host, port: preset?.port ?? c.port ?? 993, secure: preset?.secure ?? c.secure ?? true, user: c.email, password: decryptText(feed.secretEnc) },
      { ...opts, folder: c.folder || "INBOX" },
    );
  }
  // Only extracted job fields are kept; the emails themselves are never stored.
  const raws = result.messages.flatMap((m) => parseJobAlertEmail(m).jobs);
  return { raws, cursor: result.cursor, messages: result.messages.length };
}

function microsoftClient(): string {
  const id = env().MICROSOFT_CLIENT_ID;
  if (!id) throw new FeedProviderError("Outlook is not configured on this server (MICROSOFT_CLIENT_ID).", false);
  return id;
}

export function gmailRedirectUri(): string {
  return `${env().APP_URL.replace(/\/$/, "")}/api/job-feeds/mailbox/gmail/callback`;
}

/** Local part of the private forwarding address: jobs-<token>@INBOUND_EMAIL_DOMAIN. */
function forwardingAddress(token: string): string {
  return `jobs-${token}@${env().INBOUND_EMAIL_DOMAIN}`;
}

function gmailClient() {
  const clientId = env().GOOGLE_CLIENT_ID;
  const clientSecret = env().GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new FeedProviderError("Gmail is not configured on this server (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).", false);
  return { clientId, clientSecret };
}

// ---------------------------------------------------------------- relevance & dedupe helpers

/**
 * Company boards are filtered by the profile's target roles and locations; a saved search is
 * filtered by its own keywords and place (the user typed exactly what they want there).
 */
async function filterRelevant(feed: FeedRow, raws: RawImportedJob[]): Promise<RawImportedJob[]> {
  const config = feed.config as { onlyRelevant?: boolean };
  if (!config.onlyRelevant || !raws.length) return raws;
  const profile = await relevancePrefs(feed.userId);
  let prefs: RelevancePrefs = profile;
  if (feed.kind === "SEARCH") {
    const c = feed.config as unknown as SearchConfig;
    prefs = {
      ...profile,
      targetRoles: [c.keywords],
      preferredLocations: c.remoteOnly ? ["Remote - India"] : c.location ? [c.location] : ["India"],
      workModePreference: c.remoteOnly ? "remote" : "any",
    };
  }
  if (!prefs.targetRoles.length) return raws;
  return raws.filter((r) => assessRelevance(r, prefs).relevant);
}

/** Drop jobs this user already imported from the same source (by external id), before capping. */
async function dropKnown(userId: string, raws: RawImportedJob[]): Promise<RawImportedJob[]> {
  const ids = raws.map((r) => r.externalId).filter((x): x is string => !!x);
  if (!ids.length) return raws;
  const known = new Set<string>();
  for (let i = 0; i < ids.length; i += 500) {
    const rows = await prisma.jobSource.findMany({ where: { externalId: { in: ids.slice(i, i + 500) }, job: { ownerUserId: userId } }, select: { externalId: true } });
    for (const r of rows) if (r.externalId) known.add(r.externalId);
  }
  return raws.filter((r) => !r.externalId || !known.has(r.externalId));
}

// ---------------------------------------------------------------- notifications

/** Mode-neutral: in Auto mode the automation may apply to some of these jobs on the user's behalf. */
export const NEW_MATCHES_BODY = "Found automatically from your job sources. Open your job inbox to see them.";

/**
 * One "new matches" notification per local day (dedupe key), updated as more jobs arrive. Once the user has read it,
 * the next arrivals start a fresh count and show it as new again.
 */
async function notifyNewMatches(userId: string, newJobIds: string[]) {
  if (!newJobIds.length) return;
  const strong = await prisma.jobMatchScore.count({ where: { userId, jobId: { in: newJobIds }, score: { gte: 60 } } });
  if (!strong) return;
  const day = await notificationService.localDay(userId);
  await notificationService.accumulate(userId, { type: "jobs.new_matches", link: "/jobs?new=true", dedupeKey: `new-matches:${day}` }, (previous) => {
    const total = strong + (previous ? Number(/^(\d+)/.exec(previous.title)?.[1] ?? 0) : 0);
    return { title: `${total} new job${total === 1 ? "" : "s"} match your profile`, body: NEW_MATCHES_BODY };
  });
}

/**
 * The first failed sync of a feed's current failure streak: the streak is the `failures` most recent failed syncs
 * (consecutiveFailures is reset by every success and every reconnect / resume).
 */
async function failureStreakStart(feedId: string, failures: number): Promise<string> {
  const runs = await prisma.jobFeedRun.findMany({ where: { feedId, error: { not: null } }, orderBy: { startedAt: "desc" }, take: Math.max(1, failures), select: { id: true } });
  return runs[runs.length - 1]?.id ?? "unknown";
}

/** Outcome of one feed sync (also recorded as a JobFeedRun). */
export interface FeedSyncResult {
  feedId: string;
  provider: string;
  label: string;
  fetched: number;
  created: number;
  merged: number;
  skipped: number;
  newJobIds: string[];
  error: string | null;
}

/**
 * Jobs that arrived outside an automation run (forwarded alert emails, "Sync now") are evaluated promptly: the
 * user's next automation run is brought forward to the next scheduler tick (only when automation is on).
 */
async function requestAutomationRun(userId: string, newJobIds: string[]) {
  if (!newJobIds.length) return;
  await prisma.automationSettings.updateMany({ where: { userId, enabled: true }, data: { nextRunAt: new Date() } });
}

// ---------------------------------------------------------------- service

export const jobFeedsService = {
  /** Everything the "Job sources" page needs. */
  async overview(userId: string) {
    const feeds = await prisma.jobFeed.findMany({ where: { userId }, orderBy: { createdAt: "asc" }, include: FEED_INCLUDE });
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
    // Setup details (.env names, key signup links) are for the operator, not for every user.
    const operatorView = env().NODE_ENV !== "production" || user?.role === "ADMIN";
    const prefs = await relevancePrefs(userId);
    const e = feedEnv();
    const searchProviders = SEARCH_PROVIDERS.map((p) => ({
      id: p.id,
      label: p.label,
      coverage: p.coverage,
      available: p.isAvailable(e),
      requiredEnv: operatorView ? p.requiredEnv : [],
      signupUrl: operatorView ? p.signupUrl : null,
      attribution: p.attribution,
      descriptionLevel: p.descriptionLevel,
    }));
    const existingSearches = new Set(
      feeds.filter((f) => f.kind === "SEARCH").map((f) => {
        const c = f.config as unknown as SearchConfig;
        return `${f.provider}|${c.keywords.toLowerCase()}|${(c.location ?? "").toLowerCase()}`;
      }),
    );
    const followed = new Set(feeds.filter((f) => f.kind === "COMPANY_BOARD").map((f) => `${f.provider}|${(f.config as unknown as BoardConfig).slug.toLowerCase()}`));
    return {
      operatorView,
      feeds: feeds.map(safeFeed),
      limits: FEED_LIMITS,
      searchProviders,
      searchSuggestions: this.searchSuggestions(prefs, searchProviders).filter((s) => !existingSearches.has(`${s.provider}|${s.keywords.toLowerCase()}|${(s.location ?? "").toLowerCase()}`)),
      boardProviders: BOARD_ADAPTERS.map((b) => ({ id: b.id, label: b.label })),
      suggestedCompanies: SUGGESTED_COMPANIES.filter((c) => !followed.has(`${c.provider}|${c.slug.toLowerCase()}`)),
      mailbox: {
        gmailAvailable: !!env().GOOGLE_CLIENT_ID && !!env().GOOGLE_CLIENT_SECRET,
        outlookAvailable: !!env().MICROSOFT_CLIENT_ID,
        forwardingAvailable: !!env().INBOUND_EMAIL_DOMAIN && !!env().INBOUND_EMAIL_SECRET,
        imapPresets: Object.entries(IMAP_PRESETS).map(([id, p]) => ({ id, label: p.label, appPasswordUrl: p.appPasswordUrl, notes: p.notes })),
        customImapAllowed: env().ALLOW_CUSTOM_IMAP_HOST,
        senderDomains: JOB_ALERT_SENDER_DOMAINS,
      },
      alertGuides: ALERT_SETUP_GUIDES,
      hasProfilePrefs: prefs.targetRoles.length > 0,
    };
  },

  /** Saved searches suggested from the profile: target roles x preferred cities (+ remote). */
  searchSuggestions(prefs: RelevancePrefs, providers: { id: string; available: boolean; coverage: string }[]) {
    const roles = prefs.targetRoles.slice(0, 3);
    const onsite = providers.find((p) => p.available && p.coverage === "india");
    const remote = providers.find((p) => p.available && p.coverage === "remote");
    const cities = prefs.preferredLocations.filter((l) => !/remote/i.test(l)).slice(0, 3);
    const wantsRemote = prefs.workModePreference === "remote" || prefs.preferredLocations.some((l) => /remote/i.test(l)) || prefs.workModePreference === "any";
    const out: { provider: string; keywords: string; location: string | null; remoteOnly: boolean; label: string }[] = [];
    for (const role of roles) {
      if (onsite && prefs.workModePreference !== "remote") {
        for (const city of cities.length ? cities : [null]) out.push({ provider: onsite.id, keywords: role, location: city, remoteOnly: false, label: `${role} in ${city ?? "India"}` });
      }
      if (remote && wantsRemote) out.push({ provider: remote.id, keywords: role, location: null, remoteOnly: true, label: `${role} (remote)` });
    }
    return out.slice(0, FEED_LIMITS.SEARCH);
  },

  async list(userId: string) {
    const feeds = await prisma.jobFeed.findMany({ where: { userId }, orderBy: { createdAt: "asc" }, include: FEED_INCLUDE });
    return feeds.map(safeFeed);
  },

  async createSearch(userId: string, input: FeedSearchCreateInput, requestId?: string) {
    const provider = getSearchProvider(input.provider);
    if (!provider) throw Errors.validation("Unknown search provider.");
    if (!provider.isAvailable(feedEnv())) throw Errors.providerNotConfigured(`${provider.label} is not configured on this server.`);
    await assertCapacity(userId, "SEARCH");
    const remoteOnly = provider.coverage === "remote" ? true : input.remoteOnly;
    const same = await prisma.jobFeed.findMany({ where: { userId, kind: "SEARCH", provider: provider.id }, select: { config: true } });
    const norm = (v: string | null | undefined) => (v ?? "").trim().toLowerCase();
    if (same.some((f) => { const c = f.config as unknown as SearchConfig; return norm(c.keywords) === norm(input.keywords) && norm(c.location) === norm(remoteOnly ? null : input.location) && c.remoteOnly === remoteOnly; })) {
      throw Errors.conflict("You already have this saved search.");
    }
    const config: SearchConfig = { keywords: input.keywords, location: remoteOnly ? null : input.location, remoteOnly, maxDaysOld: input.maxDaysOld, onlyRelevant: true };
    const label = `${input.keywords}${remoteOnly ? " (remote)" : ` in ${input.location ?? "India"}`} · ${provider.label}`;
    return this.create(userId, { kind: "SEARCH", provider: provider.id, label, config: config as unknown as Prisma.InputJsonValue }, requestId);
  },

  /** Company name or careers URL -> candidate boards (verified live against the official APIs). */
  async findBoards(query: string): Promise<BoardProbe[]> {
    try {
      return await this.findBoardsUnsafe(query);
    } catch (e) {
      if (e instanceof FeedProviderError) throw Errors.providerUnavailable(e.message);
      throw e;
    }
  },

  async findBoardsUnsafe(query: string): Promise<BoardProbe[]> {
    const trimmed = query.trim();
    if (/^https?:\/\//i.test(trimmed) || /\.(io|co|com|in|app)\//i.test(trimmed)) {
      const ref = detectBoardFromUrl(trimmed.startsWith("http") ? trimmed : `https://${trimmed}`);
      if (!ref) throw Errors.validation("This URL is not a Greenhouse, Lever, Ashby or other supported job board. Try the company name instead.");
      const adapter = getBoardAdapter(ref.provider)!;
      const probe = await adapter.probe(ref.slug, { env: feedEnv() });
      return probe ? [probe] : [];
    }
    return findCompanyBoards(trimmed, { env: feedEnv() });
  },

  async createBoard(userId: string, input: FeedBoardCreateInput, requestId?: string) {
    const adapter = getBoardAdapter(input.provider);
    if (!adapter) throw Errors.validation("Unknown job-board provider.");
    await assertCapacity(userId, "COMPANY_BOARD");
    const dup = await prisma.jobFeed.findFirst({ where: { userId, kind: "COMPANY_BOARD", provider: adapter.id, config: { path: ["slug"], equals: input.slug } } });
    if (dup) throw Errors.conflict("You already follow this company.");
    // Confirm the board exists before saving it.
    let probe: BoardProbe | null;
    try {
      probe = await adapter.probe(input.slug, { env: feedEnv() });
    } catch (e) {
      if (e instanceof FeedProviderError) throw Errors.providerUnavailable(e.message);
      throw e;
    }
    if (!probe) throw Errors.validation("That job board could not be found. Check the company or URL.");
    const companyName = input.companyName ?? probe.companyName ?? input.slug;
    const config: BoardConfig = { slug: input.slug, companyName, boardUrl: probe.boardUrl, onlyRelevant: input.onlyRelevant };
    return this.create(userId, { kind: "COMPANY_BOARD", provider: adapter.id, label: `${companyName} · ${adapter.label}`, config: config as unknown as Prisma.InputJsonValue }, requestId);
  },

  async connectImap(userId: string, input: FeedImapConnectInput, requestId?: string) {
    await assertCapacity(userId, "MAILBOX");
    const preset = IMAP_PRESETS[input.preset];
    let host: string;
    let port: number;
    let secure = true;
    if (preset) {
      ({ host, port, secure } = preset);
    } else if (input.preset === "custom" && env().ALLOW_CUSTOM_IMAP_HOST && input.host) {
      // Custom hosts are opt-in for self-hosters (avoids the server connecting to arbitrary hosts).
      host = input.host;
      port = input.port ?? 993;
    } else {
      throw Errors.validation("Choose your email provider.");
    }
    const conn = { host, port, secure, user: input.email, password: input.appPassword };
    const check = await testImapConnection(conn, { folder: input.folder || "INBOX", senderDomains: JOB_ALERT_SENDER_DOMAINS });
    if (!check.ok) throw Errors.validation(check.message);
    const config: MailboxConfig = { preset: preset ? input.preset : "custom", ...(preset ? {} : { host, port, secure }), email: input.email, folder: input.folder || "INBOX", onlyRelevant: false };
    const feed = await this.create(
      userId,
      { kind: "MAILBOX", provider: "imap", label: `Job alerts in ${input.email}`, config: config as unknown as Prisma.InputJsonValue, secretEnc: encryptText(input.appPassword) },
      requestId,
    );
    await audit(userId, "feed.mailbox_connected", { requestId, entityType: "JobFeed", entityId: feed.id, metadata: { provider: "imap", preset: config.preset } });
    return feed;
  },

  /** Replace the app password of an existing IMAP mailbox (e.g. after it was revoked), keeping its jobs and history. */
  async reconnectImap(userId: string, feedId: string, appPassword: string, requestId?: string) {
    const feed = await loadOwned(userId, feedId);
    if (feed.kind !== "MAILBOX" || feed.provider !== "imap") throw Errors.validation("Only app-password mailboxes can be reconnected this way.");
    const c = feed.config as unknown as MailboxConfig;
    const preset = IMAP_PRESETS[c.preset];
    const host = preset?.host ?? c.host;
    if (!host) throw Errors.validation("Mailbox settings are incomplete. Remove it and connect again.");
    const check = await testImapConnection({ host, port: preset?.port ?? c.port ?? 993, secure: preset?.secure ?? c.secure ?? true, user: c.email, password: appPassword });
    if (!check.ok) throw Errors.validation(check.message);
    await prisma.jobFeed.update({
      where: { id: feedId },
      data: { secretEnc: encryptText(appPassword), status: "ACTIVE", lastError: null, consecutiveFailures: 0, nextSyncAt: new Date() },
    });
    await audit(userId, "feed.mailbox_connected", { requestId, entityType: "JobFeed", entityId: feedId, metadata: { provider: "imap", reconnected: true } });
    await this.syncNow(userId, feedId);
    return safeFeed(await prisma.jobFeed.findUniqueOrThrow({ where: { id: feedId }, include: FEED_INCLUDE }));
  },

  /** Called from the Gmail OAuth callback with the (already exchanged) refresh token. */
  async connectGmail(userId: string, input: { email: string; refreshToken: string }, requestId?: string) {
    const existing = await prisma.jobFeed.findFirst({ where: { userId, kind: "MAILBOX", provider: "gmail", config: { path: ["email"], equals: input.email } } });
    const config: MailboxConfig = { preset: "gmail", email: input.email, onlyRelevant: false };
    if (existing) {
      await prisma.jobFeed.update({
        where: { id: existing.id },
        data: { secretEnc: encryptText(input.refreshToken), status: "ACTIVE", lastError: null, consecutiveFailures: 0, nextSyncAt: new Date() },
      });
      await audit(userId, "feed.mailbox_connected", { requestId, entityType: "JobFeed", entityId: existing.id, metadata: { provider: "gmail", reconnected: true } });
      await this.syncNow(userId, existing.id, "created");
      return safeFeed(await prisma.jobFeed.findUniqueOrThrow({ where: { id: existing.id }, include: FEED_INCLUDE }));
    }
    await assertCapacity(userId, "MAILBOX");
    const feed = await this.create(
      userId,
      { kind: "MAILBOX", provider: "gmail", label: `Job alerts in ${input.email}`, config: config as unknown as Prisma.InputJsonValue, secretEnc: encryptText(input.refreshToken) },
      requestId,
    );
    await audit(userId, "feed.mailbox_connected", { requestId, entityType: "JobFeed", entityId: feed.id, metadata: { provider: "gmail" } });
    return feed;
  },

  async create(userId: string, data: { kind: FeedKind; provider: string; label: string; config: Prisma.InputJsonValue; secretEnc?: string }, requestId?: string) {
    const feed = await prisma.jobFeed.create({
      data: { userId, ...data, intervalMinutes: FEED_INTERVALS[data.kind], nextSyncAt: new Date() },
      include: { _count: { select: { jobs: true } } },
    });
    await audit(userId, "feed.created", { requestId, entityType: "JobFeed", entityId: feed.id, metadata: { kind: data.kind, provider: data.provider } });
    // First sync right away so the user sees jobs immediately (push-only forwarding feeds wait for mail).
    if (data.provider !== "forwarding") await this.syncNow(userId, feed.id, "created");
    return safeFeed(feed);
  },

  async update(userId: string, feedId: string, input: FeedUpdateInput, requestId?: string) {
    const feed = await loadOwned(userId, feedId);
    const config = { ...(feed.config as Record<string, unknown>) };
    if (input.onlyRelevant !== undefined) config.onlyRelevant = input.onlyRelevant;
    const updated = await prisma.jobFeed.update({
      where: { id: feedId },
      data: {
        ...(input.label ? { label: input.label } : {}),
        ...(input.intervalMinutes ? { intervalMinutes: Math.max(input.intervalMinutes, MIN_INTERVALS[feed.kind]) } : {}),
        ...(input.paused === true ? { status: "PAUSED" } : input.paused === false ? { status: "ACTIVE", nextSyncAt: new Date(), consecutiveFailures: 0 } : {}),
        config: config as Prisma.InputJsonValue,
      },
      include: { _count: { select: { jobs: true } } },
    });
    await audit(userId, "feed.updated", { requestId, entityType: "JobFeed", entityId: feedId, metadata: { paused: input.paused ?? null } });
    return safeFeed(updated);
  },

  /** Removes the source (and revokes Gmail access). Jobs already found stay in the inbox. */
  async remove(userId: string, feedId: string, requestId?: string) {
    const feed = await loadOwned(userId, feedId);
    if (feed.provider === "gmail" && feed.secretEnc) {
      await gmailRevoke(decryptText(feed.secretEnc)).catch(() => undefined);
    }
    await prisma.jobFeed.delete({ where: { id: feedId } });
    await audit(userId, "feed.removed", { requestId, entityType: "JobFeed", entityId: feedId, metadata: { kind: feed.kind, provider: feed.provider } });
    return { removed: true };
  },

  /** Account deletion: revoke OAuth grants we hold (best effort). */
  async revokeAll(userId: string) {
    const feeds = await prisma.jobFeed.findMany({ where: { userId, provider: "gmail", secretEnc: { not: null } }, select: { secretEnc: true } });
    for (const f of feeds) await gmailRevoke(decryptText(f.secretEnc!)).catch(() => undefined);
  },

  async syncNow(userId: string, feedId: string, trigger: "manual" | "created" = "manual"): Promise<{ queued: boolean; alreadyRunning?: boolean; taskId?: string | null }> {
    const feed = await loadOwned(userId, feedId);
    if (feed.status === "PAUSED") throw Errors.invalidState("Resume this source before syncing it.");
    if (feed.status === "NEEDS_ATTENTION" && trigger === "manual") throw Errors.invalidState("Reconnect this source first.");
    if (feed.provider === "forwarding") return { queued: false };
    if (await runInProgress(feedId)) return { queued: false, alreadyRunning: true };
    // Atomic claim (same lease as the scheduler): concurrent clicks or ticks queue one sync.
    const now = new Date();
    const claim = await prisma.jobFeed.updateMany({
      where: { id: feedId, userId, OR: [{ nextSyncAt: null }, { nextSyncAt: { lte: now } }, { nextSyncAt: { gt: new Date(now.getTime() + LEASE_MS) } }] },
      data: { nextSyncAt: new Date(now.getTime() + LEASE_MS) },
    });
    if (claim.count !== 1) return { queued: false, alreadyRunning: true };
    const { taskId } = await enqueue("feeds.sync", { feedId, trigger }, { userId, dedupeKey: `feeds.sync:${feedId}` });
    return { queued: true, taskId };
  },

  async syncAll(userId: string) {
    const feeds = await prisma.jobFeed.findMany({ where: { userId, status: { in: ["ACTIVE", "ERROR"] }, provider: { not: "forwarding" } }, select: { id: true } });
    let queued = 0;
    let alreadyRunning = 0;
    for (const f of feeds) {
      const r = await this.syncNow(userId, f.id);
      if (r.queued) queued++;
      else if (r.alreadyRunning) alreadyRunning++;
    }
    return { queued, alreadyRunning };
  },

  // ------------------------------------------------------------ Gmail (OAuth, read-only scope)

  /** Start the Google consent flow. The PKCE verifier and nonce travel in an encrypted, http-only cookie. */
  async gmailStart(userId: string, loginHint?: string) {
    const { clientId } = gmailClient();
    // Check the mailbox limit before sending the user to Google (reconnecting an existing Gmail source is fine).
    const reconnecting = loginHint ? await prisma.jobFeed.count({ where: { userId, provider: "gmail", config: { path: ["email"], equals: loginHint } } }) : 0;
    if (!reconnecting) await assertCapacity(userId, "MAILBOX");
    const nonce = randomToken(16);
    const pkce = createPkcePair();
    const state = signToken("gmail-oauth", { userId, nonce }, 10 * 60_000);
    const url = gmailAuthUrl({ clientId, redirectUri: gmailRedirectUri(), state, codeChallenge: pkce.challenge, loginHint });
    const cookie = encryptText(JSON.stringify({ nonce, verifier: pkce.verifier }));
    return { url, cookie };
  },

  async gmailCallback(userId: string, input: { code: string; state: string; cookie: string | undefined }, requestId?: string) {
    let claims: { userId: string; nonce: string };
    let stored: { nonce: string; verifier: string };
    try {
      claims = verifyToken<{ userId: string; nonce: string }>("gmail-oauth", input.state);
      stored = JSON.parse(decryptText(input.cookie ?? "")) as { nonce: string; verifier: string };
    } catch {
      throw Errors.validation("The Google sign-in expired or was started in another browser. Please try again.");
    }
    // Bound to the signed-in user and this browser (prevents connecting someone else's mailbox).
    if (claims.userId !== userId || claims.nonce !== stored.nonce) throw Errors.forbidden("This Google sign-in does not belong to your session.");
    const { clientId, clientSecret } = gmailClient();
    const tokens = await gmailExchangeCode({ clientId, clientSecret, redirectUri: gmailRedirectUri(), code: input.code, codeVerifier: stored.verifier });
    try {
      return await this.connectGmail(userId, { email: tokens.email, refreshToken: tokens.refreshToken }, requestId);
    } catch (e) {
      // Never leave a Google grant behind that the app did not keep.
      await gmailRevoke(tokens.refreshToken).catch(() => undefined);
      throw e;
    }
  },

  // ------------------------------------------------------------ Outlook / Hotmail / Microsoft 365 (device code)

  async outlookStart(userId: string, email: string) {
    const existing = await prisma.jobFeed.count({ where: { userId, provider: "outlook", config: { path: ["email"], equals: email } } });
    if (!existing) await assertCapacity(userId, "MAILBOX");
    const flow = await mailCall(() => microsoftStartDeviceCode({ clientId: microsoftClient(), tenant: env().MICROSOFT_TENANT }));
    // The device code stays server-side inside an encrypted token bound to this user.
    const flowToken = encryptText(JSON.stringify({ userId, email, deviceCode: flow.deviceCode, exp: Date.now() + flow.expiresIn * 1000 }));
    return { userCode: flow.userCode, verificationUri: flow.verificationUri, expiresIn: flow.expiresIn, interval: flow.interval, flowToken };
  },

  async outlookPoll(userId: string, flowToken: string, requestId?: string) {
    let flow: { userId: string; email: string; deviceCode: string; exp: number };
    try {
      flow = JSON.parse(decryptText(flowToken)) as typeof flow;
    } catch {
      throw Errors.validation("This sign-in request is invalid. Start again.");
    }
    if (flow.userId !== userId) throw Errors.forbidden("This sign-in request does not belong to your session.");
    if (Date.now() > flow.exp) return { status: "expired" as const };
    const r = await mailCall(() => microsoftPollDeviceCode({ clientId: microsoftClient(), tenant: env().MICROSOFT_TENANT, deviceCode: flow.deviceCode }));
    if (r.status !== "ok") return { status: r.status };
    const email = r.email ?? flow.email;
    const config: MailboxConfig = { preset: "outlook", email, folder: "INBOX", onlyRelevant: false };
    // Signing in again with the same account reconnects the existing source.
    const existing = await prisma.jobFeed.findFirst({ where: { userId, provider: "outlook", config: { path: ["email"], equals: email } } });
    if (existing) {
      await prisma.jobFeed.update({ where: { id: existing.id }, data: { secretEnc: encryptText(r.refreshToken), status: "ACTIVE", lastError: null, consecutiveFailures: 0, nextSyncAt: new Date() } });
      await audit(userId, "feed.mailbox_connected", { requestId, entityType: "JobFeed", entityId: existing.id, metadata: { provider: "outlook", reconnected: true } });
      await this.syncNow(userId, existing.id, "created");
      return { status: "ok" as const, feed: safeFeed(await prisma.jobFeed.findUniqueOrThrow({ where: { id: existing.id }, include: FEED_INCLUDE })) };
    }
    await assertCapacity(userId, "MAILBOX");
    const feed = await this.create(
      userId,
      { kind: "MAILBOX", provider: "outlook", label: `Job alerts in ${email}`, config: config as unknown as Prisma.InputJsonValue, secretEnc: encryptText(r.refreshToken) },
      requestId,
    );
    await audit(userId, "feed.mailbox_connected", { requestId, entityType: "JobFeed", entityId: feed.id, metadata: { provider: "outlook" } });
    return { status: "ok" as const, feed };
  },

  // ------------------------------------------------------------ private forwarding address (hosted, push)

  async createForwarding(userId: string, requestId?: string) {
    if (!env().INBOUND_EMAIL_DOMAIN || !env().INBOUND_EMAIL_SECRET) throw Errors.providerNotConfigured("Forwarding addresses are not configured on this server.");
    const existing = await prisma.jobFeed.findFirst({ where: { userId, kind: "MAILBOX", provider: "forwarding" } });
    if (existing) return safeFeed(existing);
    await assertCapacity(userId, "MAILBOX");
    const token = randomToken(18).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 24);
    const config = { preset: "forwarding", token, address: forwardingAddress(token), onlyRelevant: false };
    const feed = await this.create(userId, { kind: "MAILBOX", provider: "forwarding", label: "Forwarded job alerts", config: config as unknown as Prisma.InputJsonValue }, requestId);
    await prisma.jobFeed.update({ where: { id: feed.id }, data: { nextSyncAt: null } });
    await audit(userId, "feed.mailbox_connected", { requestId, entityType: "JobFeed", entityId: feed.id, metadata: { provider: "forwarding" } });
    return feed;
  },

  /**
   * Signed webhook from the inbound-email relay (e.g. a Cloudflare Email Worker). The raw email is
   * parsed in memory and discarded; only extracted job fields are stored. A forwarded email that is not a
   * job alert (an employer's reply about an application) goes to application-status email tracking, which
   * keeps metadata only and never replies.
   */
  async handleInbound(envelopeTo: string, raw: Buffer, requestId?: string) {
    const m = /^jobs-([a-z0-9]{8,64})@/i.exec(envelopeTo.trim());
    if (!m) return { accepted: false, reason: "unknown recipient" };
    const feed = await prisma.jobFeed.findFirst({ where: { provider: "forwarding", config: { path: ["token"], equals: m[1]!.toLowerCase() } } });
    if (!feed || feed.status === "PAUSED") return { accepted: false, reason: "unknown recipient" };
    const mail = await parseRawEmail(raw);
    const confirmation = gmailForwardingConfirmation(mail);
    if (confirmation) {
      // Never follow the link server-side: the user confirms forwarding in their own Google account.
      const cursor = { ...(feed.cursor as Record<string, unknown>), forwardingConfirmation: { ...confirmation, receivedAt: new Date().toISOString() } };
      await prisma.jobFeed.update({ where: { id: feed.id }, data: { cursor: cursor as Prisma.InputJsonValue } });
      // One notice per forwarding address: relay retries and repeated confirmations do not notify again (the
      // pending confirmation is always shown on the Job sources page).
      await notificationService.notify(feed.userId, {
        type: "feeds.forwarding_confirmation",
        title: "Confirm Gmail forwarding",
        body: "Gmail sent a confirmation for your ApplyWise forwarding address. Open Job sources to finish setup.",
        link: "/jobs/sources",
        dedupeKey: `feeds.forwarding_confirmation:${feed.id}`,
      });
      return { accepted: true, kind: "forwarding_confirmation" };
    }
    const run = await prisma.jobFeedRun.create({ data: { feedId: feed.id, userId: feed.userId, trigger: "inbound" } });
    try {
      // Filter-forwarded alerts keep the job site as sender. Hand-forwarded ones ("Fwd:", or forwarded
      // as attachment) arrive from the user: resolve the original alert inside, jobs only.
      let raws = parseJobAlertEmail(mail).jobs;
      if (!raws.length) raws = await parseAlertJobsFromRawEmail(raw.toString("utf8"));
      if (!raws.length) {
        // Not a job alert: most likely an employer's email about an application (confirmation, assessment,
        // interview, rejection, offer). Classified in memory; only a message-id hash, the sender domain and a
        // truncated subject are stored. Relay retries are deduplicated on the message id.
        const tracked = await applicationEmailTrackingService.ingest(
          feed.userId,
          {
            messageId: mail.messageId ?? `inbound:${sha256Hex(raw)}`,
            from: mail.from,
            subject: mail.subject,
            text: statusEmailPlainText(mail.text, mail.html),
            receivedAt: mail.date ?? new Date(),
          },
          "inbound",
        );
        await prisma.jobFeedRun.update({ where: { id: run.id }, data: { finishedAt: new Date(), fetched: 0, created: 0, merged: 0, skipped: 0 } });
        // The relay only learns what happened, never which application it was.
        return {
          accepted: true,
          kind: "status_email",
          category: tracked.category,
          duplicate: tracked.duplicate,
          associated: tracked.applicationId !== null,
          statusApplied: tracked.statusApplied !== null,
        };
      }
      const { results, newJobIds } = await jobsService.importRaws(feed.userId, raws, { connector: "feed:forwarding", normalize: normalizeRawJob, feedId: feed.id, requestId });
      const counts = { fetched: raws.length, created: newJobIds.length, merged: results.filter((r) => r.merged || r.upgraded).length, skipped: 0 };
      const now = new Date();
      await prisma.jobFeedRun.update({ where: { id: run.id }, data: { finishedAt: now, ...counts } });
      // The first alert proves forwarding works: the confirmation prompt is no longer needed.
      const { forwardingConfirmation: _done, ...cursor } = (feed.cursor ?? {}) as Record<string, unknown>;
      await prisma.jobFeed.update({
        where: { id: feed.id },
        data: { lastSyncAt: now, lastResult: counts, status: "ACTIVE", lastError: null, consecutiveFailures: 0, ...(raws.length ? { cursor: cursor as Prisma.InputJsonValue } : {}) },
      });
      await audit(feed.userId, "feed.inbound_received", { requestId, entityType: "JobFeed", entityId: feed.id, metadata: counts });
      await notifyNewMatches(feed.userId, newJobIds);
      await requestAutomationRun(feed.userId, newJobIds);
      return { accepted: true, kind: "job_alert", ...counts };
    } catch (e) {
      await prisma.jobFeedRun.update({ where: { id: run.id }, data: { finishedAt: new Date(), error: "This forwarded email could not be imported." } });
      await prisma.jobFeed.update({ where: { id: feed.id }, data: { lastError: "A forwarded email could not be imported. It will be retried.", consecutiveFailures: { increment: 1 } } });
      throw e;
    }
  },

  /**
   * Claim feeds atomically (conditional update + lease, safe with several app instances and with the automation
   * orchestrator running at the same time). `force` claims every active feed of the user (e.g. "Run now") unless
   * another worker holds its lease.
   */
  async claimDue(opts: { userId?: string; force?: boolean; limit?: number; now?: Date; excludeAutomationUsers?: boolean } = {}): Promise<{ id: string; userId: string }[]> {
    const now = opts.now ?? new Date();
    const dueWhere: Prisma.JobFeedWhereInput = opts.force
      ? { OR: [{ nextSyncAt: null }, { nextSyncAt: { lte: now } }, { nextSyncAt: { gt: new Date(now.getTime() + LEASE_MS) } }] }
      : { OR: [{ nextSyncAt: null }, { nextSyncAt: { lte: now } }] };
    const candidates = await prisma.jobFeed.findMany({
      where: {
        status: { in: ["ACTIVE", "ERROR"] },
        provider: { not: "forwarding" },
        ...(opts.userId ? { userId: opts.userId } : {}),
        // Users with automation on are discovered by their automation runs (one driver, accurate run metrics).
        ...(opts.excludeAutomationUsers ? { NOT: { user: { automationSettings: { is: { enabled: true } } } } } : {}),
        ...dueWhere,
      },
      select: { id: true, userId: true },
      orderBy: { nextSyncAt: "asc" },
      take: opts.limit ?? 25,
    });
    const claimed: { id: string; userId: string }[] = [];
    for (const f of candidates) {
      const claim = await prisma.jobFeed.updateMany({
        where: { id: f.id, status: { in: ["ACTIVE", "ERROR"] }, ...dueWhere },
        data: { nextSyncAt: new Date(now.getTime() + LEASE_MS) },
      });
      if (claim.count === 1) claimed.push(f);
    }
    return claimed;
  },

  /** Scheduler tick: claim due feeds atomically (safe with several app instances) and queue syncs. */
  async tick(now = new Date()) {
    let queued = 0;
    for (const f of await this.claimDue({ now, excludeAutomationUsers: true })) {
      await enqueue("feeds.sync", { feedId: f.id, trigger: "schedule" }, { userId: f.userId });
      queued++;
    }
    return { queued };
  },

  /** Add the fictional demo provider as an automatic source (DEMO CONTENT; one per user). */
  async createDemo(userId: string, requestId?: string) {
    if (!demoProviderEnabled()) throw Errors.providerNotConfigured("The demo provider is disabled on this server.");
    const existing = await prisma.jobFeed.findFirst({ where: { userId, kind: "DEMO" }, include: { _count: { select: { jobs: true } } } });
    if (existing) return safeFeed(existing);
    // Due immediately but not synced here: the next automation run (or "Sync now") discovers its jobs.
    const feed = await prisma.jobFeed.create({
      data: { userId, kind: "DEMO", provider: "demo", label: "Demo job provider (fictional jobs)", config: { onlyRelevant: false }, intervalMinutes: FEED_INTERVALS.DEMO, nextSyncAt: new Date() },
      include: { _count: { select: { jobs: true } } },
    });
    await audit(userId, "feed.created", { requestId, entityType: "JobFeed", entityId: feed.id, metadata: { kind: "DEMO", provider: "demo" } });
    return safeFeed(feed);
  },

  /** Background task: fetch, filter for relevance, import (dedupe/merge/score), record the run. */
  async runSync(feedId: string, trigger: string): Promise<FeedSyncResult | null> {
    const feed = await prisma.jobFeed.findUnique({ where: { id: feedId } });
    if (!feed || feed.status === "PAUSED") return null;
    // A duplicate task (e.g. a retried queue job) must not run the same feed twice at once.
    if (await runInProgress(feedId)) return null;
    const run = await prisma.jobFeedRun.create({ data: { feedId, userId: feed.userId, trigger } });
    const started = Date.now();
    try {
      let raws: RawImportedJob[];
      let cursor: Prisma.InputJsonValue | undefined;
      let fetched: number;
      if (feed.kind === "SEARCH") {
        raws = await fetchSearch(feed);
        fetched = raws.length;
      } else if (feed.kind === "COMPANY_BOARD") {
        raws = await fetchBoard(feed);
        fetched = raws.length;
      } else if (feed.kind === "DEMO") {
        raws = fetchDemo();
        fetched = raws.length;
      } else {
        const m = await fetchMailbox(feed);
        raws = m.raws;
        cursor = m.cursor as unknown as Prisma.InputJsonValue;
        fetched = raws.length;
      }
      const relevant = await filterRelevant(feed, raws);
      // Mailbox jobs are never capped (the cursor already moved past those emails); boards and searches
      // skip jobs they already imported first, so a big board continues where it left off next time.
      // The demo provider's catalogue is imported whole (it is fixed and small); jobs already known are merged.
      const batch = feed.kind === "MAILBOX" || feed.kind === "DEMO" ? relevant : (await dropKnown(feed.userId, relevant)).slice(0, MAX_NEW_JOBS_PER_RUN);
      const { results, newJobIds } = await jobsService.importRaws(feed.userId, batch, { connector: `feed:${feed.provider}`, normalize: normalizeRawJob, feedId: feed.id });
      const counts = {
        fetched,
        created: newJobIds.length,
        merged: results.filter((r) => r.merged || r.upgraded).length,
        skipped: fetched - relevant.length,
      };
      const now = new Date();
      await prisma.jobFeedRun.update({ where: { id: run.id }, data: { finishedAt: now, ...counts } });
      // The user may have paused the source while it was syncing: keep that choice.
      const current = await prisma.jobFeed.findUnique({ where: { id: feedId }, select: { status: true } });
      await prisma.jobFeed.update({
        where: { id: feedId },
        data: {
          status: current?.status === "PAUSED" ? "PAUSED" : "ACTIVE",
          lastSyncAt: now,
          nextSyncAt: new Date(now.getTime() + feed.intervalMinutes * 60_000),
          lastError: null,
          consecutiveFailures: 0,
          lastResult: counts,
          ...(cursor !== undefined ? { cursor } : {}),
        },
      });
      await notifyNewMatches(feed.userId, newJobIds);
      if (!trigger.startsWith("automation:")) await requestAutomationRun(feed.userId, newJobIds);
      logger.info("feed.synced", { feedId, provider: feed.provider, trigger, durationMs: Date.now() - started, ...counts });
      return { feedId, provider: feed.provider, label: feed.label, ...counts, newJobIds, error: null };
    } catch (e) {
      const { message, needsAttention } = describeError(e);
      const failures = feed.consecutiveFailures + 1;
      // Exponential backoff for transient failures, capped at the feed's normal interval (min 15 min).
      const retryMin = Math.min(feed.intervalMinutes, 15 * 2 ** Math.min(failures - 1, 6));
      await prisma.jobFeedRun.update({ where: { id: run.id }, data: { finishedAt: new Date(), error: message } });
      const current = await prisma.jobFeed.findUnique({ where: { id: feedId }, select: { status: true } });
      await prisma.jobFeed.update({
        where: { id: feedId },
        data: {
          status: current?.status === "PAUSED" ? "PAUSED" : needsAttention ? "NEEDS_ATTENTION" : "ERROR",
          lastError: message,
          consecutiveFailures: failures,
          nextSyncAt: needsAttention ? null : new Date(Date.now() + retryMin * 60_000),
        },
      });
      if (needsAttention && feed.status !== "NEEDS_ATTENTION") {
        // Sent when the source enters NEEDS_ATTENTION. The key names the feed and the failure streak (its first failed
        // sync after the last success or reconnect), so the same streak never notifies twice while a new streak after
        // a reconnect gets its own notice.
        const streakStart = await failureStreakStart(feed.id, failures);
        await notificationService.notify(feed.userId, {
          type: "feeds.needs_attention",
          title: `Job source needs attention: ${feed.label}`,
          body: message,
          link: "/jobs/sources",
          dedupeKey: `feeds.needs_attention:${feed.id}:${streakStart}`,
        });
      }
      logger.warn("feed.sync_failed", { feedId, provider: feed.provider, trigger, error: e instanceof Error ? e.name : "unknown", needsAttention });
      return { feedId, provider: feed.provider, label: feed.label, fetched: 0, created: 0, merged: 0, skipped: 0, newJobIds: [], error: message };
    }
  },
};
