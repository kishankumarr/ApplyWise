import type { ApiEnvelope } from "@applywise/types";

export class ApiClientError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly fieldErrors?: Record<string, string[]>,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

/** Typed client for the ApplyWise JSON envelope API. Same-origin only (cookies). */
export async function api<T>(path: string, init: { method?: string; body?: unknown; formData?: FormData } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? (init.body || init.formData ? "POST" : "GET"),
    headers: init.formData ? undefined : init.body !== undefined ? { "content-type": "application/json" } : undefined,
    body: init.formData ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined),
    credentials: "same-origin",
  });
  let json: ApiEnvelope<T> | null = null;
  try {
    json = (await res.json()) as ApiEnvelope<T>;
  } catch {
    throw new ApiClientError(`Unexpected response (${res.status})`, "BAD_RESPONSE", res.status);
  }
  if (!res.ok || !json.success) {
    const err = json?.error;
    throw new ApiClientError(err?.message ?? `Request failed (${res.status})`, err?.code ?? "UNKNOWN", res.status, err?.fieldErrors, json?.requestId);
  }
  return json.data as T;
}

/** POST that returns a file; triggers a browser download. */
export async function downloadFile(path: string, method: "GET" | "POST" = "POST"): Promise<void> {
  const res = await fetch(path, { method, credentials: "same-origin" });
  if (!res.ok) {
    let message = `Download failed (${res.status})`;
    try {
      const j = (await res.json()) as ApiEnvelope<unknown>;
      message = j.error?.message ?? message;
    } catch {
      /* not JSON */
    }
    throw new ApiClientError(message, "DOWNLOAD_FAILED", res.status);
  }
  const blob = await res.blob();
  const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "download";
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : "Something went wrong.";
}
