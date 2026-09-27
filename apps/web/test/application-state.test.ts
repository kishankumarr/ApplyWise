import { describe, expect, it } from "vitest";
import { APPLICATION_STATUSES, type ApplicationStatus } from "@applywise/types";
import { actionsFrom, allowedTargets, canTransition, InvalidTransitionError, manualTrackingOptions, nextStatus, type ApplicationAction } from "@/server/domain/application-state";

const ACTIONS: ApplicationAction[] = [
  "prepare",
  "preparation_succeeded",
  "preparation_failed",
  "edit",
  "approve",
  "open_apply_page",
  "email_preview",
  "email_sent",
  "mark_submitted",
  "track",
  "match_started",
  "match_completed",
  "evaluate",
  "policy_approve",
  "needs_information",
  "information_provided",
  "manual_action",
  "execute_started",
  "execute_succeeded",
  "execute_failed",
  "decline",
  "status_update",
];

/** Every (from, action, to) edge of the state machine. */
function edges(): { from: ApplicationStatus; action: ApplicationAction; to: ApplicationStatus }[] {
  const out: { from: ApplicationStatus; action: ApplicationAction; to: ApplicationStatus }[] = [];
  for (const from of APPLICATION_STATUSES) for (const action of ACTIONS) for (const to of allowedTargets(from, action)) out.push({ from, action, to });
  return out;
}

