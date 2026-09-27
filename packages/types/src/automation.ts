/**
 * Automation layer: shared contracts between the rule engine (packages/job-engine/src/automation),
 * the provider registry (packages/job-engine/src/providers), the orchestrator/executors
 * (apps/web/src/server/services) and the UI. Values mirror the Prisma enums.
 */
import type { Paginated } from "./api";
import type { ApplicationStatus, ApplyMethod, JobPlatform, JobWorkMode, TruthStatus } from "./enums";

// ------------------------------------------------------------------ enums

export const APPLICATION_MODES = ["MANUAL", "REVIEW", "AUTO"] as const;
export type ApplicationMode = (typeof APPLICATION_MODES)[number];

export const APPLICATION_MODE_LABELS: Record<ApplicationMode, string> = {
  MANUAL: "Manual",
  REVIEW: "Review",
  AUTO: "Auto",
};

export const APPLICATION_MODE_DESCRIPTIONS: Record<ApplicationMode, string> = {
  MANUAL: "Discover, match and prepare applications. Nothing is ever submitted for you.",
  REVIEW: "Prepared applications wait for your approval; approved ones are submitted where the provider supports it.",
  AUTO: "Applications that meet every rule are submitted automatically where supported; everything else waits for you.",
};

export const AUTOMATION_DECISIONS = ["IGNORE", "RECOMMEND", "REVIEW", "AUTO_ELIGIBLE"] as const;
export type AutomationDecision = (typeof AUTOMATION_DECISIONS)[number];

export const AUTOMATION_DECISION_LABELS: Record<AutomationDecision, string> = {
  IGNORE: "Ignored",
  RECOMMEND: "Recommended",
  REVIEW: "Review",
  AUTO_ELIGIBLE: "Auto-eligible",
};

export const MANUAL_ACTION_REASONS = [
  "CAPTCHA",
  "MFA",
  "LOGIN_REQUIRED",
  "UNSUPPORTED_FLOW",
  "UNKNOWN_REQUIRED_QUESTION",
  "PROVIDER_RESTRICTION",
  "AUTOMATION_NOT_SUPPORTED",
  "SUBMISSION_UNCERTAIN",
] as const;
export type ManualActionReason = (typeof MANUAL_ACTION_REASONS)[number];

export const MANUAL_ACTION_REASON_LABELS: Record<ManualActionReason, string> = {
  CAPTCHA: "The application page shows a CAPTCHA",
  MFA: "The provider asked for multi-factor authentication",
  LOGIN_REQUIRED: "The provider requires you to sign in",
  UNSUPPORTED_FLOW: "This application flow is not supported by automation",
  UNKNOWN_REQUIRED_QUESTION: "A required question has no verified answer",
  PROVIDER_RESTRICTION: "The provider does not permit automated applications",
  AUTOMATION_NOT_SUPPORTED: "Automatic submission is not available for this provider",
  SUBMISSION_UNCERTAIN: "Automation was interrupted - please check whether the application was sent",
};

export const EXECUTOR_KINDS = ["API", "BROWSER", "MANUAL"] as const;
export type ExecutorKind = (typeof EXECUTOR_KINDS)[number];

export const EXECUTION_STATUSES = ["PENDING", "RUNNING", "SUCCEEDED", "FAILED", "MANUAL_ACTION_REQUIRED", "NEEDS_INFORMATION", "CANCELLED"] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

export const ANSWER_SOURCES = ["PROFILE", "PREFERENCE", "TRUTH_BANK", "PREVIOUS_ANSWER", "CANDIDATE_ANSWER", "GENERATED", "UNKNOWN"] as const;
export type AnswerSource = (typeof ANSWER_SOURCES)[number];

export const APPLICATION_MESSAGE_CATEGORIES = [
  "APPLICATION_CONFIRMATION",
  "RECRUITER_RESPONSE",
  "ASSESSMENT",
  "INTERVIEW",
  "REJECTION",
  "OFFER",
  "OTHER",
] as const;
export type ApplicationMessageCategory = (typeof APPLICATION_MESSAGE_CATEGORIES)[number];

export const PROVIDER_CONNECTION_STATUSES = ["CONNECTED", "NEEDS_AUTHENTICATION", "NEEDS_ATTENTION", "ERROR", "DISCONNECTED"] as const;
export type ProviderConnectionStatus = (typeof PROVIDER_CONNECTION_STATUSES)[number];

export const AUTOMATION_RUN_STATUSES = ["RUNNING", "COMPLETED", "FAILED"] as const;
export type AutomationRunStatus = (typeof AUTOMATION_RUN_STATUSES)[number];

