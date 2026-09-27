import type {
  ApplicationMessageCategory,
  ApplyMethod,
  JobPlatform,
  ManualActionReason,
  NormalizedJob,
  ProviderInfo,
  StatusEmailInput,
} from "@applywise/types";
import type { RawImportedJob } from "../connectors/types";

/**
 * Job provider abstraction.
 *
 * A provider describes one place jobs come from and/or applications go to (LinkedIn, Naukri, Greenhouse,
 * a search API, job-alert emails, the demo provider, ...). Capabilities are optional: a provider implements
 * only what it honestly supports, and `info()` reports each capability's status for the current
 * configuration. Discovery for existing sources keeps running through the feed adapters
 * (packages/job-engine/src/feeds); providers wrap them rather than replace them.
 *
 * Compliance (docs/platform-integration-policy.md): no scraping, no CAPTCHA/MFA/anti-bot bypass, no stored
 * job-platform passwords or cookies. A provider that cannot submit returns a manual-handoff decision.
 */

export type ProviderEnv = Record<string, string | undefined>;

export interface ProviderRuntime {
  env: ProviderEnv;
  /** Injected for tests; defaults to global fetch. */
  fetch?: typeof fetch;
  now?: Date;
  signal?: AbortSignal;
}

/** What the platform knows about a job when it asks a provider about applying. */
export interface ProviderJobRef {
  jobId: string;
  platform: JobPlatform;
  title: string;
  company: string;
  applyMethod: ApplyMethod;
  applyUrl: string | null;
  sourceUrl: string | null;
  sourceExternalId: string | null;
  hrEmail: string | null;
  isDemo: boolean;
  /** JobFeed.provider of the automatic source that found the job (e.g. "greenhouse", "adzuna", "imap", "demo"). */
  feedProvider: string | null;
  /** Raw source metadata of the job's first source (JobSource.metadata), e.g. the demo scenario. */
  sourceMetadata: Record<string, unknown>;
}

export interface ProviderQuestion {
  question: string;
  required: boolean;
  inputType: "text" | "textarea" | "select" | "boolean" | "number" | "file" | "url" | "email";
  options: string[] | null;
  /** Provider's own field id/name, if any. */
  providerKey: string | null;
}

export interface ApplicationRequirements {
  questions: ProviderQuestion[];
  requiresLogin: boolean;
  requiresResume: boolean;
  acceptsCoverLetter: boolean;
  notes: string[];
}

export type ApplicationChannel = "api" | "browser" | "email" | "manual";

export interface ApplicationSupport {
  supported: boolean;
  channel: ApplicationChannel;
  /** Why the application must be handed to the user (null when supported). */
  reason: ManualActionReason | null;
  detail: string;
}

/** Everything an executor may send. Built only from verified facts, user answers and approved documents. */
export interface SubmissionPayload {
  /** `${userId}:${canonicalJobKey}` - providers that support it must deduplicate on this key. */
  idempotencyKey: string;
  job: ProviderJobRef;
  /** The job's country qualifier (countryForLocations), so country-bound form questions get the right key. */
  jobCountry?: string | null;
  applicant: {
    fullName: string;
    firstName: string;
    lastName: string;
    email: string;
    phone: string | null;
    location: string | null;
    linkedinUrl: string | null;
    githubUrl: string | null;
    portfolioUrl: string | null;
    currentCompany: string | null;
    currentTitle: string | null;
    yearsOfExperience: number | null;
  };
  resume: { fileName: string; mimeType: string; content: Uint8Array } | null;
  coverLetter: string | null;
  /** Resolved answers only (never guessed): key = question key from the question classifier. */
  answers: { key: string; question: string; answer: string }[];
  /** Decrypted provider credential for this call only (never logged, never persisted by the provider). */
  credential: { token: string } | null;
}

export type SubmissionResult =
  | { outcome: "SUBMITTED"; externalApplicationId: string | null; confirmation: string | null }
  | { outcome: "MANUAL_ACTION_REQUIRED"; reason: ManualActionReason; detail: string }
  | { outcome: "NEEDS_INFORMATION"; questions: { question: string; required: boolean }[] }
  /** The provider rejected the credential: the connection moves to NEEDS_ATTENTION and nothing is retried. */
  | { outcome: "AUTH_FAILED"; detail: string }
  /**
   * submissionUncertain = the request may have reached the provider (e.g. timeout after sending). The execution
   * service then retries only if the executor submits idempotently; otherwise it asks the user to check.
   */
  | { outcome: "FAILED"; retryable: boolean; error: string; submissionUncertain: boolean };

export type ProviderApplicationStatus = "SUBMITTED" | "UNDER_REVIEW" | "ASSESSMENT" | "INTERVIEW" | "REJECTED" | "OFFER" | "UNKNOWN";

export interface StatusCheckResult {
  status: ProviderApplicationStatus;
  detail: string;
  /**
   * Optional employer message tied to the status (the demo provider simulates recruiter emails this way so the
   * real email classifier and association run on them).
   */
  message: (StatusEmailInput & { category?: ApplicationMessageCategory }) | null;
}

export interface DiscoveryContext {
  /** Non-secret feed configuration (JobFeed.config). */
  config: Record<string, unknown>;
  runtime: ProviderRuntime;
}

export interface JobProvider {
  id: string;
  /** Capability statuses resolved against the environment (safe to show to users). */
  info(env: ProviderEnv): ProviderInfo;
  /** True when this provider is responsible for applying to the given job. */
  matchesJob(job: ProviderJobRef): boolean;
  discover?(ctx: DiscoveryContext): Promise<RawImportedJob[]>;
  getDetails?(ref: { externalId: string | null; url: string | null }, runtime: ProviderRuntime): Promise<RawImportedJob | null>;
  normalize?(raw: RawImportedJob): Promise<NormalizedJob>;
  getApplicationRequirements?(job: ProviderJobRef, runtime: ProviderRuntime): Promise<ApplicationRequirements>;
  supportsApplication?(job: ProviderJobRef, env: ProviderEnv): ApplicationSupport;
  submitApplication?(payload: SubmissionPayload, runtime: ProviderRuntime): Promise<SubmissionResult>;
  checkApplicationStatus?(ref: { externalApplicationId: string; job: ProviderJobRef; appliedAt: Date }, runtime: ProviderRuntime): Promise<StatusCheckResult>;
}
