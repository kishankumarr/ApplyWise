/**
 * Display helpers shared by the Applications list (server component) and the application workspace (client).
 * Pure functions only - no React, no server imports.
 */
import {
  AUTOMATION_DECISION_LABELS,
  PIPELINE_STATUSES,
  SENT_STATUSES,
  type AnswerSource,
  type ApplicationMessageCategory,
  type AutomationDecision,
  type RuleEffect,
  type RuleOutcome,
} from "@applywise/types";

export type DateLike = string | Date;
export type BadgeVariant = "default" | "secondary" | "destructive" | "outline" | "success" | "warning" | "info";

export const APPLICATION_VIEWS = ["active", "pipeline", "all"] as const;
export type ApplicationListView = (typeof APPLICATION_VIEWS)[number];

export function parseApplicationView(value: string | string[] | undefined): ApplicationListView {
  const v = Array.isArray(value) ? value[0] : value;
  return APPLICATION_VIEWS.includes(v as ApplicationListView) ? (v as ApplicationListView) : "active";
}

const PIPELINE: readonly string[] = PIPELINE_STATUSES;
const SENT: readonly string[] = SENT_STATUSES;

export const isPipelineStatus = (status: string) => PIPELINE.includes(status);
export const isSentStatus = (status: string) => SENT.includes(status);

/** The application was sent or already has an employer outcome: its resume and content are final. */
export const LOCKED_STATUSES: readonly string[] = [...SENT_STATUSES, "APPLYING", "ASSESSMENT", "INTERVIEW", "OFFER", "REJECTED", "WITHDRAWN", "EXPIRED"];

export function statusBadgeVariant(status: string): BadgeVariant {
  switch (status) {
    case "APPLIED":
    case "SUBMITTED":
    case "EMAIL_SENT":
    case "OFFER":
    case "APPROVED":
    case "OPENED_APPLY_PAGE":
    case "EMAIL_DRAFT_READY":
      return "success";
    case "INTERVIEW":
    case "ASSESSMENT":
    case "APPLYING":
    case "PREPARING":
    case "MATCHING":
      return "info";
    case "READY_FOR_REVIEW":
    case "WAITING_APPROVAL":
    case "NEEDS_INFORMATION":
    case "MANUAL_ACTION_REQUIRED":
      return "warning";
    case "FAILED":
      return "destructive";
    case "REJECTED":
    case "WITHDRAWN":
    case "EXPIRED":
    case "REJECTED_BY_RULES":
      return "secondary";
    default:
      return "outline";
  }
}

export function decisionVariant(decision: AutomationDecision | null): BadgeVariant {
  if (decision === "AUTO_ELIGIBLE") return "success";
  if (decision === "REVIEW") return "info";
  return "secondary";
}

export const decisionLabel = (decision: AutomationDecision | null) => (decision ? AUTOMATION_DECISION_LABELS[decision] : "Not evaluated");

/**
 * How the application is (or will be) sent, from the executor id: "api:demo", "api:email", "browser:<adapter>",
 * "manual". Applications without an executor were handled by the user in the manual flow.
 */
export function executorMethodLabel(executorId: string): string {
  if (executorId === "api:demo") return "Automatic (demo API)";
  if (executorId === "api:email") return "Automatic (email)";
  if (executorId.startsWith("browser:")) return "Automatic (browser)";
  if (executorId.startsWith("api:")) return "Automatic (API)";
  if (executorId === "manual") return "Manual";
  return executorId;
}

export function applicationMethodLabel(a: { method: string | null; origin: "USER" | "AUTOMATION"; mode: string | null; appliedAt: DateLike | null; status: string }): string {
  if (a.method) return executorMethodLabel(a.method);
  // The manual flow and Manual mode never submit anything: the user applies.
  if (a.origin === "USER" || a.mode === "MANUAL" || a.appliedAt || isSentStatus(a.status)) return "You";
  return "Not chosen yet";
}

/** Fallback "next step" for automation-owned statuses the server leaves blank (Pipeline view). */
export function pipelineNextAction(status: string, decision: AutomationDecision | null): string {
  switch (status) {
    case "DISCOVERED":
    case "MATCHING":
      return "Matching against your profile";
    case "MATCHED":
      if (decision === "REVIEW") return "Prepared on an upcoming automation run";
      if (decision === "RECOMMEND") return "Recommended - prepare it yourself if interested";
      return "Waiting for your rules to be applied";
    case "AUTO_ELIGIBLE":
      return "Prepared on an upcoming automation run";
    case "REJECTED_BY_RULES":
      return "Filtered out by your rules - open it to see why";
    default:
      return "";
  }
}

export const ACTOR_LABELS: Record<string, string> = { user: "You", system: "System", policy: "Auto policy", executor: "Executor" };
export const actorLabel = (actor: string) => ACTOR_LABELS[actor] ?? actor;
export function actorVariant(actor: string): BadgeVariant {
  if (actor === "user") return "secondary";
  if (actor === "policy") return "info";
  if (actor === "executor") return "default";
  return "outline";
}

export const ANSWER_SOURCE_LABELS: Record<AnswerSource, string> = {
  PROFILE: "From your profile",
  PREFERENCE: "From your preferences",
  TRUTH_BANK: "Verified fact",
  PREVIOUS_ANSWER: "Previous application",
  CANDIDATE_ANSWER: "Your saved answer",
  GENERATED: "Drafted",
  UNKNOWN: "No source",
};

export const MESSAGE_CATEGORY_LABELS: Record<ApplicationMessageCategory, string> = {
  APPLICATION_CONFIRMATION: "Application confirmation",
  RECRUITER_RESPONSE: "Recruiter response",
  ASSESSMENT: "Assessment",
  INTERVIEW: "Interview",
  REJECTION: "Rejection",
  OFFER: "Offer",
  OTHER: "Other",
};

export const RULE_OUTCOME_LABELS: Record<RuleOutcome, string> = { pass: "Passed", fail: "Failed", warn: "Warning", skip: "Not checked" };

export const RULE_EFFECT_LABELS: Record<RuleEffect, string> = {
  none: "",
  ignore: "Filters the job out",
  cap_recommend: "Limits the decision to Recommended",
  cap_review: "Limits the decision to Review",
  raise_review: "Raises the decision to Review",
  defer: "Deferred to a later day",
};

/** Only http(s) links (absolute, or same-origin paths) are rendered as clickable URLs. */
export function safeHttpUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  if (url.startsWith("/") && !url.startsWith("//")) return url;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

export const percent = (value: number) => `${Math.round(value * 100)}%`;
