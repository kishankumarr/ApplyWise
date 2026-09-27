import type { ApplicationStatus } from "@applywise/types";

/**
 * Application state machine.
 *
 * Manual flow (unchanged):
 *   SAVED -> PREPARING -> READY_FOR_REVIEW -> APPROVED -> OPENED_APPLY_PAGE / EMAIL_DRAFT_READY -> SUBMITTED / EMAIL_SENT
 *
 * Automation pipeline (orchestrator, see services/automation-orchestrator.service.ts):
 *   DISCOVERED -> MATCHING -> MATCHED -> (rules) REJECTED_BY_RULES | MATCHED (recommended) | AUTO_ELIGIBLE
 *   -> PREPARING -> READY_FOR_REVIEW (MANUAL mode) | WAITING_APPROVAL (REVIEW) | APPROVED by policy (AUTO)
 *                   | NEEDS_INFORMATION | MANUAL_ACTION_REQUIRED
 *   APPROVED -> APPLYING -> APPLIED | FAILED | MANUAL_ACTION_REQUIRED | NEEDS_INFORMATION
 *   APPLIED/SUBMITTED/EMAIL_SENT -> ASSESSMENT / INTERVIEW / OFFER / REJECTED
 *
 * Invariants enforced here (and relied on by the services):
 *  - SUBMITTED requires the user's "mark submitted by me" action; EMAIL_SENT requires the confirmed send endpoint.
 *  - APPLIED is reached only from APPLYING, i.e. through an executor holding the idempotency claim.
 *  - APPLYING is reached only from APPROVED (or a retry of FAILED / MANUAL_ACTION_REQUIRED), and APPROVED only by
 *    explicit user approval or by the AUTO policy right after preparation (the service checks every safety condition).
 *    The user may also approve a FAILED / MANUAL_ACTION_REQUIRED application whose content was never approved (or
 *    was edited after the approval), so the prepared content is reviewed before any retried submission.
 *  - Editing approved content returns it to review.
 *  - The manual tracker can never set APPROVED, APPLYING, APPLIED, SUBMITTED, EMAIL_SENT or AUTO_ELIGIBLE.
 */

export type ApplicationAction =
  | "prepare"
  | "preparation_succeeded"
  | "preparation_failed"
  | "edit"
  | "approve"
  | "open_apply_page"
  | "email_preview"
  | "email_sent"
  | "mark_submitted"
  | "track"
  // automation pipeline
  | "match_started"
  | "match_completed"
  | "evaluate"
  | "policy_approve"
  | "needs_information"
  | "information_provided"
  | "manual_action"
  | "execute_started"
  | "execute_succeeded"
  | "execute_failed"
  | "decline"
  | "status_update";

/** Statuses from which the user can decline an application that was not sent yet. */
const DECLINABLE: ApplicationStatus[] = [
  "SAVED",
  "DISCOVERED",
  "MATCHED",
  "REJECTED_BY_RULES",
  "AUTO_ELIGIBLE",
  "READY_FOR_REVIEW",
  "WAITING_APPROVAL",
  "NEEDS_INFORMATION",
  "APPROVED",
  "FAILED",
  "MANUAL_ACTION_REQUIRED",
];

/** Employer responses (email tracking / provider status sync / the user's own tracking). */
const AFTER_SENT: ApplicationStatus[] = ["ASSESSMENT", "INTERVIEW", "REJECTED", "OFFER"];

