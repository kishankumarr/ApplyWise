/** Field descriptor collected from the visible form on the current page (no values are read). */
export interface FieldDescriptor {
  index: number;
  tag: "input" | "textarea" | "select";
  type: string;
  name: string;
  id: string;
  placeholder: string;
  label: string;
  ariaLabel: string;
  autocomplete: string;
  automationId: string;
}

/** An approved prefill field from ApplyWise (only fields the user approved on the server). */
export interface PrefillField {
  key: string;
  label: string;
  value: string;
}

/**
 * A screening answer from ApplyWise: verified data, the user's own answer, or a generated draft citing verified
 * facts. Unknown answers are never sent (they arrive as `openQuestions`).
 */
export interface PrefillAnswer {
  question: string;
  answer: string;
  /** Canonical question key (e.g. "notice_period"), when classified. */
  key?: string | null;
  source?: string;
  /** false = not reviewed in ApplyWise yet: the popup starts it unselected and the user reads it first. */
  reviewed?: boolean;
}

export interface PrefillPayload {
  applicationId: string;
  /** Application status (APPROVED, OPENED_APPLY_PAGE, MANUAL_ACTION_REQUIRED or FAILED). Older servers omit it. */
  status?: string;
  job: { title: string; company: string; applyUrl: string | null };
  fields: PrefillField[];
  screeningAnswers: PrefillAnswer[];
  /** The prepared cover letter (also offered as the "coverLetter" field). */
  coverLetter?: string | null;
  /** false = the cover letter was not reviewed in ApplyWise yet. */
  coverLetterReviewed?: boolean;
  /** Questions without a verified answer: the user answers them on the page. */
  openQuestions?: { question: string; required: boolean }[];
  policy: string;
}

export interface FieldMapping {
  fieldIndex: number;
  fieldLabel: string;
  key: string;
  keyLabel: string;
  value: string;
  confidence: "adapter" | "high" | "medium";
  /** The value was not reviewed in ApplyWise yet (cover letter / generated answer): starts unselected. */
  needsReview?: boolean;
}

/** Why an automated application stopped (mirrors ManualActionReason in @applywise/types). */
export type ManualActionReason =
  | "CAPTCHA"
  | "MFA"
  | "LOGIN_REQUIRED"
  | "UNSUPPORTED_FLOW"
  | "UNKNOWN_REQUIRED_QUESTION"
  | "PROVIDER_RESTRICTION"
  | "AUTOMATION_NOT_SUPPORTED"
  | "SUBMISSION_UNCERTAIN";

/** An application the user has to apply to themselves (GET /api/extension/handoffs). */
export interface HandoffItem {
  applicationId: string;
  status: string;
  job: { title: string; company: string; applyUrl: string | null };
  reason: ManualActionReason | null;
  reasonLabel: string;
  reasonDetail: string | null;
  updatedAt: string;
}

export interface HandoffList {
  items: HandoffItem[];
  /** All matching applications (the list is capped at 20). */
  total: number;
}

export interface ExtractedJob {
  pageUrl: string;
  pageTitle: string;
  title: string;
  company: string;
  location: string;
  description: string;
  applyUrl: string | null;
  contactEmail: string | null;
}
