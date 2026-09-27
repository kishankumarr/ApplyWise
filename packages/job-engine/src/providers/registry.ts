import type { ProviderInfo } from "@applywise/types";
import { normalizeRawJob } from "../connectors/normalize";
import { BOARD_ADAPTERS } from "../feeds/boards";
import { SEARCH_PROVIDERS } from "../feeds/search";
import { FeedProviderError, type FeedContext, type SearchQuery } from "../feeds/types";
import {
  BROWSER_ATS_PROVIDER_IDS,
  HANDOFF_ATS_PROVIDER_IDS,
  JOB_BOARD_PROVIDER_IDS,
  JOB_PROVIDER_IDS,
  SEARCH_API_PROVIDER_IDS,
  providerLabel,
  resolveProviderInfo,
  type JobProviderId,
} from "./catalog";
import { demoProvider } from "./demo";
import { fetchGreenhouseApplicationRequirements } from "./greenhouse";
import { applicationProviderIdForJob, sourceProviderIdFor } from "./routing";
import type { ApplicationSupport, DiscoveryContext, JobProvider, ProviderEnv, ProviderJobRef, ProviderRuntime } from "./types";

/**
 * Provider registry: one JobProvider per id.
 *
 * Provider ids: linkedin, indeed, naukri, foundit, wellfound, instahyre, glassdoor, cutshort, hirist,
 * greenhouse, lever, ashby, workday, smartrecruiters, workable, recruitee, career_site, adzuna, himalayas,
 * jobicy, themuse, job_alert_email, email_application, demo.
 *
 * Capabilities come from ./catalog (environment-resolved, never overstated). Discovery wraps the existing feed
 * adapters (packages/job-engine/src/feeds) - the web feed service keeps calling those adapters directly.
 * Providers that cannot submit return a manual-handoff decision from supportsApplication.
 */

function feedContext(runtime: ProviderRuntime): FeedContext {
  return { fetch: runtime.fetch, env: runtime.env, now: runtime.now, signal: runtime.signal };
}

const manual = (reason: "PROVIDER_RESTRICTION" | "AUTOMATION_NOT_SUPPORTED", detail: string): ApplicationSupport => ({
  supported: false,
  channel: "manual",
  reason,
  detail,
});

function base(id: JobProviderId): Pick<JobProvider, "id" | "info" | "matchesJob"> {
  return {
    id,
    info: (env: ProviderEnv) => resolveProviderInfo(id, env),
    matchesJob: (job: ProviderJobRef) => applicationProviderIdForJob(job) === id,
  };
}

/** LinkedIn, Naukri, Indeed, ... and Workday: the platform does not permit automated applications. */
function restrictedProvider(id: JobProviderId): JobProvider {
  return {
    ...base(id),
    supportsApplication: () =>
      manual("PROVIDER_RESTRICTION", resolveProviderInfo(id, {}).capabilities.AUTO_APPLY.note),
  };
}

/** Company boards on public ATS APIs: discovery wraps the board adapter (config.slug). */
function boardProvider(id: JobProviderId, extra: Partial<JobProvider>): JobProvider {
  const adapter = BOARD_ADAPTERS.find((a) => a.id === id);
  if (!adapter) throw new Error(`Board adapter "${id}" is missing from BOARD_ADAPTERS`);
  return {
    ...base(id),
    async discover(ctx: DiscoveryContext) {
      const slug = typeof ctx.config.slug === "string" ? ctx.config.slug : "";
      if (!slug) throw new FeedProviderError(`A ${adapter.label} board name is required.`, false);
      return (await adapter.fetchJobs(slug, feedContext(ctx.runtime))).jobs;
    },
    normalize: normalizeRawJob,
    ...extra,
  };
}

function toSearchQuery(config: Record<string, unknown>): SearchQuery {
  const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback);
  return {
    keywords: typeof config.keywords === "string" ? config.keywords : "",
    location: typeof config.location === "string" && config.location.trim() ? config.location : null,
    remoteOnly: config.remoteOnly === true,
    maxDaysOld: num(config.maxDaysOld, 14),
    limit: num(config.limit, 50),
  };
}