// ------------------------------------------------------------------ status groups

/** Automation-owned states before preparation starts. */
export const PIPELINE_STATUSES = ["DISCOVERED", "MATCHING", "MATCHED", "REJECTED_BY_RULES", "AUTO_ELIGIBLE"] as const satisfies readonly ApplicationStatus[];
/** An application was sent (by an executor, by the user, or by confirmed email). */
export const SENT_STATUSES = ["APPLIED", "SUBMITTED", "EMAIL_SENT"] as const satisfies readonly ApplicationStatus[];
/** Employer responses after an application was sent. */
export const OUTCOME_STATUSES = ["ASSESSMENT", "INTERVIEW", "OFFER", "REJECTED"] as const satisfies readonly ApplicationStatus[];
/** The user has to do something. */
export const ATTENTION_STATUSES = ["READY_FOR_REVIEW", "WAITING_APPROVAL", "NEEDS_INFORMATION", "MANUAL_ACTION_REQUIRED", "FAILED"] as const satisfies readonly ApplicationStatus[];

// ------------------------------------------------------------------ rule engine

export type RuleCheckKey =
  | "match_score"
  | "excluded_title"
  | "target_title"
  | "excluded_company"
  | "preferred_company"
  | "required_skills"
  | "mandatory_skills"
  | "experience"
  | "location"
  | "work_mode"
  | "salary"
  | "job_age"
  | "provider"
  | "apply_method"
  | "description_level"
  | "daily_limit"
  | "already_applied";

export type RuleOutcome = "pass" | "fail" | "warn" | "skip";

/** What a check does to the decision when it does not pass. */
export type RuleEffect = "none" | "ignore" | "cap_recommend" | "cap_review" | "raise_review" | "defer";

export interface RuleCheck {
  key: RuleCheckKey;
  label: string;
  outcome: RuleOutcome;
  effect: RuleEffect;
  /** Plain-language explanation, e.g. "Posted 21 days ago (max 14)". */
  detail: string;
}

/** Merged AutomationSettings thresholds + AutomationRule filters. */
export interface AutomationRuleConfig {
  recommendScore: number;
  minMatchScore: number;
  autoApplyScore: number;
  maxJobAgeDays: number;
  maxApplicationsPerDay: number;
  /** Provider ids; empty = all. */
  enabledProviders: string[];
  targetTitles: string[];
  excludedTitles: string[];
  preferredCompanies: string[];
  excludedCompanies: string[];
  requiredSkills: string[];
  requiredSkillsMode: "any" | "all";
  allowMissingMandatorySkills: boolean;
  maxExperienceGapYears: number;
  locationMode: "preferences" | "any";
  allowedWorkModes: JobWorkMode[];
  minSalary: number | null;
  salaryCurrency: string;
  allowedApplyMethods: ApplyMethod[];
}

export interface RuleJobInput {
  title: string;
  company: string;
  platform: JobPlatform;
  /** Provider id from the provider registry (e.g. "greenhouse", "linkedin", "demo"). */
  providerId: string;
  locations: string[];
  workMode: JobWorkMode;
  applyMethod: ApplyMethod;
  salaryMin: number | null;
  salaryMax: number | null;
  currency: string | null;
  experienceMinYears: number | null;
  experienceMaxYears: number | null;
  /** ISO timestamps. postedAt falls back to foundAt for the age rule. */
  postedAt: string | null;
  foundAt: string;
  descriptionLevel: "FULL" | "SNIPPET";
  /** Canonical skill names. */
  requiredSkills: string[];
  preferredSkills: string[];
}

/** Facts from the deterministic JobMatchReport (never recomputed by the rule engine). */
export interface RuleMatchInput {
  score: number;
  /** Canonical names of mandatory requirements with no verified evidence. */
  missingMandatorySkills: string[];
  locationFit: "good" | "partial" | "poor" | "unknown";
}

export interface RuleContext {
  now: Date;
  candidateYoe: number | null;
  applicationsToday: number;
  /** Another application for the same canonical job was already sent or is being sent. */
  alreadyApplied: boolean;
}

export interface RuleEvaluation {
  decision: AutomationDecision;
  /** Decision from the score thresholds alone, before rule effects. */
  scoreDecision: AutomationDecision;
  score: number;
  checks: RuleCheck[];
  /** Short human-readable reasons for the final decision (most important first). */
  reasons: string[];
  /** True when the job qualifies for AUTO but today's limit is used up: execution is deferred, not dropped. */
  deferredByDailyLimit: boolean;
  engineVersion: string;
}

