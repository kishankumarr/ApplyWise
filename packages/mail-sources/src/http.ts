import { MailTransientError } from "./errors";

/** Every outbound HTTP call is bounded so a slow provider cannot hang a request or worker. */
export const HTTP_TIMEOUT_MS = 20_000;

export interface JsonResponse {
  status: number;
  ok: boolean;
  data: Record<string, unknown>;
  retryAfterSec: number | null;
}

/**
 * fetch with a timeout, parsed as a JSON object ({} when the body is not JSON). Network failures become
 * MailTransientError. The URL is never put in an error (it can carry tokens or keys).
 */
export async function requestJson(url: string, init: RequestInit, service: string): Promise<JsonResponse> {
  let res: Response;
  let body: string;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    body = await res.text();
  } catch (e) {
    const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    throw new MailTransientError(
      timedOut ? `${service} did not respond in time. It will be retried.` : `Could not reach ${service}. It will be retried.`,
      null,
      timedOut ? "ETIMEOUT" : "ENETWORK",
    );
  }
  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = body ? JSON.parse(body) : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed as Record<string, unknown>;
  } catch {
    data = {};
  }
  return { status: res.status, ok: res.ok, data, retryAfterSec: retryAfter(res.headers.get("retry-after")) };
}

/** POST init for an application/x-www-form-urlencoded body (OAuth token endpoints). */
export function formPost(params: Record<string, string>): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(params).toString(),
  };
}

/** Rate limits and server errors are worth retrying; everything else needs a code change or the user. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Only plain objects are cursors; anything else (a corrupted row) starts fresh instead of being spread. */
export function plainCursor(c: unknown): Record<string, unknown> {
  return c && typeof c === "object" && !Array.isArray(c) ? (c as Record<string, unknown>) : {};
}

function retryAfter(header: string | null): number | null {
  if (!header) return null;
  const secs = Number(header);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(Math.round(secs), 3600);
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, Math.min(Math.round((at - Date.now()) / 1000), 3600)) : null;
}
