import type {
  AnswerSource,
  ApplicationMessageCategory,
  ApplicationMode,
  AutomationDecision,
  CandidateProfile,
  ClaimValidationResult,
  ExecutorKind,
  JobMatchReport,
  JobQuestion,
  ManualActionReason,
  NormalizedJob,
  PendingQuestion,
  RuleCheck,
  TailoredResumePlan,
} from "@applywise/types";

/** JSON shapes returned by the API (dates arrive as strings). */
export interface ProfileView {
  profile: CandidateProfile;
  onboarding: { step: number; completed: boolean };
  resumeFormatWarnings: string[];
  verification: { total: number; verified: number; unverified: number; rejected: number };
  consents: { cvProcessing: boolean; aiProcessing: boolean; emailSending: boolean; analytics: boolean; autoApply?: boolean };
  resumes: { id: string; originalFileName: string; mimeType: string; sizeBytes: number; status: "UPLOADED" | "PARSING" | "PARSED" | "FAILED"; parseError: string | null; parserProvider: string | null; createdAt: string; label: string | null; targetRoles: string[] }[];
}

export interface JobListItem {
  id: string;
  title: string;
  company: string;
  platform: string;
  locations: string[];
  workMode: string;
  experienceMinYears: number | null;
  experienceMaxYears: number | null;
  postedAt: string | null;
  applyMethod: string;
  importMethod: string;
  isDemo: boolean;
  attribution: string | null;
  /** Provider credit link for jobs from job-search APIs (e.g. "Jobs by Adzuna" -> adzuna.in); null for other sources. */
  attributionUrl: string | null;
  score: number | null;
  scoreLabel: string | null;
  recommendation: string | null;
  saved: boolean;
  ignored: boolean;
  applicationId: string | null;
  applicationStatus: string | null;
  /** Rule-engine decision when the automation evaluated this job (null = not evaluated). */
  automationDecision: AutomationDecision | null;
  salaryMin: number | null;
  salaryMax: number | null;
  currency: string | null;
  /** Requirements met / missing per the deterministic match report (visible page only). */
  matchedSkills: string[];
  missingSkills: string[];
  /** "SNIPPET" = only a short summary so far (job alert / search); the extension can add the full text. */
  descriptionLevel: DescriptionLevel;
  /** The automatic source that first found this job (null for manual imports and demo jobs). */
  feed: { id: string; label: string; kind: FeedKind } | null;
  foundAt: string;
  isNew: boolean;
}

export type DescriptionLevel = "FULL" | "SNIPPET";

export interface JobListView {
  showDemo: boolean;
  /** A demo catalogue exists on this server (demo text and toggles are hidden otherwise). */
  demoAvailable: boolean;
  /** null = automatic (demo jobs hide themselves once the user's own jobs arrive). */
  demoPreference: boolean | null;
  ownJobs: number;
  /** Jobs found automatically (not ignored) since the user last marked the inbox as seen. */
  newCount: number;
  seenAt: string | null;
  /** When the list was computed; sent back with "Mark all as seen" so later arrivals stay new. */
  asOf: string;
}

export interface JobSourcesSummary {
  total: number;
  active: number;
  needsAttention: number;
  lastSyncAt: string | null;
}

export interface JobListResponse {
  items: JobListItem[];
  total: number;
  page: number;
  pageSize: number;
  disclaimer: string;
  view: JobListView;
  sources: JobSourcesSummary;
}

export interface JobDetailResponse {
  job: NormalizedJob & { id: string };
  descriptionLevel: DescriptionLevel;
  sources: { attribution: string; attributionUrl: string | null; integrationClass: string; sourceUrl: string | null; importMethod: string; createdAt: string }[];
  contacts: { email: string; role: string | null }[];
  match: JobMatchReport | null;
  disclaimer: string;
  state: { saved: boolean; ignored: boolean };
  application: { id: string; status: string } | null;
  questionnaire: { id: string; status: string } | null;
}

export interface QuestionnaireView {
  id: string;
  jobId: string;
  status: string;
  provider: string;
  modelId: string | null;
  promptVersion: string;
  questions: JobQuestion[];
  answers: Record<string, { value: string; freeText: string | null }>;
}