const TRANSITIONS: Record<ApplicationStatus, Partial<Record<ApplicationAction, ApplicationStatus[]>>> = {
  SAVED: { prepare: ["PREPARING"], track: ["WITHDRAWN", "EXPIRED"], decline: ["WITHDRAWN"] },
  // ---- automation pipeline before preparation
  DISCOVERED: {
    match_started: ["MATCHING"],
    match_completed: ["MATCHED"],
    prepare: ["PREPARING"],
    track: ["EXPIRED"],
    decline: ["WITHDRAWN"],
  },
  MATCHING: { match_completed: ["MATCHED"], track: ["EXPIRED"] },
  MATCHED: {
    evaluate: ["MATCHED", "REJECTED_BY_RULES", "AUTO_ELIGIBLE"],
    match_completed: ["MATCHED"],
    prepare: ["PREPARING"],
    track: ["EXPIRED"],
    decline: ["WITHDRAWN"],
  },
  REJECTED_BY_RULES: {
    // Re-evaluated when the profile, the rules or the job change.
    evaluate: ["REJECTED_BY_RULES", "MATCHED", "AUTO_ELIGIBLE"],
    match_completed: ["MATCHED"],
    // "Prepare anyway" - the user overrides the rules.
    prepare: ["PREPARING"],
    track: ["EXPIRED"],
    decline: ["WITHDRAWN"],
  },
  AUTO_ELIGIBLE: {
    evaluate: ["AUTO_ELIGIBLE", "MATCHED", "REJECTED_BY_RULES"],
    match_completed: ["MATCHED"],
    prepare: ["PREPARING"],
    track: ["EXPIRED"],
    decline: ["WITHDRAWN"],
  },
  PREPARING: {
    preparation_succeeded: ["READY_FOR_REVIEW", "WAITING_APPROVAL"],
    policy_approve: ["APPROVED"],
    needs_information: ["NEEDS_INFORMATION"],
    manual_action: ["MANUAL_ACTION_REQUIRED"],
    preparation_failed: ["SAVED", "MATCHED", "FAILED"],
    track: ["WITHDRAWN"],
  },
  NEEDS_INFORMATION: {
    information_provided: ["PREPARING"],
    prepare: ["PREPARING"],
    track: ["WITHDRAWN", "EXPIRED"],
    decline: ["WITHDRAWN"],
  },
  READY_FOR_REVIEW: {
    prepare: ["PREPARING"],
    edit: ["READY_FOR_REVIEW"],
    approve: ["APPROVED"],
    track: ["WITHDRAWN", "EXPIRED"],
    decline: ["WITHDRAWN"],
  },
  WAITING_APPROVAL: {
    prepare: ["PREPARING"],
    edit: ["WAITING_APPROVAL"],
    approve: ["APPROVED"],
    needs_information: ["NEEDS_INFORMATION"],
    manual_action: ["MANUAL_ACTION_REQUIRED"],
    track: ["WITHDRAWN", "EXPIRED"],
    decline: ["WITHDRAWN"],
  },
  APPROVED: {
    prepare: ["PREPARING"],
    edit: ["READY_FOR_REVIEW", "WAITING_APPROVAL"],
    open_apply_page: ["OPENED_APPLY_PAGE"],
    email_preview: ["EMAIL_DRAFT_READY"],
    mark_submitted: ["SUBMITTED"],
    execute_started: ["APPLYING"],
    manual_action: ["MANUAL_ACTION_REQUIRED"],
    needs_information: ["NEEDS_INFORMATION"],
    track: ["WITHDRAWN", "EXPIRED"],
    decline: ["WITHDRAWN"],
  },
  APPLYING: {
    execute_succeeded: ["APPLIED"],
    execute_failed: ["FAILED"],
    manual_action: ["MANUAL_ACTION_REQUIRED"],
    needs_information: ["NEEDS_INFORMATION"],
  },
  APPLIED: { status_update: AFTER_SENT, track: [...AFTER_SENT, "WITHDRAWN"] },
  FAILED: {
    // Retry (only when the failure was definitely before submission; see the execution service).
    execute_started: ["APPLYING"],
    // Review & approve the prepared content before a retry (a retry never submits unapproved content).
    approve: ["APPROVED"],
    prepare: ["PREPARING"],
    open_apply_page: ["OPENED_APPLY_PAGE"],
    // The user applied themselves after the failure.
    mark_submitted: ["SUBMITTED"],
    track: ["WITHDRAWN", "EXPIRED"],
    decline: ["WITHDRAWN"],
  },
  MANUAL_ACTION_REQUIRED: {
    // Manual handoff: the user applies on the official page (optionally with the extension's prefill).
    open_apply_page: ["OPENED_APPLY_PAGE"],
    mark_submitted: ["SUBMITTED"],
    // The user resolved the blocker (e.g. reconnected the provider) and asks the automation to retry.
    execute_started: ["APPLYING"],
    // Review & approve the prepared content first when it was never approved (e.g. handed off right after preparation).
    approve: ["APPROVED"],
    prepare: ["PREPARING"],
    track: ["WITHDRAWN", "EXPIRED"],
    decline: ["WITHDRAWN"],
  },
  OPENED_APPLY_PAGE: { open_apply_page: ["OPENED_APPLY_PAGE"], edit: ["READY_FOR_REVIEW"], mark_submitted: ["SUBMITTED"], track: ["WITHDRAWN", "EXPIRED"] },
  EMAIL_DRAFT_READY: {
    edit: ["READY_FOR_REVIEW"],
    email_preview: ["EMAIL_DRAFT_READY"],
    email_sent: ["EMAIL_SENT"],
    // Sent from the user's own email client.
    mark_submitted: ["SUBMITTED"],
    track: ["WITHDRAWN", "EXPIRED"],
  },
  EMAIL_SENT: { status_update: AFTER_SENT, track: [...AFTER_SENT, "WITHDRAWN"] },
  SUBMITTED: { status_update: AFTER_SENT, track: [...AFTER_SENT, "WITHDRAWN"] },
  ASSESSMENT: { status_update: ["INTERVIEW", "REJECTED", "OFFER"], track: ["INTERVIEW", "OFFER", "REJECTED", "WITHDRAWN"] },
  INTERVIEW: { status_update: ["ASSESSMENT", "OFFER", "REJECTED"], track: ["ASSESSMENT", "OFFER", "REJECTED", "WITHDRAWN"] },
  OFFER: { track: ["WITHDRAWN"] },
  REJECTED: { track: ["SAVED"] },
  WITHDRAWN: { track: ["SAVED"] },
  EXPIRED: { track: ["SAVED"] },
};