// ------------------------------------------------------------------ providers

export const PROVIDER_CAPABILITIES = ["DISCOVERY", "DETAIL_FETCH", "QUESTION_EXTRACTION", "AUTO_APPLY", "STATUS_TRACKING", "MANUAL_ONLY"] as const;
export type ProviderCapability = (typeof PROVIDER_CAPABILITIES)[number];

export const CAPABILITY_STATUSES = [
  /** Works with the current configuration. */
  "AVAILABLE",
  /** Works, but only partially (e.g. LinkedIn discovery only via job-alert emails). */
  "LIMITED",
  /** Supported by the code, but an operator key/flag is missing. */
  "NOT_CONFIGURED",
  /** Automatic submission is implemented and enabled. */
  "SUPPORTED",
  /** Implemented behind an operator opt-in and not validated against the live provider. */
  "EXPERIMENTAL",
  /** The user completes this step themselves (manual handoff). */
  "MANUAL",
  /** The provider's terms or technical barriers prevent it (no public API, login walls, anti-automation terms). */
  "EXTERNAL_LIMITATION",
  /** Needs an external agreement or credentials we do not have (partner API, employer API key). */
  "REQUIRES_EXTERNAL_CONFIGURATION",
  "NOT_SUPPORTED",
] as const;
export type CapabilityStatus = (typeof CAPABILITY_STATUSES)[number];

export interface ProviderCapabilityInfo {
  status: CapabilityStatus;
  /** How the capability is delivered, e.g. "job-alert emails", "public job-board API", "headless browser (worker)". */
  via: string | null;
  note: string;
}

export type ProviderKind = "job_board" | "ats" | "search_api" | "email_alerts" | "career_site" | "email_application" | "demo";
export type ProviderAuthMode = "none" | "api_key" | "oauth_token" | "not_supported";

/** Static + environment-resolved description of a provider (safe to send to the browser). */
export interface ProviderInfo {
  id: string;
  label: string;
  kind: ProviderKind;
  platforms: JobPlatform[];
  auth: ProviderAuthMode;
  capabilities: Record<Exclude<ProviderCapability, "MANUAL_ONLY">, ProviderCapabilityInfo>;
  /** True when every application for this provider ends in a manual handoff. */
  manualOnly: boolean;
  /** What an operator/user must arrange for the missing capabilities (env vars, partner agreements). */
  externalRequirements: string[];
  notes: string[];
  demo: boolean;
}

/** Status shown on a Settings -> Job sources card. */
export type SourceCardStatus = "CONNECTED" | "NEEDS_AUTHENTICATION" | "WORKING" | "LIMITED" | "MANUAL_ONLY" | "ERROR" | "NOT_CONFIGURED";

// ------------------------------------------------------------------ questions & answers

export type CanonicalQuestionKey =
  | "first_name"
  | "last_name"
  | "full_name"
  | "email"
  | "phone"
  | "current_location"
  | "linkedin_url"
  | "github_url"
  | "portfolio_url"
  | "current_company"
  | "current_title"
  | "total_experience_years"
  | "skill_experience_years"
  | "skill_experience"
  | "notice_period"
  | "current_salary"
  | "expected_salary"
  | "work_authorization"
  | "visa_sponsorship"
  | "willing_to_relocate"
  | "work_mode_preference"
  | "earliest_start_date"
  | "highest_education"
  | "cover_letter"
  | "resume"
  | "how_did_you_hear"
  | "diversity"
  | "custom";

export interface ApplicationQuestion {
  /** Stable key: the canonical key (with a skill suffix, e.g. "skill_experience_years:react") or "custom:<hash>". */
  key: string;
  canonicalKey: CanonicalQuestionKey;
  question: string;
  required: boolean;
  inputType: "text" | "textarea" | "select" | "boolean" | "number" | "file" | "url" | "email";
  options: string[] | null;
  /** Canonical skill for skill questions. */
  skill: string | null;
  /** Salary, notice, work authorisation, visa, relocation, start date: only user-provided answers are ever used. */
  sensitive: boolean;
  origin: "job_description" | "provider" | "standard";
}

export interface ResolvedAnswer {
  key: string;
  question: string;
  required: boolean;
  status: "RESOLVED" | "UNKNOWN" | "NOT_APPLICABLE";
  answer: string | null;
  source: AnswerSource;
  /** Fact / answer id the value came from (for audit), or a profile field name. */
  sourceRef: string | null;
  /** Why the answer was chosen, or why it is unknown. */
  reason: string;
}

