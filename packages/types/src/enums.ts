/**
 * Domain enums shared by the web app, extension, engines and the database layer.
 * Values intentionally mirror the Prisma enums in packages/database/prisma/schema.prisma.
 */

export const JOB_PLATFORMS = [
  "NAUKRI",
  "INDEED",
  "INSTAHYRE",
  "LINKEDIN",
  "COMPANY_CAREER_PAGE",
  "GREENHOUSE",
  "LEVER",
  "WORKDAY",
  "ASHBY",
  "SMARTRECRUITERS",
  "WORKABLE",
  "RECRUITEE",
  "FOUNDIT",
  "GLASSDOOR",
  "WELLFOUND",
  "CUTSHORT",
  "HIRIST",
  "JOB_SEARCH_API",
  "OTHER",
] as const;
export type JobPlatform = (typeof JOB_PLATFORMS)[number];

export const JOB_IMPORT_METHODS = [
  "OFFICIAL_API",
  "PARTNER_FEED",
  "USER_FORWARDED_EMAIL",
  "USER_INITIATED_BROWSER_IMPORT",
  "MANUAL_ENTRY",
  "CSV_IMPORT",
  "CAREER_PAGE_URL",
  "SEEDED_DEMO",
  "JOB_SEARCH_API",
  "USER_MAILBOX_ALERT",
] as const;
export type JobImportMethod = (typeof JOB_IMPORT_METHODS)[number];

/** Integration compliance classification for every platform integration. */
export const INTEGRATION_CLASSES = [
  "official_api",
  "partner_feed",
  "user_forwarded_email",
  "user_initiated_browser_import",
  "user_manual_entry",
  "career_page_url",
  "job_search_api",
  "user_mailbox_alert",
  "unsupported",
] as const;
export type IntegrationClass = (typeof INTEGRATION_CLASSES)[number];

export const APPLY_METHODS = ["PLATFORM", "CAREER_PAGE", "EMAIL", "MANUAL"] as const;
export type ApplyMethod = (typeof APPLY_METHODS)[number];

export const APPLICATION_STATUSES = [
  "SAVED",
  "PREPARING",
  "READY_FOR_REVIEW",
  "APPROVED",
  "OPENED_APPLY_PAGE",
  "EMAIL_DRAFT_READY",
  "EMAIL_SENT",
  "SUBMITTED",
  "INTERVIEW",
  "REJECTED",
  "OFFER",
  "WITHDRAWN",
  "EXPIRED",
  // Automation pipeline (see apps/web/src/server/domain/application-state.ts).
  "DISCOVERED",
  "MATCHING",
  "MATCHED",
  "REJECTED_BY_RULES",
  "NEEDS_INFORMATION",
  "WAITING_APPROVAL",
  "AUTO_ELIGIBLE",
  "APPLYING",
  "APPLIED",
  "FAILED",
  "MANUAL_ACTION_REQUIRED",
  "ASSESSMENT",
] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export const QUESTION_TYPES = [
  "SKILL_CONFIRMATION",
  "EXPERIENCE_DETAIL",
  "METRIC",
  "SCREENING",
  "PREFERENCE",
  "ELIGIBILITY",
  "OPEN_TEXT",
] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

export const TRUTH_STATUSES = [
  "PARSED_UNVERIFIED",
  "USER_VERIFIED",
  "USER_REJECTED",
  "USER_EDITED",
] as const;
export type TruthStatus = (typeof TRUTH_STATUSES)[number];

/** A fact counts as verified evidence only when the user confirmed or edited it. */
export function isVerifiedTruthStatus(status: TruthStatus): boolean {
  return status === "USER_VERIFIED" || status === "USER_EDITED";
}

export const WORK_MODES = ["remote", "hybrid", "onsite", "any"] as const;
export type WorkModePreference = (typeof WORK_MODES)[number];

export const JOB_WORK_MODES = ["remote", "hybrid", "onsite", "unknown"] as const;
export type JobWorkMode = (typeof JOB_WORK_MODES)[number];

export const EMPLOYMENT_TYPES = [
  "full_time",
  "part_time",
  "contract",
  "internship",
  "unknown",
] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