// Declining is available wherever the application was not sent yet.
for (const s of DECLINABLE) TRANSITIONS[s].decline ??= ["WITHDRAWN"];

export class InvalidTransitionError extends Error {
  constructor(from: ApplicationStatus, action: ApplicationAction, to?: ApplicationStatus) {
    super(`Cannot ${action.replace(/_/g, " ")} from status ${from}${to ? ` to ${to}` : ""}.`);
    this.name = "InvalidTransitionError";
  }
}

export function allowedTargets(from: ApplicationStatus, action: ApplicationAction): ApplicationStatus[] {
  return TRANSITIONS[from][action] ?? [];
}

export function canTransition(from: ApplicationStatus, action: ApplicationAction, to?: ApplicationStatus): boolean {
  const targets = allowedTargets(from, action);
  return to ? targets.includes(to) : targets.length > 0;
}

/** Actions whose target must always be given explicitly (several valid outcomes). */
const EXPLICIT_TARGET: ApplicationAction[] = ["track", "status_update", "evaluate"];

/** Resolve the next status or throw. For "track", "status_update" and "evaluate", `to` is required. */
export function nextStatus(from: ApplicationStatus, action: ApplicationAction, to?: ApplicationStatus): ApplicationStatus {
  const targets = allowedTargets(from, action);
  if (targets.length === 0) throw new InvalidTransitionError(from, action, to);
  if (to) {
    if (!targets.includes(to)) throw new InvalidTransitionError(from, action, to);
    return to;
  }
  if (EXPLICIT_TARGET.includes(action)) throw new InvalidTransitionError(from, action);
  return targets[0]!;
}

/** Statuses a user may pick directly from the tracker UI. */
export function manualTrackingOptions(from: ApplicationStatus): ApplicationStatus[] {
  return allowedTargets(from, "track");
}

/** Every action that can be taken from a status (used by tests and the UI). */
export function actionsFrom(from: ApplicationStatus): ApplicationAction[] {
  return Object.keys(TRANSITIONS[from]) as ApplicationAction[];
}