export interface PendingQuestion {
  key: string;
  canonicalKey: CanonicalQuestionKey;
  question: string;
  required: boolean;
  options: string[] | null;
  sensitive: boolean;
}

// ------------------------------------------------------------------ resume selection

export interface ResumeSelectionCandidate {
  resumeId: string;
  versionId: string | null;
  label: string;
  targetRoles: string[];
  isPrimary: boolean;
  /** Canonical skills named in this resume's document. */
  skills: string[];
  /** Job titles in this resume's experience section. */
  titles: string[];
  /** Whole document as plain text (summary, bullets, projects). */
  text: string;
  createdAt: string;
}

export interface ResumeSelectionJob {
  title: string;
  requiredSkills: { canonicalName: string; mandatory: boolean }[];
  preferredSkills: string[];
  domains: string[];
}

export interface ResumeSelectionScore {
  resumeId: string;
  versionId: string | null;
  label: string;
  score: number;
  matchedSkills: string[];
  missingSkills: string[];
  roleAligned: boolean;
}

export interface ResumeSelectionResult {
  resumeId: string;
  versionId: string | null;
  label: string;
  /** 0-100, deterministic. */
  score: number;
  reason: string;
  ranking: ResumeSelectionScore[];
}

// ------------------------------------------------------------------ application status emails

export interface StatusEmailInput {
  from: string;
  subject: string;
  text: string;
  receivedAt: string;
}

export interface StatusEmailClassification {
  category: ApplicationMessageCategory;
  /** 0..1 */
  confidence: number;
  signals: string[];
  companyHint: string | null;
  titleHint: string | null;
  fromDomain: string | null;
}

export interface StatusEmailApplicationRef {
  applicationId: string;
  company: string;
  title: string;
  companyWebsite: string | null;
  sentAt: string | null;
}

export interface StatusEmailAssociation {
  applicationId: string | null;
  confidence: number;
  associatedBy: string | null;
}

// ------------------------------------------------------------------ API views (server -> UI)

export interface AutomationRuleView {
  targetTitles: string[];
  excludedTitles: string[];
  preferredCompanies: string[];
  excludedCompanies: string[];
  requiredSkills: string[];
  requiredSkillsMode: "any" | "all";
  allowMissingMandatorySkills: boolean;
  maxExperienceGapYears: number;
  locationMode: "preferences" | "any";
  allowedWorkModes: JobWorkMode[];
  minSalary: number | null;
  salaryCurrency: string;
  allowedApplyMethods: ApplyMethod[];
}

export interface AutomationRunSummary {
  id: string;
  trigger: string;
  status: AutomationRunStatus;
  mode: ApplicationMode;
  startedAt: string;
  completedAt: string | null;
  providersChecked: number;
  jobsFound: number;
  newJobs: number;
  duplicates: number;
  jobsMatched: number;
  ignored: number;
  recommended: number;
  reviewRequired: number;
  autoEligible: number;
  applicationsPrepared: number;
  applicationsSubmitted: number;
  needsInformation: number;
  manualActions: number;
  failures: number;
  error: string | null;
}

export interface AutomationRunProviderDetail {
  providerId: string;
  label: string;
  feedId: string | null;
  fetched: number;
  created: number;
  merged: number;
  skipped: number;
  error: string | null;
}

export interface AutomationRunItemView {
  id: string;
  stage: string;
  outcome: string;
  message: string;
  jobId: string | null;
  applicationId: string | null;
  job: { title: string; company: string } | null;
  createdAt: string;
}

/** A run's summary and per-provider results. Its timeline is paged separately (AutomationRunItemsPage). */
export interface AutomationRunDetail extends AutomationRunSummary {
  providers: AutomationRunProviderDetail[];
}

/** GET /api/automation/runs/[runId]/items: one page of the run's timeline (oldest first) plus counts for the filter chips. */
export interface AutomationRunItemsPage extends Paginated<AutomationRunItemView> {
  /** Every step the run recorded, ignoring the filters. */
  runTotal: number;
  /** Matching steps per stage: every filter applied except the stage. */
  stages: Record<string, number>;
  /** Matching steps per outcome: every filter applied except the outcome. */
  outcomes: Record<string, number>;
}

export interface AutomationReadiness {
  /** True when AUTO mode can actually submit something right now. */
  canAutoApply: boolean;
  /** Plain-language blockers, e.g. "Grant the auto-apply consent", "No enabled provider supports automatic submission". */
  blockers: string[];
}