/** Job-search APIs: discovery wraps the search adapter (config = SearchQuery); apply on the provider's page. */
function searchProvider(id: JobProviderId): JobProvider {
  const adapter = SEARCH_PROVIDERS.find((p) => p.id === id);
  if (!adapter) throw new Error(`Search provider "${id}" is missing from SEARCH_PROVIDERS`);
  return {
    ...base(id),
    async discover(ctx: DiscoveryContext) {
      if (!adapter.isAvailable(ctx.runtime.env)) {
        throw new FeedProviderError(`${adapter.label} is not configured on this server (${adapter.requiredEnv.join(", ")}).`, false);
      }
      const query = toSearchQuery(ctx.config);
      if (!query.keywords.trim()) throw new FeedProviderError("Search keywords are required.", false);
      return adapter.search(query, feedContext(ctx.runtime));
    },
    normalize: normalizeRawJob,
    supportsApplication: () =>
      manual("AUTOMATION_NOT_SUPPORTED", `Apply on ${adapter.label}'s page (its terms require it); ApplyWise prepares the application for you.`),
  };
}

const BROWSER_SUPPORT: ApplicationSupport = {
  supported: true,
  channel: "browser",
  reason: null,
  detail: "Submitted by the experimental browser executor when the operator enabled it for this provider; otherwise handed to you.",
};

function buildProviders(): Map<JobProviderId, JobProvider> {
  const providers: JobProvider[] = [
    ...JOB_BOARD_PROVIDER_IDS.map(restrictedProvider),
    ...BROWSER_ATS_PROVIDER_IDS.map((id) =>
      boardProvider(id, {
        supportsApplication: () => BROWSER_SUPPORT,
        ...(id === "greenhouse" ? { getApplicationRequirements: (job: ProviderJobRef, runtime: ProviderRuntime) => fetchGreenhouseApplicationRequirements(job, runtime) } : {}),
      }),
    ),
    restrictedProvider("workday"),
    ...HANDOFF_ATS_PROVIDER_IDS.map((id) =>
      boardProvider(id, {
        supportsApplication: () =>
          manual("AUTOMATION_NOT_SUPPORTED", `Submitting through ${providerLabel(id)} needs the employer's API credentials; ApplyWise prepares the application for you.`),
      }),
    ),
    {
      ...base("career_site"),
      normalize: normalizeRawJob,
      supportsApplication: () => manual("AUTOMATION_NOT_SUPPORTED", "Company career sites are applied to by you; ApplyWise prepares the application."),
    },
    ...SEARCH_API_PROVIDER_IDS.map(searchProvider),
    {
      ...base("job_alert_email"),
      normalize: normalizeRawJob,
      supportsApplication: () => manual("AUTOMATION_NOT_SUPPORTED", "Job-alert emails are a discovery channel; apply through the platform named in the alert."),
    },
    {
      ...base("email_application"),
      supportsApplication: (job: ProviderJobRef) =>
        job.hrEmail
          ? { supported: true, channel: "email", reason: null, detail: `Sent by email to the HR address in the job post (${job.hrEmail}).` }
          : { supported: false, channel: "email", reason: "AUTOMATION_NOT_SUPPORTED", detail: "The job post names no HR email address." },
    },
    demoProvider,
  ];
  const map = new Map<JobProviderId, JobProvider>();
  for (const p of providers) map.set(p.id as JobProviderId, p);
  for (const id of JOB_PROVIDER_IDS) if (!map.has(id)) throw new Error(`Provider "${id}" is not registered`);
  return map;
}

const PROVIDERS = buildProviders();

export function listProviders(): JobProvider[] {
  return JOB_PROVIDER_IDS.map((id) => PROVIDERS.get(id)!);
}

export function getProvider(id: string): JobProvider | null {
  return PROVIDERS.get(id as JobProviderId) ?? null;
}

/** Environment-resolved capability descriptions for every provider (safe for the browser). */
export function providerInfos(env: ProviderEnv): ProviderInfo[] {
  return JOB_PROVIDER_IDS.map((id) => resolveProviderInfo(id, env));
}

/**
 * Where the job came from (used by rules' provider filter and shown as "Source"): the automatic source's
 * provider (e.g. "adzuna", "greenhouse", "demo"), else the platform's provider (LINKEDIN -> "linkedin").
 * Demo jobs are always "demo"; mailbox sources resolve to the platform named in the alert ("job_alert_email"
 * when it has none).
 */
export function sourceProviderIdForJob(job: Pick<ProviderJobRef, "platform" | "feedProvider" | "isDemo" | "sourceMetadata">): string {
  return sourceProviderIdFor(job);
}

/**
 * The provider responsible for submitting an application for this job: demo jobs -> "demo"; an apply URL on a
 * known ATS host -> that ATS; applyMethod EMAIL with an HR address -> "email_application"; otherwise the source
 * platform's provider, falling back to "career_site". Never null.
 */
export function applicationProviderForJob(job: ProviderJobRef): JobProvider {
  return PROVIDERS.get(applicationProviderIdForJob(job)) ?? PROVIDERS.get("career_site")!;
}
