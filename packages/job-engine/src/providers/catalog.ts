import type {
  CapabilityStatus,
  JobPlatform,
  ProviderAuthMode,
  ProviderCapabilityInfo,
  ProviderInfo,
  ProviderKind,
} from "@applywise/types";
import { SEARCH_PROVIDERS } from "../feeds/search";
import type { ProviderEnv } from "./types";

/**
 * Static provider catalogue + environment-resolved capability metadata.
 *
 * Statuses follow the capability matrix in docs/AUTOMATION_ARCHITECTURE.md and never overstate: a capability is
 * SUPPORTED only when automatic submission is implemented and enabled on this server (the demo provider, and
 * email applications with a delivering email provider), EXPERIMENTAL only behind the operator's browser-executor
 * opt-in, and everything a platform's terms or missing APIs prevent is reported as such.
 */

export const JOB_PROVIDER_IDS = [
  "linkedin",
  "indeed",
  "naukri",
  "foundit",
  "wellfound",
  "instahyre",
  "glassdoor",
  "cutshort",
  "hirist",
  "greenhouse",
  "lever",
  "ashby",
  "workday",
  "smartrecruiters",
  "workable",
  "recruitee",
  "career_site",
  "adzuna",
  "himalayas",
  "jobicy",
  "themuse",
  "job_alert_email",
  "email_application",
  "demo",
] as const;
export type JobProviderId = (typeof JOB_PROVIDER_IDS)[number];

const PROVIDER_ID_SET = new Set<string>(JOB_PROVIDER_IDS);

export function isJobProviderId(value: unknown): value is JobProviderId {
  return typeof value === "string" && PROVIDER_ID_SET.has(value);
}

/** Job boards whose only compliant channels are job-alert emails and user-initiated imports. */
export const JOB_BOARD_PROVIDER_IDS = ["linkedin", "indeed", "naukri", "foundit", "wellfound", "instahyre", "glassdoor", "cutshort", "hirist"] as const;
/** ATS boards the experimental browser executor may be enabled for. */
export const BROWSER_ATS_PROVIDER_IDS = ["greenhouse", "lever", "ashby"] as const;
/** ATS boards with public job-board APIs but no candidate-side submission. */
export const HANDOFF_ATS_PROVIDER_IDS = ["smartrecruiters", "workable", "recruitee"] as const;
export const SEARCH_API_PROVIDER_IDS = ["adzuna", "himalayas", "jobicy", "themuse"] as const;

// ---------------------------------------------------------------- environment

/**
 * The demo provider (DEMO CONTENT) is available outside production, or when the operator enables it explicitly
 * (DEMO_PROVIDER_ENABLED=true). DEMO_PROVIDER_ENABLED=false always disables it.
 */
export function isDemoProviderEnabled(env: ProviderEnv): boolean {
  const flag = env.DEMO_PROVIDER_ENABLED;
  return flag === "true" || (flag !== "false" && env.NODE_ENV !== "production");
}

