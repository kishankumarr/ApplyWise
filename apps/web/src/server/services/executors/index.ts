import "server-only";
import type { JobProvider, ProviderEnv } from "@applywise/job-engine";
import type { ExecutorKind, ManualActionReason, ProviderInfo } from "@applywise/types";
import { findBrowserAdapter, browserExecutorProviders, type BrowserAdapter } from "./browser/adapters";
import { createBrowserExecutor } from "./browser/flow";
import { emailExecutor } from "./email";
import { manualExecutor } from "./manual";
import { isIdempotentApiProvider, providerApiExecutor } from "./provider-api";
import type { ApplicationExecutor, ExecutorSelection, ExecutorSelectionInput } from "./types";

export type { ApplicationExecutor, ExecutorContext, ExecutorLogger, ExecutorSelection, ExecutorSelectionInput } from "./types";

/**
 * Executor registry and selection.
 *
 * selectExecutor() is pure (no I/O): provider support x operator flags (BROWSER_EXECUTOR_*) x user settings x
 * connection status. It may be used anywhere to DESCRIBE what would happen; only applicationExecutionService.execute
 * may call an executor's execute() (it holds the idempotency claim, the daily-limit slot and the APPLYING state).
 */

function safeInfo(provider: JobProvider, env: ProviderEnv): ProviderInfo | null {
  try {
    return provider.info(env);
  } catch {
    return null;
  }
}

export function providerLabel(provider: JobProvider, env: ProviderEnv): string {
  return safeInfo(provider, env)?.label ?? provider.id;
}

const browserExecutors = new Map<string, ApplicationExecutor>();

function browserExecutorFor(adapter: BrowserAdapter): ApplicationExecutor {
  let executor = browserExecutors.get(adapter.id);
  if (!executor) {
    executor = createBrowserExecutor(adapter);
    browserExecutors.set(adapter.id, executor);
  }
  return executor;
}

/** Every kind of executor this server can run. */
export const executorRegistry = {
  manual: manualExecutor,
  email: emailExecutor,
  api: (provider: JobProvider, env: ProviderEnv): ApplicationExecutor => providerApiExecutor(provider, providerLabel(provider, env)),
  browser: browserExecutorFor,
};

/**
 * Static facts about a stored executor id (ApplicationExecution.executorId), used by crash recovery.
 * Unknown ids are never assumed idempotent.
 */
export function executorInfo(executorId: string): { kind: ExecutorKind; idempotentSubmission: boolean } {
  if (executorId === manualExecutor.id) return { kind: "MANUAL", idempotentSubmission: true };
  if (executorId === emailExecutor.id) return { kind: "API", idempotentSubmission: false };
  if (executorId.startsWith("api:")) return { kind: "API", idempotentSubmission: isIdempotentApiProvider(executorId.slice(4)) };
  if (executorId.startsWith("browser:")) return { kind: "BROWSER", idempotentSubmission: false };
  return { kind: "MANUAL", idempotentSubmission: false };
}

function manual(reason: ManualActionReason, detail: string): ExecutorSelection {
  return { automatic: false, executor: manualExecutor, reason, detail };
}

/** Which executor would submit this application, or why it has to be handed to the user. Pure. */
export function selectExecutor(input: ExecutorSelectionInput): ExecutorSelection {
  const { job, provider, env } = input;
  const label = providerLabel(provider, env);
  const support = provider.supportsApplication?.(job, env) ?? {
    supported: false,
    channel: "manual" as const,
    reason: "AUTOMATION_NOT_SUPPORTED" as const,
    detail: `${label} does not support automatic applications - apply on the official page.`,
  };
  if (!support.supported) {
    return manual(support.reason ?? "AUTOMATION_NOT_SUPPORTED", support.detail || `${label} does not support automatic applications - apply on the official page.`);
  }

  switch (support.channel) {
    case "api": {
      if (!provider.submitApplication) return manual("AUTOMATION_NOT_SUPPORTED", `${label} has no application API - apply on the official page.`);
      const info = safeInfo(provider, env);
      if (!info) return manual("AUTOMATION_NOT_SUPPORTED", `${label} is not available on this server right now.`);
      if (info.auth === "api_key" || info.auth === "oauth_token") {
        const status = input.connection?.status ?? null;
        if (status === "NEEDS_ATTENTION") return manual("LOGIN_REQUIRED", `Reconnect ${label} in Settings -> Job sources - the saved credential stopped working.`);
        if (status !== "CONNECTED") return manual("LOGIN_REQUIRED", `Connect ${label} in Settings -> Job sources`);
      }
      return { automatic: true, executor: executorRegistry.api(provider, env) };
    }
    case "email": {
      const missing: string[] = [];
      // AUTO_APPLY is LIMITED (manual only) when mail is only captured (dev outbox): an automatic "application" would
      // never reach the employer, yet be recorded as APPLIED and never be sent again.
      const info = safeInfo(provider, env);
      if (!info || info.manualOnly) missing.push("no email provider that delivers mail is configured on this server, so application emails would only be captured");
      if (!input.settings.allowEmailApplications) missing.push("turn on email applications in Settings -> Automation");
      if (!input.emailSendingConsent) missing.push("grant the email-sending consent in Settings -> Privacy");
      if (!input.userEmailVerified) missing.push("verify your account email address");
      if (!job.hrEmail) missing.push("the job has no HR email address");
      if (missing.length) return manual("AUTOMATION_NOT_SUPPORTED", `Automatic email applications are off for this job: ${missing.join("; ")}.`);
      return { automatic: true, executor: emailExecutor };
    }
    case "browser": {
      if (env.BROWSER_EXECUTOR_ENABLED !== "true") return manual("AUTOMATION_NOT_SUPPORTED", "Browser automation is disabled on this server");
      if (!browserExecutorProviders(env).includes(provider.id)) return manual("AUTOMATION_NOT_SUPPORTED", `Browser automation is not enabled for ${label} on this server`);
      const adapter = findBrowserAdapter(job.applyUrl, provider.id, env);
      if (!adapter) return manual("AUTOMATION_NOT_SUPPORTED", "No browser adapter supports this application page - apply on the official page.");
      return { automatic: true, executor: browserExecutorFor(adapter) };
    }
    default:
      return manual(support.reason ?? "AUTOMATION_NOT_SUPPORTED", support.detail || `${label} requires you to apply on the official page.`);
  }
}