export interface ApplicationView {
  id: string;
  status: string;
  applyMethod: string;
  notes: string | null;
  preparationError: string | null;
  approvedAt: string | null;
  openedApplyPageAt: string | null;
  submittedAt: string | null;
  emailSentAt: string | null;
  reminderAt: string | null;
  job: { id: string; title: string; company: string; platform: string; applyUrl: string | null; hrEmail: string | null; applicationInstructions: string | null; isDemo: boolean };
  tailored: {
    plan: TailoredResumePlan;
    editedSummary: string | null;
    editedBullets: { proposed: string; sourceFactIds: string[]; accepted: boolean }[] | null;
    validation: ClaimValidationResult;
    status: string;
    provider: string;
    modelId: string | null;
    promptVersion: string;
    previewHtml: string | null;
  } | null;
  coverLetter: { body: string; status: string; provider: string; modelId: string | null; promptVersion: string; edited: boolean } | null;
  screeningAnswers: {
    id: string;
    question: string;
    answer: string;
    canConfirm: boolean;
    provider: string;
    modelId: string | null;
    edited: boolean;
    questionKey: string | null;
    required: boolean;
    source: AnswerSource;
    /** false = no verified answer yet. */
    resolved: boolean;
  }[];
  emailDraft: { to: string; cc: string[]; subject: string; body: string; status: string; attachCoverLetter: boolean; resumeVersionId: string | null; provider: string; modelId: string | null; sentAt: string | null } | null;
  resumeVersions: { id: string; label: string; kind: string; createdAt: string; approvedAt: string | null }[];
  events: { id: string; type: string; message: string; fromStatus: string | null; toStatus: string | null; actor: "user" | "system" | "policy" | "executor" | string; createdAt: string }[];
  trackingOptions: string[];
  automation: {
    origin: "USER" | "AUTOMATION";
    mode: ApplicationMode | null;
    decision: AutomationDecision | null;
    decisionScore: number | null;
    decisionChecks: RuleCheck[];
    evaluatedAt: string | null;
    approvalSource: "user" | "policy" | null;
    executorKind: ExecutorKind | null;
    executorId: string | null;
    manualActionReason: ManualActionReason | null;
    manualActionLabel: string | null;
    manualActionDetail: string | null;
    pendingQuestions: PendingQuestion[];
    failureReason: string | null;
    appliedAt: string | null;
    externalApplicationId: string | null;
    nextActionAt: string | null;
    preparedAt: string | null;
    nextAction: string;
    /** Which executor would submit it now (null for the manual flow). */
    executor: { kind: ExecutorKind; id: string; label: string; automatic: boolean; reason: ManualActionReason | null; detail: string } | null;
    confirmation: string | null;
  };
  resumeSelection: { resumeId: string | null; versionId: string | null; label: string | null; score: number | null; reason: string | null; overridden: boolean };
  /** Application-status emails linked to this application (metadata only). */
  messages: { id: string; category: ApplicationMessageCategory; confidence: number; subject: string; fromDomain: string | null; receivedAt: string; statusApplied: boolean }[];
}

/** GET /api/applications row. */
export interface ApplicationListItem {
  id: string;
  status: string;
  applyMethod: string;
  job: { id: string; title: string; company: string; platform: string; applyMethod: string; locations: string[]; isDemo: boolean };
  preparationError: string | null;
  approvedAt: string | null;
  submittedAt: string | null;
  emailSentAt: string | null;
  reminderAt: string | null;
  updatedAt: string;
  trackingOptions: string[];
  origin: "USER" | "AUTOMATION";
  mode: ApplicationMode | null;
  automationDecision: AutomationDecision | null;
  matchScore: number | null;
  source: string | null;
  appliedAt: string | null;
  /** Executor id ("api:demo", "browser:demo-ats", "manual", ...) or null for the manual flow. */
  method: string | null;
  executorKind: ExecutorKind | null;
  resumeLabel: string | null;
  manualActionReason: ManualActionReason | null;
  nextAction: string;
}

/** GET /api/applications/[id]/resume */
export interface ResumeRankingView {
  selection: ApplicationView["resumeSelection"];
  ranking: { resumeId: string; versionId: string | null; label: string; score: number; matchedSkills: string[]; missingSkills: string[]; roleAligned: boolean }[];
}