/** Provider ids listed in BROWSER_EXECUTOR_PROVIDERS (comma list, case-insensitive). */
export function browserExecutorProviderIds(env: ProviderEnv): string[] {
  return (env.BROWSER_EXECUTOR_PROVIDERS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** True when the operator opted this provider into the (experimental) browser executor. */
export function browserExecutorEnabledFor(providerId: string, env: ProviderEnv): boolean {
  return env.BROWSER_EXECUTOR_ENABLED === "true" && browserExecutorProviderIds(env).includes(providerId);
}

export type EmailApplicationDelivery = "smtp" | "resend" | "dev_outbox";

/**
 * How application emails would leave this server. Mirrors packages/email createEmailAdapter: smtp needs
 * SMTP_HOST and resend needs RESEND_API_KEY, otherwise the dev outbox (never delivers) is used.
 */
export function emailApplicationDelivery(env: ProviderEnv): EmailApplicationDelivery {
  const provider = (env.EMAIL_PROVIDER ?? "dev").trim().toLowerCase();
  if (provider === "smtp" && env.SMTP_HOST) return "smtp";
  if (provider === "resend" && env.RESEND_API_KEY) return "resend";
  return "dev_outbox";
}

// ---------------------------------------------------------------- helpers

type CapabilityMap = ProviderInfo["capabilities"];

function cap(status: CapabilityStatus, via: string | null, note: string): ProviderCapabilityInfo {
  return { status, via, note };
}

/**
 * Employer emails (confirmations, assessments, interviews, rejections, offers) update applications only when they
 * reach the user's private forwarding address. Connected Gmail / Outlook / IMAP mailboxes download known job-alert
 * senders only, so they never track employer emails.
 */
const FORWARDED_STATUS_NOTE =
  "Forward confirmations and recruiter replies to your private ApplyWise forwarding address to update your applications. Connected mailboxes (Gmail, Outlook, IMAP) only read job-alert senders, so employer emails in them are not tracked.";

const STATUS_BY_EMAIL = (label: string) =>
  cap("LIMITED", "employer emails you forward to your private address", `${label} has no application-status API. ${FORWARDED_STATUS_NOTE}`);

const EXTENSION_IMPORT = (label: string) =>
  cap("MANUAL", "ApplyWise browser extension (you open the page)", `ApplyWise never fetches ${label} pages: import a job you have open with the extension, or paste its description.`);

function autoApplyAllowsSubmission(status: CapabilityStatus): boolean {
  return status === "SUPPORTED" || status === "EXPERIMENTAL";
}

interface ResolvedProvider {
  capabilities: CapabilityMap;
  externalRequirements: string[];
  notes: string[];
}

interface ProviderDefinition {
  id: JobProviderId;
  label: string;
  kind: ProviderKind;
  platforms: JobPlatform[];
  auth: ProviderAuthMode;
  resolve(env: ProviderEnv): ResolvedProvider;
}

// ---------------------------------------------------------------- job boards (alerts only)

const JOB_BOARDS: { id: (typeof JOB_BOARD_PROVIDER_IDS)[number]; label: string; platform: JobPlatform; applyNote: string; requirement: string }[] = [
  {
    id: "linkedin",
    label: "LinkedIn",
    platform: "LINKEDIN",
    applyNote: "LinkedIn has no public job or apply API and its User Agreement prohibits automated activity, so applications are always handed to you.",
    requirement: "LinkedIn's application APIs are limited to approved ATS partners; none is available to candidate-side tools.",
  },
  {
    id: "indeed",
    label: "Indeed",
    platform: "INDEED",
    applyNote: "Indeed Apply is available to approved partners only, so applications are handed to you.",
    requirement: "An Indeed publisher/partner agreement (Indeed Apply is partner-only).",
  },
  {
    id: "naukri",
    label: "Naukri",
    platform: "NAUKRI",
    applyNote: "Naukri applications are login-walled and need a partner agreement, so applications are handed to you.",
    requirement: "An approved Naukri partner/API agreement.",
  },
  {
    id: "foundit",
    label: "Foundit",
    platform: "FOUNDIT",
    applyNote: "Foundit has no candidate-side application API, so applications are handed to you.",
    requirement: "A candidate-side application API from Foundit (none is published).",
  },
  {
    id: "wellfound",
    label: "Wellfound",
    platform: "WELLFOUND",
    applyNote: "Wellfound has no candidate-side application API, so applications are handed to you.",
    requirement: "A candidate-side application API from Wellfound (none is published).",
  },
  {
    id: "instahyre",
    label: "Instahyre",
    platform: "INSTAHYRE",
    applyNote: "Instahyre has no candidate-side application API, so applications are handed to you.",
    requirement: "An approved Instahyre partner API (none is configured).",
  },
  {
    id: "glassdoor",
    label: "Glassdoor",
    platform: "GLASSDOOR",
    applyNote: "Glassdoor has no candidate-side application API, so applications are handed to you.",
    requirement: "A candidate-side application API from Glassdoor (none is published).",
  },
  {
    id: "cutshort",
    label: "Cutshort",
    platform: "CUTSHORT",
    applyNote: "Cutshort has no candidate-side application API, so applications are handed to you.",
    requirement: "A candidate-side application API from Cutshort (none is published).",
  },
  {
    id: "hirist",
    label: "Hirist",
    platform: "HIRIST",
    applyNote: "Hirist has no candidate-side application API, so applications are handed to you.",
    requirement: "A candidate-side application API from Hirist (none is published).",
  },
];

const jobBoardDefinitions: ProviderDefinition[] = JOB_BOARDS.map((b) => ({
  id: b.id,
  label: b.label,
  kind: "job_board",
  platforms: [b.platform],
  auth: "not_supported",
  resolve: () => ({
    capabilities: {
      DISCOVERY: cap(
        "LIMITED",
        "job-alert emails",
        `${b.label} jobs arrive through the ${b.label} job-alert emails you receive (connected mailbox or forwarding). ${b.label} itself is never scraped.`,
      ),
      DETAIL_FETCH: EXTENSION_IMPORT(b.label),
      QUESTION_EXTRACTION: cap("EXTERNAL_LIMITATION", null, `No public ${b.label} API exposes application questions.`),
      AUTO_APPLY: cap("EXTERNAL_LIMITATION", "manual handoff", b.applyNote),
      STATUS_TRACKING: STATUS_BY_EMAIL(b.label),
    },
    externalRequirements: [`Turn on ${b.label} job alerts and connect your mailbox (or forward the alerts) to discover jobs.`, b.requirement],
    notes: [`ApplyWise never asks for or stores your ${b.label} password or cookies.`],
  }),
}));

// ---------------------------------------------------------------- ATS boards

const ATS_LABELS: Record<(typeof BROWSER_ATS_PROVIDER_IDS)[number] | (typeof HANDOFF_ATS_PROVIDER_IDS)[number], { label: string; platform: JobPlatform }> = {
  greenhouse: { label: "Greenhouse", platform: "GREENHOUSE" },
  lever: { label: "Lever", platform: "LEVER" },
  ashby: { label: "Ashby", platform: "ASHBY" },
  smartrecruiters: { label: "SmartRecruiters", platform: "SMARTRECRUITERS" },
  workable: { label: "Workable", platform: "WORKABLE" },
  recruitee: { label: "Recruitee", platform: "RECRUITEE" },
};

const boardDiscovery = (label: string) =>
  cap("AVAILABLE", "public job-board API", `Follow a company's ${label} board under Automatic sources; jobs come from ${label}'s official public job-board API.`);
const boardDetails = (label: string) => cap("AVAILABLE", "public job-board API", `Full job descriptions come from ${label}'s public job-board API.`);

const browserAtsDefinitions: ProviderDefinition[] = BROWSER_ATS_PROVIDER_IDS.map((id) => {
  const { label, platform } = ATS_LABELS[id];
  return {
    id,
    label,
    kind: "ats",
    platforms: [platform],
    auth: "none",
    resolve: (env) => {
      const enabled = browserExecutorEnabledFor(id, env);
      const apiRequirement = `${label}'s official application API needs the employer's API key, which is not available to candidates.`;
      return {
        capabilities: {
          DISCOVERY: boardDiscovery(label),
          DETAIL_FETCH: boardDetails(label),
          QUESTION_EXTRACTION:
            id === "greenhouse"
              ? cap("AVAILABLE", "Job Board API (questions=true)", "Application questions are read from Greenhouse's official public Job Board API.")
              : cap("NOT_SUPPORTED", null, `${label}'s public postings API does not publish the application form's questions.`),
          AUTO_APPLY: enabled
            ? cap(
                "EXPERIMENTAL",
                "headless browser (worker)",
                `Operator opt-in, not validated against the live ${label} site. It stops on CAPTCHA, MFA, login walls and unknown required questions and hands the application to you.`,
              )
            : cap(
                "REQUIRES_EXTERNAL_CONFIGURATION",
                "manual handoff",
                `${apiRequirement} The experimental browser executor is not enabled for ${label} on this server, so applications are handed to you.`,
              ),
          STATUS_TRACKING: STATUS_BY_EMAIL(label),
        },
        externalRequirements: enabled
          ? [apiRequirement]
          : [`BROWSER_EXECUTOR_ENABLED=true and "${id}" in BROWSER_EXECUTOR_PROVIDERS (experimental, operator opt-in).`, apiRequirement],
        notes: enabled ? [`Experimental: ${label} automation runs in a headless browser inside the worker and never bypasses CAPTCHA or MFA.`] : [],
      };
    },
  };
});

const handoffAtsDefinitions: ProviderDefinition[] = HANDOFF_ATS_PROVIDER_IDS.map((id) => {
  const { label, platform } = ATS_LABELS[id];
  return {
    id,
    label,
    kind: "ats",
    platforms: [platform],
    auth: "none",
    resolve: () => ({
      capabilities: {
        DISCOVERY: boardDiscovery(label),
        DETAIL_FETCH: boardDetails(label),
        QUESTION_EXTRACTION: cap("NOT_SUPPORTED", null, `${label}'s public job-board API does not publish application questions.`),
        AUTO_APPLY: cap("REQUIRES_EXTERNAL_CONFIGURATION", "manual handoff", `Submitting through ${label} needs the employer's API credentials, so applications are handed to you.`),
        STATUS_TRACKING: STATUS_BY_EMAIL(label),
      },
      externalRequirements: [`The employer's ${label} API credentials for submissions (not available to candidates).`],
      notes: [],
    }),
  };
});

const workdayDefinition: ProviderDefinition = {
  id: "workday",
  label: "Workday",
  kind: "ats",
  platforms: ["WORKDAY"],
  auth: "not_supported",
  resolve: () => ({
    capabilities: {
      DISCOVERY: cap(
        "NOT_SUPPORTED",
        null,
        "Workday career sites have no public job feed. Use the company's job alerts, or import a job you have open with the extension.",
      ),
      DETAIL_FETCH: EXTENSION_IMPORT("Workday"),
      QUESTION_EXTRACTION: cap("EXTERNAL_LIMITATION", null, "Workday application forms are behind per-employer candidate accounts."),
      AUTO_APPLY: cap(
        "EXTERNAL_LIMITATION",
        "manual handoff",
        "Each employer runs its own Workday tenant with separate candidate accounts and no public apply API, so applications are handed to you.",
      ),
      STATUS_TRACKING: STATUS_BY_EMAIL("Workday"),
    },
    externalRequirements: ["A candidate account on each employer's Workday site (ApplyWise never stores those passwords)."],
    notes: [],
  }),
};

// ---------------------------------------------------------------- career sites, search APIs, email

const careerSiteDefinition: ProviderDefinition = {
  id: "career_site",
  label: "Company career sites",
  kind: "career_site",
  platforms: ["COMPANY_CAREER_PAGE", "OTHER"],
  auth: "none",
  resolve: () => ({
    capabilities: {
      DISCOVERY: cap(
        "LIMITED",
        "URL import and browser extension",
        "Add a job by its career-page URL plus the description, or import the page you are viewing with the extension. Career sites are never crawled.",
      ),
      DETAIL_FETCH: EXTENSION_IMPORT("career-site"),
      QUESTION_EXTRACTION: cap("NOT_SUPPORTED", null, "Every career site has its own form; its questions are not read automatically."),
      AUTO_APPLY: cap("MANUAL", "manual handoff", "ApplyWise prepares the application (resume, cover letter, answers) and you submit it on the company's site."),
      STATUS_TRACKING: STATUS_BY_EMAIL("A career site"),
    },
    externalRequirements: [],
    notes: [],
  }),
};

const searchDefinitions: ProviderDefinition[] = SEARCH_API_PROVIDER_IDS.map((id) => {
  const adapter = SEARCH_PROVIDERS.find((p) => p.id === id);
  if (!adapter) throw new Error(`Search provider "${id}" is missing from SEARCH_PROVIDERS`);
  return {
    id,
    label: adapter.label,
    kind: "search_api",
    platforms: ["JOB_SEARCH_API"],
    auth: "none",
    resolve: (env) => {
      const available = adapter.isAvailable(env);
      const keyNote = adapter.requiredEnv.length
        ? `Set ${adapter.requiredEnv.join(" and ")} to enable ${adapter.label}.`
        : `${adapter.label} is not available on this server.`;
      return {
        capabilities: {
          DISCOVERY: available
            ? cap("AVAILABLE", `${adapter.label} search API`, `Saved searches query ${adapter.label}'s job-search API with your roles and locations.`)
            : cap("NOT_CONFIGURED", `${adapter.label} search API`, keyNote),
          DETAIL_FETCH: !available
            ? cap("NOT_CONFIGURED", null, keyNote)
            : adapter.descriptionLevel === "FULL"
              ? cap("AVAILABLE", "search results", "Search results include the full job description.")
              : cap("LIMITED", "search results", `${adapter.label} returns short description snippets; import the full description with the extension if you need it.`),
          QUESTION_EXTRACTION: cap("NOT_SUPPORTED", null, `${adapter.label} does not publish application questions.`),
          AUTO_APPLY: cap("MANUAL", "provider's apply page", `Apply links go to ${adapter.label}'s page as its terms require; ApplyWise prepares the application and you submit it.`),
          STATUS_TRACKING: STATUS_BY_EMAIL(adapter.label),
        },
        externalRequirements:
          !available && adapter.requiredEnv.length > 0
            ? [`${adapter.requiredEnv.join(" + ")} (operator key${adapter.signupUrl ? ` from ${adapter.signupUrl}` : ""}).`]
            : [],
        notes: [`Jobs are shown with the attribution "${adapter.attribution.text}".`],
      };
    },
  };
});

const ALERT_PLATFORMS: JobPlatform[] = ["LINKEDIN", "INDEED", "NAUKRI", "FOUNDIT", "INSTAHYRE", "CUTSHORT", "WELLFOUND", "GLASSDOOR", "HIRIST"];

const jobAlertEmailDefinition: ProviderDefinition = {
  id: "job_alert_email",
  label: "Job-alert emails",
  kind: "email_alerts",
  platforms: ALERT_PLATFORMS,
  auth: "none",
  resolve: () => ({
    capabilities: {
      DISCOVERY: cap(
        "AVAILABLE",
        "Gmail, Outlook, IMAP (app password) or forwarding",
        "Job-alert emails from known senders in your mailbox are parsed read-only; links in them are never fetched.",
      ),
      DETAIL_FETCH: cap("LIMITED", "alert summary", "Alerts carry a short summary of each job; import the full description with the extension if you need it."),
      QUESTION_EXTRACTION: cap("NOT_SUPPORTED", null, "Alert emails do not contain application questions."),
      AUTO_APPLY: cap("NOT_SUPPORTED", null, "Alerts are a discovery channel: applications go through the platform named in the alert."),
      STATUS_TRACKING: cap("LIMITED", "employer emails you forward to your private address", FORWARDED_STATUS_NOTE),
    },
    externalRequirements: ["Connect a mailbox (Gmail, Outlook or IMAP with an app password) or forward alerts to your private address."],
    notes: ["Only emails from known job-alert senders are read; nothing is ever sent from your mailbox."],
  }),
};

const emailApplicationDefinition: ProviderDefinition = {
  id: "email_application",
  label: "Email applications (HR address)",
  kind: "email_application",
  platforms: [],
  auth: "none",
  resolve: (env) => {
    const delivery = emailApplicationDelivery(env);
    const autoApply =
      delivery === "dev_outbox"
        ? cap(
            "LIMITED",
            "dev outbox",
            "Dev outbox only: application emails are written to the local outbox and nothing is delivered to employers. Configure an email provider to send them.",
          )
        : cap(
            "SUPPORTED",
            delivery === "smtp" ? "SMTP" : "Resend",
            "Applications to an HR address in the job post are sent with the existing email path, only when you allow email applications and granted the email-sending consent.",
          );
    const notes = ["Only jobs that name an HR/hiring email address can be applied to this way."];
    if (delivery === "smtp" && env.SMTP_DELIVERS_EXTERNALLY !== "true") {
      notes.push("SMTP_DELIVERS_EXTERNALLY is not true: if this SMTP server only captures mail (Mailpit, Mailtrap), employers will not receive the applications.");
    }
    return {
      capabilities: {
        DISCOVERY: cap("NOT_SUPPORTED", null, "Not a job source: it applies to HR addresses found in job posts."),
        DETAIL_FETCH: cap("NOT_SUPPORTED", null, "Not a job source."),
        QUESTION_EXTRACTION: cap("NOT_SUPPORTED", null, "Email applications have no application form."),
        AUTO_APPLY: autoApply,
        STATUS_TRACKING: cap("LIMITED", "replies you forward to your private address", `Employer replies are tracked only when they reach ApplyWise. ${FORWARDED_STATUS_NOTE}`),
      },
      externalRequirements:
        delivery === "dev_outbox" ? ["EMAIL_PROVIDER=smtp with SMTP_HOST, or EMAIL_PROVIDER=resend with RESEND_API_KEY (operator)."] : [],
      notes,
    };
  },
};

const demoDefinition: ProviderDefinition = {
  id: "demo",
  label: "Demo provider (fictional jobs)",
  kind: "demo",
  platforms: [],
  auth: "api_key",
  resolve: (env) => {
    const notes = [
      "DEMO CONTENT: fictional companies and jobs that exercise the whole pipeline; nothing leaves this server.",
      'Connect it with any token starting with "demo-" (for example demo-token); "demo-expired" simulates an expired connection.',
    ];
    if (!isDemoProviderEnabled(env)) {
      const off = "The demo provider is disabled on this server.";
      return {
        capabilities: {
          DISCOVERY: cap("NOT_CONFIGURED", null, off),
          DETAIL_FETCH: cap("NOT_CONFIGURED", null, off),
          QUESTION_EXTRACTION: cap("NOT_CONFIGURED", null, off),
          AUTO_APPLY: cap("NOT_CONFIGURED", null, off),
          STATUS_TRACKING: cap("NOT_CONFIGURED", null, off),
        },
        externalRequirements: ["DEMO_PROVIDER_ENABLED=true (the demo provider is off in production unless enabled explicitly)."],
        notes,
      };
    }
    return {
      capabilities: {
        DISCOVERY: cap("AVAILABLE", "simulated provider (DEMO CONTENT)", "110+ fictional jobs across simulated LinkedIn, Naukri, Indeed, Wellfound, Greenhouse, Lever and career-site sources, including cross-provider duplicates."),
        DETAIL_FETCH: cap("AVAILABLE", "simulated provider (DEMO CONTENT)", "Full fictional descriptions."),
        QUESTION_EXTRACTION: cap("AVAILABLE", "simulated application form", "Every demo job asks a few required screening questions."),
        AUTO_APPLY: cap(
          "SUPPORTED",
          "simulated API (demo ATS pages for the browser executor)",
          "Scripted outcomes: success, retryable and permanent failures, CAPTCHA/login/MFA hand-offs, unknown questions and platform restrictions.",
        ),
        STATUS_TRACKING: cap("AVAILABLE", "simulated status API", "Simulated recruiter emails for assessments, interviews, rejections and offers."),
      },
      externalRequirements: [],
      notes,
    };
  },
};

const DEFINITIONS: ProviderDefinition[] = [
  ...jobBoardDefinitions,
  ...browserAtsDefinitions,
  workdayDefinition,
  ...handoffAtsDefinitions,
  careerSiteDefinition,
  ...searchDefinitions,
  jobAlertEmailDefinition,
  emailApplicationDefinition,
  demoDefinition,
];

const DEFINITION_BY_ID = new Map<string, ProviderDefinition>(DEFINITIONS.map((d) => [d.id, d]));

/** Display label of a provider id ("linkedin" -> "LinkedIn"); unknown ids are returned unchanged. */
export function providerLabel(id: string): string {
  return DEFINITION_BY_ID.get(id)?.label ?? id;
}

/** Environment-resolved description of one provider (safe to send to the browser). */
export function resolveProviderInfo(id: JobProviderId, env: ProviderEnv): ProviderInfo {
  const def = DEFINITION_BY_ID.get(id);
  if (!def) throw new Error(`Unknown job provider "${id}"`);
  const resolved = def.resolve(env);
  return {
    id: def.id,
    label: def.label,
    kind: def.kind,
    platforms: [...def.platforms],
    auth: def.auth,
    capabilities: resolved.capabilities,
    manualOnly: !autoApplyAllowsSubmission(resolved.capabilities.AUTO_APPLY.status),
    externalRequirements: resolved.externalRequirements,
    notes: resolved.notes,
    demo: def.kind === "demo",
  };
}