describe("application state machine", () => {
  it("follows the happy paths", () => {
    let s: ApplicationStatus = "SAVED";
    s = nextStatus(s, "prepare");
    s = nextStatus(s, "preparation_succeeded");
    expect(s).toBe("READY_FOR_REVIEW");
    s = nextStatus(s, "approve");
    expect(nextStatus(s, "open_apply_page")).toBe("OPENED_APPLY_PAGE");
    expect(nextStatus("OPENED_APPLY_PAGE", "mark_submitted")).toBe("SUBMITTED");
    expect(nextStatus("APPROVED", "email_preview")).toBe("EMAIL_DRAFT_READY");
    expect(nextStatus("EMAIL_DRAFT_READY", "email_sent")).toBe("EMAIL_SENT");
  });

  it("cannot approve or submit without review", () => {
    expect(() => nextStatus("SAVED", "approve")).toThrow(InvalidTransitionError);
    expect(() => nextStatus("PREPARING", "approve")).toThrow(InvalidTransitionError);
    expect(() => nextStatus("SAVED", "mark_submitted")).toThrow(InvalidTransitionError);
    expect(() => nextStatus("READY_FOR_REVIEW", "mark_submitted")).toThrow(InvalidTransitionError);
    expect(() => nextStatus("READY_FOR_REVIEW", "email_sent")).toThrow(InvalidTransitionError);
    expect(() => nextStatus("APPROVED", "email_sent")).toThrow(InvalidTransitionError);
    expect(() => nextStatus("WAITING_APPROVAL", "mark_submitted")).toThrow(InvalidTransitionError);
    expect(() => nextStatus("WAITING_APPROVAL", "execute_started")).toThrow(InvalidTransitionError);
  });

  it("only reaches SUBMITTED via mark_submitted, EMAIL_SENT via email_sent and APPLIED via an executor", () => {
    for (const { action, to } of edges()) {
      if (to === "SUBMITTED") expect(action).toBe("mark_submitted");
      if (to === "EMAIL_SENT") expect(action).toBe("email_sent");
      if (to === "APPLIED") expect(action).toBe("execute_succeeded");
    }
    // The manual tracker can never set these directly.
    for (const from of APPLICATION_STATUSES) {
      const opts = manualTrackingOptions(from);
      for (const forbidden of ["SUBMITTED", "EMAIL_SENT", "APPROVED", "APPLYING", "APPLIED", "AUTO_ELIGIBLE", "WAITING_APPROVAL"] as ApplicationStatus[]) {
        expect(opts).not.toContain(forbidden);
      }
    }
  });

  it("reaches APPLIED only from APPLYING, and APPLYING only from APPROVED or an explicit retry", () => {
    const intoApplied = edges().filter((e) => e.to === "APPLIED");
    expect(intoApplied.map((e) => e.from)).toEqual(["APPLYING"]);
    const intoApplying = edges().filter((e) => e.to === "APPLYING");
    expect(new Set(intoApplying.map((e) => e.action))).toEqual(new Set(["execute_started"]));
    expect(intoApplying.map((e) => e.from).sort()).toEqual(["APPROVED", "FAILED", "MANUAL_ACTION_REQUIRED"]);
  });

  it("reaches APPROVED only by explicit approval or the AUTO policy right after preparation", () => {
    const intoApproved = edges().filter((e) => e.to === "APPROVED");
    for (const e of intoApproved) {
      if (e.action === "approve") expect(["READY_FOR_REVIEW", "WAITING_APPROVAL", "FAILED", "MANUAL_ACTION_REQUIRED"]).toContain(e.from);
      else expect(e).toMatchObject({ from: "PREPARING", action: "policy_approve" });
    }
    // The policy never approves anything but a fresh preparation, and nothing is approved while it is being prepared,
    // waiting for answers, being submitted or after it was sent.
    expect(edges().filter((e) => e.action === "policy_approve").map((e) => e.from)).toEqual(["PREPARING"]);
    for (const s of ["PREPARING", "NEEDS_INFORMATION", "APPLYING", "APPLIED", "SUBMITTED", "EMAIL_SENT", "OPENED_APPLY_PAGE", "EMAIL_DRAFT_READY"] as ApplicationStatus[]) {
      expect(canTransition(s, "approve"), s).toBe(false);
    }
  });

  it("lets the user review & approve a handed-off or failed application before the automation retries it", () => {
    // A retry must never submit content that was not approved: FAILED / MANUAL_ACTION_REQUIRED can be approved explicitly.
    expect(nextStatus("MANUAL_ACTION_REQUIRED", "approve")).toBe("APPROVED");
    expect(nextStatus("FAILED", "approve")).toBe("APPROVED");
    // ...and approval is the only way besides the explicit retry (execute_started) to leave them towards submission.
    for (const s of ["MANUAL_ACTION_REQUIRED", "FAILED"] as ApplicationStatus[]) {
      const towardsSubmission = edges().filter((e) => e.from === s && (e.to === "APPROVED" || e.to === "APPLYING"));
      expect(new Set(towardsSubmission.map((e) => e.action))).toEqual(new Set(["approve", "execute_started"]));
    }
  });

  it("editing approved content requires re-approval", () => {
    expect(nextStatus("APPROVED", "edit")).toBe("READY_FOR_REVIEW");
    expect(nextStatus("APPROVED", "edit", "WAITING_APPROVAL")).toBe("WAITING_APPROVAL");
    expect(nextStatus("EMAIL_DRAFT_READY", "edit")).toBe("READY_FOR_REVIEW");
    expect(() => nextStatus("APPLYING", "edit")).toThrow(InvalidTransitionError);
    // Content that is being or was sent can never be edited back into review.
    for (const s of ["APPLYING", "APPLIED", "SUBMITTED", "EMAIL_SENT"] as ApplicationStatus[]) expect(canTransition(s, "edit"), s).toBe(false);
  });

  it("validates manual tracking targets", () => {
    expect(nextStatus("SUBMITTED", "track", "INTERVIEW")).toBe("INTERVIEW");
    expect(canTransition("SUBMITTED", "track", "OFFER")).toBe(true);
    expect(canTransition("APPLIED", "track", "ASSESSMENT")).toBe(true);
    expect(() => nextStatus("SAVED", "track", "OFFER")).toThrow(InvalidTransitionError);
    expect(() => nextStatus("SUBMITTED", "track")).toThrow(InvalidTransitionError);
  });

  it("walks the automation pipeline: discovered -> matched -> rules -> prepared -> approved -> applied -> interview", () => {
    let s: ApplicationStatus = "DISCOVERED";
    s = nextStatus(s, "match_started");
    expect(s).toBe("MATCHING");
    s = nextStatus(s, "match_completed");
    expect(s).toBe("MATCHED");
    s = nextStatus(s, "evaluate", "AUTO_ELIGIBLE");
    s = nextStatus(s, "prepare");
    expect(s).toBe("PREPARING");
    s = nextStatus(s, "policy_approve");
    expect(s).toBe("APPROVED");
    s = nextStatus(s, "execute_started");
    expect(s).toBe("APPLYING");
    s = nextStatus(s, "execute_succeeded");
    expect(s).toBe("APPLIED");
    expect(nextStatus(s, "status_update", "ASSESSMENT")).toBe("ASSESSMENT");
    expect(nextStatus("ASSESSMENT", "status_update", "INTERVIEW")).toBe("INTERVIEW");
    expect(nextStatus("INTERVIEW", "status_update", "OFFER")).toBe("OFFER");
  });

  it("routes review, missing information and manual handoff", () => {
    expect(nextStatus("PREPARING", "preparation_succeeded", "WAITING_APPROVAL")).toBe("WAITING_APPROVAL");
    expect(nextStatus("WAITING_APPROVAL", "approve")).toBe("APPROVED");
    expect(nextStatus("PREPARING", "needs_information")).toBe("NEEDS_INFORMATION");
    expect(nextStatus("NEEDS_INFORMATION", "information_provided")).toBe("PREPARING");
    expect(nextStatus("PREPARING", "manual_action")).toBe("MANUAL_ACTION_REQUIRED");
    expect(nextStatus("APPLYING", "manual_action")).toBe("MANUAL_ACTION_REQUIRED");
    expect(nextStatus("APPLYING", "needs_information")).toBe("NEEDS_INFORMATION");
    expect(nextStatus("APPLYING", "execute_failed")).toBe("FAILED");
    // After a manual handoff the user applies on the official page.
    expect(nextStatus("MANUAL_ACTION_REQUIRED", "open_apply_page")).toBe("OPENED_APPLY_PAGE");
    expect(nextStatus("MANUAL_ACTION_REQUIRED", "mark_submitted")).toBe("SUBMITTED");
    // Rules may be re-evaluated before preparation, never after.
    expect(canTransition("REJECTED_BY_RULES", "evaluate", "AUTO_ELIGIBLE")).toBe(true);
    expect(canTransition("WAITING_APPROVAL", "evaluate")).toBe(false);
    expect(canTransition("APPLIED", "evaluate")).toBe(false);
  });

  it("requires an explicit target for evaluate and status_update", () => {
    expect(() => nextStatus("MATCHED", "evaluate")).toThrow(InvalidTransitionError);
    expect(() => nextStatus("APPLIED", "status_update")).toThrow(InvalidTransitionError);
    expect(() => nextStatus("APPLIED", "status_update", "WITHDRAWN")).toThrow(InvalidTransitionError);
  });

  it("lets the user decline anything not yet sent, and nothing that was sent", () => {
    for (const s of ["MATCHED", "AUTO_ELIGIBLE", "WAITING_APPROVAL", "NEEDS_INFORMATION", "MANUAL_ACTION_REQUIRED", "FAILED", "APPROVED"] as ApplicationStatus[]) {
      expect(nextStatus(s, "decline")).toBe("WITHDRAWN");
    }
    for (const s of ["APPLYING", "APPLIED", "SUBMITTED", "EMAIL_SENT", "INTERVIEW", "OFFER"] as ApplicationStatus[]) {
      expect(canTransition(s, "decline")).toBe(false);
    }
  });

  it("defines at least one way out of every non-terminal status", () => {
    for (const s of APPLICATION_STATUSES) expect(actionsFrom(s).length).toBeGreaterThan(0);
  });
});
