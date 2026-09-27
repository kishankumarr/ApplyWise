import type { ManualActionReason } from "@applywise/types";
import type { SubmissionResult } from "@applywise/job-engine";
import type { ApplicationExecutor } from "./types";

/**
 * MANUAL executor: performs no submission. The execution service turns its result into the manual handoff
 * (MANUAL_ACTION_REQUIRED + the handoff package: official apply URL, approved documents, verified answers).
 */
export const manualExecutor: ApplicationExecutor = {
  kind: "MANUAL",
  id: "manual",
  label: "Manual handoff",
  // Nothing is ever sent, so re-running it can never submit twice.
  idempotentSubmission: true,
  async execute(): Promise<SubmissionResult> {
    return manualResult("AUTOMATION_NOT_SUPPORTED", "Automatic submission is not available for this job - apply on the official page.");
  },
};

export function manualResult(reason: ManualActionReason, detail: string): SubmissionResult {
  return { outcome: "MANUAL_ACTION_REQUIRED", reason, detail };
}
