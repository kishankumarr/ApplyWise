import type { RawImportedJob } from "../connectors/types";

/**
 * Automatic job sources ("feeds"). Every adapter talks only to an official, documented API
 * (job-search APIs, public ATS job-board APIs) or parses job-alert emails the user received.
 * No adapter ever requests a job-site HTML page.
 */

export type FeedEnv = Record<string, string | undefined>;

export interface FeedContext {
  /** Injected for tests; defaults to global fetch. */
  fetch?: typeof fetch;
  env?: FeedEnv;
  now?: Date;
  signal?: AbortSignal;
}

/** A provider-level failure. `retryable` = try again later; otherwise the user must act. */
export class FeedProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = "FeedProviderError";
  }
}

// ---------------------------------------------------------------- job-search APIs

export interface SearchQuery {
  /** Role keywords, e.g. "frontend engineer react". */
  keywords: string;
  /** City or region, e.g. "Bengaluru"; null = anywhere in India (or anywhere for remote-only providers). */
  location: string | null;
  remoteOnly: boolean;
  /** Only jobs posted within this many days (where the API supports it). */
  maxDaysOld: number;
  /** Upper bound on results fetched per sync (across pages). */
  limit: number;
}

export interface SearchProviderInfo {
  id: string;
  label: string;
  /** Shown next to every job from this provider (required by most API terms). */
  attribution: { text: string; url: string };
  /** Environment variables the operator must set (empty = works without keys). */
  requiredEnv: string[];
  /** Where the operator gets a key. */
  signupUrl: string | null;
  coverage: "india" | "remote" | "global";
  /** Whether descriptions are full text or snippets. */
  descriptionLevel: "FULL" | "SNIPPET";
}

export interface SearchProviderAdapter extends SearchProviderInfo {
  isAvailable(env: FeedEnv): boolean;
  search(query: SearchQuery, ctx: FeedContext): Promise<RawImportedJob[]>;
}

// ---------------------------------------------------------------- company job boards (ATS public APIs)

export interface BoardRef {
  provider: string;
  /** Board token / site name / company identifier as used in the provider's public API. */
  slug: string;
}

export interface BoardProbe extends BoardRef {
  companyName: string | null;
  jobCount: number;
  /** A public page the user can open to check it is the right company. */
  boardUrl: string;
}

export interface BoardAdapter {
  id: string;
  label: string;
  /** Extract the slug from a careers/job URL on this provider's hosts, or null. */
  slugFromUrl(url: URL): string | null;
  /** Candidate slugs to try for a company name, most likely first. */
  slugCandidates(companyName: string): string[];
  probe(slug: string, ctx: FeedContext): Promise<BoardProbe | null>;
  fetchJobs(slug: string, ctx: FeedContext): Promise<{ companyName: string | null; jobs: RawImportedJob[] }>;
}

// ---------------------------------------------------------------- relevance

export interface RelevancePrefs {
  targetRoles: string[];
  preferredLocations: string[];
  workModePreference: "remote" | "hybrid" | "onsite" | "any";
  openToRelocation: boolean;
  /** Canonical skills the candidate has verified. */
  skills: string[];
}

export interface RelevanceResult {
  relevant: boolean;
  /** Short, user-facing reason, e.g. "Title matches 'Frontend Engineer'; Bengaluru". */
  reason: string;
}

// ---------------------------------------------------------------- job-alert emails

export interface AlertEmail {
  from: string;
  subject: string;
  html: string | null;
  text: string | null;
  date: Date | null;
  messageId: string | null;
}

export interface AlertParseResult {
  /** Detected provider (NAUKRI, LINKEDIN, INDEED, ...) or null when the sender is not a known job-alert sender. */
  platform: string | null;
  /** One entry per job card in the alert; descriptionLevel is SNIPPET. */
  jobs: RawImportedJob[];
  /** Non-fatal notes for debugging (never email content). */
  notes: string[];
}
