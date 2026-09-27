import {
  APPLICATION_STATUSES,
  ATTENTION_STATUSES,
  OUTCOME_STATUSES,
  PIPELINE_STATUSES,
  SENT_STATUSES,
  type ApplicationStatus,
  type AutomationDecision,
  type ExecutorKind,
  type RuleEffect,
  type RuleOutcome,
} from "@applywise/types";
import type { BadgeProps } from "@applywise/ui";

/** Presentation-only labels for the automation data shown on the job pages (no business rules here). */

export type BadgeVariant = NonNullable<BadgeProps["variant"]>;

export const DECISION_VARIANT: Record<AutomationDecision, BadgeVariant> = {
  AUTO_ELIGIBLE: "success",
  REVIEW: "info",
  RECOMMEND: "secondary",
  IGNORE: "outline",
};

/** What each rule-engine decision means for the user (tooltips and the job page's automation panel). */
export const DECISION_HINT: Record<AutomationDecision, string> = {
  IGNORE: "Filtered out by your automation rules. You can still prepare an application yourself.",
  RECOMMEND: "A reasonable match, but below your score for automatic preparation. Prepare it yourself if it interests you.",
  REVIEW: "Worth applying. The automation prepares it and waits for you to review it.",
  AUTO_ELIGIBLE:
    "Meets every rule. It is only submitted automatically in Auto mode, with your consent, when the provider supports automatic submission - otherwise it waits for you.",
};

export const RULE_OUTCOME_LABEL: Record<RuleOutcome, string> = {
  pass: "Passed",
  fail: "Failed",
  warn: "Warning",
  skip: "Did not apply",
};

/** Shown next to a check that changed the decision. */
export const RULE_EFFECT_LABEL: Record<RuleEffect, string | null> = {
  none: null,
  ignore: "Filtered out",
  cap_recommend: "Limited to Recommended",
  cap_review: "Limited to Review",
  raise_review: "Raised to Review",
  defer: "Submission deferred",
};

export const EXECUTOR_KIND_TEXT: Record<ExecutorKind, string> = {
  API: "Sent through the provider's application API or by email",
  BROWSER: "Filled in by an automated browser in the ApplyWise worker",
  MANUAL: "Manual handoff - you submit it yourself",
};

/** Row actions on the job matches table. */
export const PREPARABLE_STATUSES: readonly string[] = ["SAVED", "DISCOVERED", "MATCHED", "REJECTED_BY_RULES", "AUTO_ELIGIBLE"];
export const APPROVABLE_STATUSES: readonly string[] = ["READY_FOR_REVIEW", "WAITING_APPROVAL"];
/** Approved but not sent yet: the application page has the next step (apply on the official page, email, or submit). */
export const APPROVED_UNSENT_STATUSES: readonly string[] = ["APPROVED", "OPENED_APPLY_PAGE", "EMAIL_DRAFT_READY"];
/** The user has to resolve something on the application page. */
export const RESOLVE_STATUSES: readonly string[] = ["NEEDS_INFORMATION", "MANUAL_ACTION_REQUIRED", "FAILED"];

const ATTENTION: readonly string[] = ATTENTION_STATUSES;
const POSITIVE: readonly string[] = [...SENT_STATUSES, "ASSESSMENT", "INTERVIEW", "OFFER"];
const IN_FLIGHT: readonly string[] = ["PREPARING", "APPROVED", "APPLYING", "OPENED_APPLY_PAGE", "EMAIL_DRAFT_READY"];

export function applicationStatusVariant(status: string): BadgeVariant {
  if (status === "FAILED") return "destructive";
  if (ATTENTION.includes(status)) return "warning";
  if (POSITIVE.includes(status)) return "success";
  if (IN_FLIGHT.includes(status)) return "info";
  return "outline";
}

const STATUS_GROUPS: { label: string; statuses: readonly ApplicationStatus[] }[] = [
  { label: "Needs you", statuses: ATTENTION_STATUSES },
  { label: "In progress", statuses: ["SAVED", "PREPARING", "APPROVED", "OPENED_APPLY_PAGE", "EMAIL_DRAFT_READY", "APPLYING"] },
  { label: "Sent", statuses: SENT_STATUSES },
  { label: "Employer responses", statuses: OUTCOME_STATUSES },
  { label: "Automation pipeline", statuses: PIPELINE_STATUSES },
];

/** Every application status, grouped for the status filter (anything not listed above lands in "Closed"). */
export const STATUS_FILTER_GROUPS: { label: string; statuses: readonly ApplicationStatus[] }[] = [
  ...STATUS_GROUPS,
  { label: "Closed", statuses: APPLICATION_STATUSES.filter((s) => !STATUS_GROUPS.some((g) => g.statuses.includes(s))) },
];