export const SENIORITY_LEVELS = [
  "intern",
  "junior",
  "mid",
  "senior",
  "lead",
  "principal",
  "unknown",
] as const;
export type SeniorityLevel = (typeof SENIORITY_LEVELS)[number];

export const FACT_KINDS = [
  "CONTACT",
  "SUMMARY",
  "EXPERIENCE",
  "EXPERIENCE_BULLET",
  "PROJECT",
  "SKILL",
  "EDUCATION",
  "CERTIFICATION",
  "ACHIEVEMENT",
  "QUESTIONNAIRE_ANSWER",
  "OTHER",
] as const;
export type FactKind = (typeof FACT_KINDS)[number];

export const SKILL_SOURCES = [
  "SKILLS_SECTION",
  "EXPERIENCE",
  "PROJECT",
  "QUESTIONNAIRE",
  "USER_ADDED",
] as const;
export type SkillSource = (typeof SKILL_SOURCES)[number];

export const PREFERRED_LOCATION_OPTIONS = [
  "Bengaluru",
  "Hyderabad",
  "Pune",
  "Mumbai",
  "Gurgaon",
  "Chennai",
  "Remote - India",
  "Remote - Global",
] as const;

export const CONSENT_TYPES = ["CV_PROCESSING", "AI_PROCESSING", "EMAIL_SENDING", "ANALYTICS", "AUTO_APPLY"] as const;
export type ConsentType = (typeof CONSENT_TYPES)[number];

/** Compliance classification for each import method (see docs/platform-integration-policy.md). */
export const IMPORT_METHOD_INTEGRATION_CLASS: Record<JobImportMethod, IntegrationClass> = {
  OFFICIAL_API: "official_api",
  PARTNER_FEED: "partner_feed",
  USER_FORWARDED_EMAIL: "user_forwarded_email",
  USER_INITIATED_BROWSER_IMPORT: "user_initiated_browser_import",
  MANUAL_ENTRY: "user_manual_entry",
  CSV_IMPORT: "user_manual_entry",
  CAREER_PAGE_URL: "career_page_url",
  SEEDED_DEMO: "user_manual_entry",
  JOB_SEARCH_API: "job_search_api",
  USER_MAILBOX_ALERT: "user_mailbox_alert",
};

export const PLATFORM_LABELS: Record<JobPlatform, string> = {
  NAUKRI: "Naukri",
  INDEED: "Indeed",
  INSTAHYRE: "Instahyre",
  LINKEDIN: "LinkedIn",
  COMPANY_CAREER_PAGE: "Career page",
  GREENHOUSE: "Greenhouse",
  LEVER: "Lever",
  WORKDAY: "Workday",
  ASHBY: "Ashby",
  SMARTRECRUITERS: "SmartRecruiters",
  WORKABLE: "Workable",
  RECRUITEE: "Recruitee",
  FOUNDIT: "Foundit",
  GLASSDOOR: "Glassdoor",
  WELLFOUND: "Wellfound",
  CUTSHORT: "Cutshort",
  HIRIST: "Hirist",
  JOB_SEARCH_API: "Job search",
  OTHER: "Other",
};

export const APPLICATION_STATUS_LABELS: Record<ApplicationStatus, string> = {
  SAVED: "Saved",
  PREPARING: "Preparing",
  READY_FOR_REVIEW: "Ready for review",
  APPROVED: "Approved",
  OPENED_APPLY_PAGE: "Opened apply page",
  EMAIL_DRAFT_READY: "Email draft ready",
  EMAIL_SENT: "Email sent",
  SUBMITTED: "Submitted",
  INTERVIEW: "Interview",
  REJECTED: "Rejected",
  OFFER: "Offer",
  WITHDRAWN: "Withdrawn",
  EXPIRED: "Expired",
  DISCOVERED: "Discovered",
  MATCHING: "Matching",
  MATCHED: "Matched",
  REJECTED_BY_RULES: "Filtered out by rules",
  NEEDS_INFORMATION: "Needs information",
  WAITING_APPROVAL: "Waiting for approval",
  AUTO_ELIGIBLE: "Auto-eligible",
  APPLYING: "Applying",
  APPLIED: "Applied",
  FAILED: "Failed",
  MANUAL_ACTION_REQUIRED: "Manual action required",
  ASSESSMENT: "Assessment",
};