export interface AutomationSettingsView {
  enabled: boolean;
  mode: ApplicationMode;
  recommendScore: number;
  minMatchScore: number;
  autoApplyScore: number;
  maxApplicationsPerDay: number;
  maxJobAgeDays: number;
  searchFrequencyMinutes: number;
  enabledProviders: string[];
  quietHoursStart: number | null;
  quietHoursEnd: number | null;
  timezone: string;
  tailorResume: boolean;
  generateCoverLetter: boolean;
  allowEmailApplications: boolean;
  notifyStrongMatches: boolean;
  dailySummaryHour: number | null;
  rulesVersion: number;
  rules: AutomationRuleView;
  autoApplyConsent: boolean;
  status: {
    lastRunAt: string | null;
    nextRunAt: string | null;
    running: boolean;
    applicationsToday: number;
    dailyLimit: number;
    inQuietHours: boolean;
    lastRun: AutomationRunSummary | null;
  };
  readiness: AutomationReadiness;
}

export interface ProviderConnectionView {
  status: ProviderConnectionStatus;
  authType: "NONE" | "API_KEY" | "OAUTH_TOKEN" | "SESSION_TOKEN";
  accountLabel: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  expiresAt: string | null;
}

export interface ProviderSourceCard extends ProviderInfo {
  cardStatus: SourceCardStatus;
  /** Enabled for automation in AutomationSettings.enabledProviders (empty list = all enabled). */
  enabledForAutomation: boolean;
  connection: ProviderConnectionView | null;
  /** Automatic sources (JobFeed rows) using this provider. */
  feeds: number;
  jobsFound: number;
}

export interface MatchFactorView {
  key: string;
  label: string;
  points: number;
  maxPoints: number;
  explanation: string;
}

export interface ReviewAnswerView {
  id: string;
  key: string | null;
  question: string;
  answer: string;
  source: AnswerSource;
  resolved: boolean;
  required: boolean;
}

export interface ReviewQueueItem {
  applicationId: string;
  status: ApplicationStatus;
  mode: ApplicationMode | null;
  job: {
    id: string;
    title: string;
    company: string;
    locations: string[];
    workMode: JobWorkMode;
    platform: JobPlatform;
    providerId: string;
    salaryMin: number | null;
    salaryMax: number | null;
    currency: string | null;
    experienceMinYears: number | null;
    experienceMaxYears: number | null;
    postedAt: string | null;
    applyUrl: string | null;
    isDemo: boolean;
  };
  match: { score: number | null; label: string | null; summary: string | null; factors: MatchFactorView[]; matchedSkills: string[]; missingSkills: string[] };
  decision: { decision: AutomationDecision | null; reasons: string[] };
  resume: { selectedResumeId: string | null; label: string | null; score: number | null; reason: string | null; overridden: boolean };
  tailored: { summary: string | null; unsupportedClaims: number; status: string } | null;
  coverLetter: string | null;
  answers: ReviewAnswerView[];
  pendingQuestions: PendingQuestion[];
  warnings: string[];
  /** Which executor would submit it (automatic=false: it will be handed to the user, detail says why). */
  executor: { kind: ExecutorKind; id: string; label: string; automatic: boolean; detail: string } | null;
  manualActionReason: ManualActionReason | null;
  manualActionDetail: string | null;
  updatedAt: string;
}

export interface DashboardSummary {
  jobsDiscoveredToday: number;
  newMatches: number;
  strongMatches: number;
  applicationsToday: number;
  applicationsThisWeek: number;
  waitingApproval: number;
  needsInformation: number;
  manualActionRequired: number;
  interviews: number;
  assessments: number;
  offers: number;
  rejections: number;
  automation: { enabled: boolean; mode: ApplicationMode; lastRunAt: string | null; nextRunAt: string | null; dailyLimit: number };
}

export interface ManualHandoffPackage {
  applicationId: string;
  status: ApplicationStatus;
  job: { id: string; title: string; company: string; locations: string[]; applyUrl: string | null; hrEmail: string | null; providerId: string; providerLabel: string };
  reason: ManualActionReason | null;
  reasonLabel: string | null;
  reasonDetail: string | null;
  match: { score: number | null; summary: string | null; factors: MatchFactorView[] };
  resume: { resumeId: string | null; label: string | null; versionId: string | null; reason: string | null };
  tailoredResume: { versionId: string; label: string } | null;
  coverLetter: string | null;
  screeningAnswers: { question: string; answer: string; source: AnswerSource }[];
  instructions: string[];
}

export interface CandidateAnswerView {
  id: string;
  questionKey: string;
  question: string;
  answer: string;
  source: AnswerSource;
  status: TruthStatus;
  updatedAt: string;
}
