import type { CapabilityStatus, ProviderCapability, ProviderConnectionStatus, ProviderKind, ProviderSourceCard, SourceCardStatus } from "@applywise/types";

/** Display wording for the provider capability data returned by GET /api/automation/providers. */

export type BadgeTone = "success" | "info" | "warning" | "destructive" | "secondary" | "outline";

export const CARD_STATUS: Record<SourceCardStatus, { label: string; tone: BadgeTone }> = {
  CONNECTED: { label: "Connected", tone: "success" },
  WORKING: { label: "Working", tone: "success" },
  LIMITED: { label: "Limited", tone: "info" },
  NEEDS_AUTHENTICATION: { label: "Needs authentication", tone: "warning" },
  ERROR: { label: "Error", tone: "destructive" },
  MANUAL_ONLY: { label: "Manual only", tone: "secondary" },
  NOT_CONFIGURED: { label: "Not configured", tone: "outline" },
};

export const CAPABILITY_STATUS: Record<CapabilityStatus, { label: string; tone: BadgeTone; meaning: string }> = {
  AVAILABLE: { label: "Available", tone: "success", meaning: "Works with this server's current configuration." },
  SUPPORTED: { label: "Supported", tone: "success", meaning: "Automatic submission is implemented and switched on for this server." },
  LIMITED: { label: "Limited", tone: "info", meaning: "Works, but only partly - for example discovery only through job-alert emails." },
  EXPERIMENTAL: {
    label: "Experimental",
    tone: "warning",
    meaning: "Switched on by the operator but not validated against the live site; it hands over to you whenever something is unexpected.",
  },
  NOT_CONFIGURED: { label: "Not configured", tone: "warning", meaning: "Supported by ApplyWise, but the server operator has not added the required key or setting." },
  REQUIRES_EXTERNAL_CONFIGURATION: {
    label: "Needs external setup",
    tone: "warning",
    meaning: "Needs an agreement or credentials ApplyWise does not have (a partner API or the employer's own API key).",
  },
  MANUAL: { label: "Manual", tone: "secondary", meaning: "You complete this step yourself; ApplyWise prepares everything first." },
  EXTERNAL_LIMITATION: {
    label: "Not allowed by the provider",
    tone: "secondary",
    meaning: "The provider's terms or technical barriers (no public API, sign-in walls, anti-automation rules) prevent it.",
  },
  NOT_SUPPORTED: { label: "Not supported", tone: "outline", meaning: "This source does not offer this at all." },
};

/** Legend order: what works, then what is partial, then what the user or provider has to do. */
export const CAPABILITY_STATUS_ORDER: CapabilityStatus[] = [
  "AVAILABLE",
  "SUPPORTED",
  "LIMITED",
  "EXPERIMENTAL",
  "NOT_CONFIGURED",
  "REQUIRES_EXTERNAL_CONFIGURATION",
  "MANUAL",
  "EXTERNAL_LIMITATION",
  "NOT_SUPPORTED",
];

export const CAPABILITY_ROWS: { key: Exclude<ProviderCapability, "MANUAL_ONLY">; label: string; hint: string }[] = [
  { key: "DISCOVERY", label: "Discovery", hint: "finding new jobs" },
  { key: "DETAIL_FETCH", label: "Details", hint: "full job descriptions" },
  { key: "QUESTION_EXTRACTION", label: "Application questions", hint: "reading the form's questions" },
  { key: "AUTO_APPLY", label: "Application", hint: "automatic submission" },
  { key: "STATUS_TRACKING", label: "Status tracking", hint: "replies, interviews, outcomes" },
];

export const PROVIDER_KIND_LABELS: Record<ProviderKind, string> = {
  job_board: "Job board",
  ats: "Applicant tracking system",
  search_api: "Job search API",
  email_alerts: "Job-alert emails",
  career_site: "Company career sites",
  email_application: "Email applications",
  demo: "Demo provider",
};

export const CONNECTION_STATUS: Record<ProviderConnectionStatus | "NONE", { label: string; tone: BadgeTone }> = {
  CONNECTED: { label: "Connected", tone: "success" },
  NEEDS_AUTHENTICATION: { label: "Needs authentication", tone: "warning" },
  NEEDS_ATTENTION: { label: "Needs attention - reconnect", tone: "warning" },
  ERROR: { label: "Error", tone: "destructive" },
  DISCONNECTED: { label: "Not connected", tone: "outline" },
  NONE: { label: "Not connected", tone: "outline" },
};

/** Mirrors the provider registry: only these AUTO_APPLY statuses can ever submit an application. */
export function canSubmitAutomatically(card: ProviderSourceCard): boolean {
  const s = card.capabilities.AUTO_APPLY.status;
  return !card.manualOnly && (s === "SUPPORTED" || s === "EXPERIMENTAL");
}

export function needsAttention(card: ProviderSourceCard): boolean {
  if (card.cardStatus === "NEEDS_AUTHENTICATION" || card.cardStatus === "ERROR") return true;
  const c = card.connection?.status;
  return c === "NEEDS_AUTHENTICATION" || c === "NEEDS_ATTENTION" || c === "ERROR";
}

/** One sentence on what happens to an application for a job from this source. */
export function applicationSummary(card: ProviderSourceCard): string {
  const s = card.capabilities.AUTO_APPLY.status;
  if (card.kind === "email_alerts") return "Finds jobs only; each job is applied to through the source it points to.";
  if (card.kind === "email_application" && (s === "SUPPORTED" || s === "EXPERIMENTAL") && !card.manualOnly) {
    return "Can email your application to the HR address named in a job post in Review mode (after you approve) or Auto mode, when email applications are allowed in your automation settings. In Manual mode nothing is sent.";
  }
  if (s === "SUPPORTED" && !card.manualOnly) {
    return "Can submit applications for you in Review mode (after you approve) or Auto mode (with your consent). In Manual mode nothing is submitted.";
  }
  if (s === "EXPERIMENTAL" && !card.manualOnly) {
    return "Automatic submission is experimental on this server: it may hand over to you, and nothing is submitted in Manual mode.";
  }
  return "Never submitted automatically: ApplyWise prepares the application and hands it to you to submit (the browser extension can prefill the form).";
}
