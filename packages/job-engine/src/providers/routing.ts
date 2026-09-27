import type { JobPlatform } from "@applywise/types";
import { detectBoardFromUrl } from "../feeds/boards";
import { isJobProviderId, SEARCH_API_PROVIDER_IDS, type JobProviderId } from "./catalog";
import type { ProviderJobRef } from "./types";

/**
 * Which provider a job came from and which provider is responsible for applying to it. Pure functions over the
 * job's platform, automatic source, links and demo flag; host checks are anchored (a look-alike such as
 * boards.greenhouse.io.evil.test never matches).
 */

/** Platform -> provider (null: decided by the automatic source or the career-site fallback). */
const PLATFORM_PROVIDER: Record<JobPlatform, JobProviderId | null> = {
  NAUKRI: "naukri",
  INDEED: "indeed",
  INSTAHYRE: "instahyre",
  LINKEDIN: "linkedin",
  COMPANY_CAREER_PAGE: "career_site",
  GREENHOUSE: "greenhouse",
  LEVER: "lever",
  WORKDAY: "workday",
  ASHBY: "ashby",
  SMARTRECRUITERS: "smartrecruiters",
  WORKABLE: "workable",
  RECRUITEE: "recruitee",
  FOUNDIT: "foundit",
  GLASSDOOR: "glassdoor",
  WELLFOUND: "wellfound",
  CUTSHORT: "cutshort",
  HIRIST: "hirist",
  JOB_SEARCH_API: null,
  OTHER: null,
};

/** JobFeed.provider values of mailbox sources (their jobs belong to the platform named in the alert). */
const MAILBOX_FEED_PROVIDERS = new Set(["imap", "gmail", "outlook", "forwarding"]);

const SEARCH_IDS = new Set<string>(SEARCH_API_PROVIDER_IDS);

/** The platform's own provider, falling back to "career_site" (OTHER, JOB_SEARCH_API without a source). */
export function providerIdForPlatform(platform: JobPlatform): JobProviderId {
  return PLATFORM_PROVIDER[platform] ?? "career_site";
}

/** A job created by the demo provider or the seeded demo catalogue (DEMO CONTENT). */
export function isDemoProviderJob(job: Pick<ProviderJobRef, "isDemo" | "sourceMetadata">): boolean {
  return job.isDemo === true && !!job.sourceMetadata && (job.sourceMetadata as Record<string, unknown>).demo === true;
}

function parseHttpUrl(input: string | null | undefined): URL | null {
  if (!input || typeof input !== "string") return null;
  try {
    const url = new URL(input.trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

/** ATS hosts, including links detectBoardFromUrl deliberately rejects (Workable /j/ links, bare board hosts). */
const ATS_HOSTS: [RegExp, JobProviderId][] = [
  [/^(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io$/, "greenhouse"],
  [/^boards-api\.greenhouse\.io$/, "greenhouse"],
  [/^jobs(?:\.eu)?\.lever\.co$/, "lever"],
  [/^jobs\.ashbyhq\.com$/, "ashby"],
  [/(?:^|\.)(?:myworkdayjobs|myworkdaysite)\.com$/, "workday"],
  [/^(?:jobs|careers)\.smartrecruiters\.com$/, "smartrecruiters"],
  [/^apply\.workable\.com$/, "workable"],
  [/^(?!www\.)[a-z0-9-]+\.workable\.com$/, "workable"],
  [/^(?!www\.)[a-z0-9-]+\.recruitee\.com$/, "recruitee"],
];

/** Provider of an ATS application/job URL (Greenhouse, Lever, Ashby, Workday, SmartRecruiters, Workable, Recruitee), or null. */
export function atsProviderIdForUrl(input: string | null | undefined): JobProviderId | null {
  const url = parseHttpUrl(input);
  if (!url) return null;
  const board = detectBoardFromUrl(url.toString());
  if (board && isJobProviderId(board.provider)) return board.provider;
  const host = url.hostname.toLowerCase();
  return ATS_HOSTS.find(([re]) => re.test(host))?.[1] ?? null;
}

const JOB_BOARD_HOSTS: [RegExp, JobProviderId][] = [
  [/(?:^|\.)linkedin\.com$/, "linkedin"],
  [/(?:^|\.)naukri\.com$/, "naukri"],
  [/(?:^|\.)indeed\.(?:com|co\.in|co\.uk|ca|com\.au)$/, "indeed"],
  [/(?:^|\.)(?:foundit\.in|monsterindia\.com)$/, "foundit"],
  [/(?:^|\.)glassdoor\.(?:com|co\.in|co\.uk)$/, "glassdoor"],
  [/(?:^|\.)instahyre\.com$/, "instahyre"],
  [/(?:^|\.)(?:wellfound\.com|angel\.co)$/, "wellfound"],
  [/(?:^|\.)cutshort\.io$/, "cutshort"],
  [/(?:^|\.)(?:hirist\.(?:com|tech)|iimjobs\.com)$/, "hirist"],
];

/** Provider of a job-board URL (LinkedIn, Naukri, Indeed, ...), or null. */
export function jobBoardProviderIdForUrl(input: string | null | undefined): JobProviderId | null {
  const url = parseHttpUrl(input);
  if (!url) return null;
  const host = url.hostname.toLowerCase();
  return JOB_BOARD_HOSTS.find(([re]) => re.test(host))?.[1] ?? null;
}

/**
 * Where the job came from: demo jobs -> "demo"; the automatic source's provider (board, search API, demo);
 * mailbox sources -> the platform named in the alert (else "job_alert_email"); otherwise the platform's provider.
 */
export function sourceProviderIdFor(job: Pick<ProviderJobRef, "platform" | "feedProvider" | "isDemo" | "sourceMetadata">): JobProviderId {
  if (isDemoProviderJob(job)) return "demo";
  const feed = job.feedProvider?.trim().toLowerCase() ?? "";
  if (feed && MAILBOX_FEED_PROVIDERS.has(feed)) return PLATFORM_PROVIDER[job.platform] ?? "job_alert_email";
  if (isJobProviderId(feed)) return feed;
  return providerIdForPlatform(job.platform);
}

/**
 * The provider responsible for applying: demo jobs -> "demo"; an apply URL (or, without one, a source URL) on a
 * known ATS host -> that ATS; applyMethod EMAIL with an HR address -> "email_application"; an apply URL on a job
 * board -> that board; search-API jobs -> the search provider; otherwise the platform's provider or "career_site".
 */
export function applicationProviderIdForJob(job: ProviderJobRef): JobProviderId {
  if (isDemoProviderJob(job)) return "demo";
  const ats = atsProviderIdForUrl(job.applyUrl) ?? (job.applyUrl ? null : atsProviderIdForUrl(job.sourceUrl));
  if (ats) return ats;
  if (job.applyMethod === "EMAIL" && job.hrEmail) return "email_application";
  const board = jobBoardProviderIdForUrl(job.applyUrl);
  if (board) return board;
  const feed = job.feedProvider?.trim().toLowerCase() ?? "";
  if (job.platform === "JOB_SEARCH_API" && SEARCH_IDS.has(feed)) return feed as JobProviderId;
  return providerIdForPlatform(job.platform);
}