export interface EmailPreview {
  from: string;
  replyTo: string | null;
  to: string;
  cc: string[];
  subject: string;
  body: string;
  attachments: { filename: string; contentType: string; sizeBytes: number }[];
  mailtoUrl: string;
  confirmationToken: string;
  expiresAt: string;
  provider: { name: string; deliversExternally: boolean; label: string };
  emailSendingConsent: boolean;
  senderEmail: string;
  senderVerified: boolean;
  senderVerification: { delivery: "outbox" | "catcher" | "external"; devLinkAvailable: boolean };
  canSendFromApp: boolean;
  recipientMatchesJob: boolean;
}

// ---------------------------------------------------------------- automatic job sources ("feeds")

export type FeedKind = "SEARCH" | "COMPANY_BOARD" | "MAILBOX";
export type FeedStatus = "ACTIVE" | "PAUSED" | "ERROR" | "NEEDS_ATTENTION";

/** Gmail's forwarding confirmation, received at the private forwarding address (the user confirms it). */
export interface ForwardingConfirmation {
  code: string | null;
  confirmUrl: string | null;
  requester: string | null;
  receivedAt: string;
}

export interface FeedView {
  id: string;
  kind: FeedKind;
  /** Search provider id, board provider id, or mailbox provider (imap | gmail | outlook | forwarding). */
  provider: string;
  label: string;
  /** Non-secret settings, e.g. keywords/location, slug/boardUrl, email/preset, or the forwarding address. */
  config: Record<string, unknown>;
  syncing: boolean;
  status: FeedStatus;
  intervalMinutes: number;
  lastSyncAt: string | null;
  nextSyncAt: string | null;
  lastError: string | null;
  lastResult: { fetched?: number; created?: number; merged?: number; skipped?: number } | null;
  jobCount: number | null;
  connected: boolean;
  createdAt: string;
  forwardingConfirmation?: ForwardingConfirmation | null;
}

/** Attribution arrives as { text, url } (older builds may send a plain string). */
export type ProviderAttribution = { text: string; url?: string | null } | string | null;

export interface SearchProviderView {
  id: string;
  label: string;
  coverage: "india" | "remote" | "global" | (string & {});
  available: boolean;
  requiredEnv: string[];
  signupUrl: string | null;
  attribution: ProviderAttribution;
  descriptionLevel: DescriptionLevel;
}

export interface SearchSuggestion {
  provider: string;
  keywords: string;
  location: string | null;
  remoteOnly: boolean;
  label: string;
}

/** A company's public job board, verified live (nothing is saved until the user follows it). */
export interface BoardProbe {
  provider: string;
  slug: string;
  companyName: string | null;
  jobCount: number;
  boardUrl: string;
}

/** Curated companies with public boards. Field names are read defensively (see sources/feed-utils). */
export interface SuggestedCompany {
  provider: string;
  slug: string;
  name?: string;
  companyName?: string;
  indiaJobs?: number;
  jobCount?: number;
  [key: string]: unknown;
}

export interface ImapPresetView {
  id: string;
  label: string;
  appPasswordUrl?: string | null;
  notes?: string | string[] | null;
}

export interface AlertGuide {
  platform?: string;
  label?: string;
  createAlertUrl?: string | null;
  steps?: string[];
  [key: string]: unknown;
}

export interface MailboxOptions {
  gmailAvailable: boolean;
  outlookAvailable: boolean;
  forwardingAvailable: boolean;
  imapPresets: ImapPresetView[];
  customImapAllowed: boolean;
  senderDomains: string[];
}

/** GET /api/job-feeds */
export interface JobFeedsOverview {
  feeds: FeedView[];
  limits: Record<FeedKind, number>;
  searchProviders: SearchProviderView[];
  searchSuggestions: SearchSuggestion[];
  boardProviders: { id: string; label: string }[];
  suggestedCompanies: SuggestedCompany[];
  mailbox: MailboxOptions;
  /** Expected to be an array; a record keyed by platform is tolerated. */
  alertGuides: AlertGuide[] | Record<string, AlertGuide>;
  hasProfilePrefs: boolean;
  /** Development or admin user: may see operator setup details (.env names, API key signup links). */
  operatorView: boolean;
}

/** POST /api/job-feeds/[feedId]/sync */
export interface FeedSyncResponse {
  queued: boolean;
  alreadyRunning?: boolean;
}

/** POST /api/job-feeds/sync-all */
export interface SyncAllResponse {
  queued: number;
  alreadyRunning: number;
}

export interface OutlookStartResponse {
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
  flowToken: string;
}

export interface OutlookPollResponse {
  status: "pending" | "slow_down" | "expired" | "denied" | "ok";
  feed?: FeedView;
}
