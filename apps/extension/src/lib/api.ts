import type { ExtractedJob, HandoffList, PrefillPayload } from "./types";

export interface ExtensionSettings {
  baseUrl: string;
  token: string;
}

const DEFAULTS: ExtensionSettings = { baseUrl: "http://localhost:3000", token: "" };

export async function loadSettings(): Promise<ExtensionSettings> {
  const stored = await chrome.storage.local.get(["baseUrl", "token"]);
  return { baseUrl: (stored.baseUrl as string) || DEFAULTS.baseUrl, token: (stored.token as string) || "" };
}

export async function saveSettings(s: ExtensionSettings): Promise<void> {
  await chrome.storage.local.set({ baseUrl: s.baseUrl.replace(/\/$/, ""), token: s.token.trim() });
}

/**
 * The manual handoff the user selected (application id only), kept so the selection survives the popup closing
 * when "Open apply page" focuses the new tab.
 */
export async function loadSelectedHandoff(): Promise<string | null> {
  const stored = await chrome.storage.local.get(["handoffId"]);
  return typeof stored.handoffId === "string" && stored.handoffId ? stored.handoffId : null;
}

export async function saveSelectedHandoff(applicationId: string | null): Promise<void> {
  if (applicationId) await chrome.storage.local.set({ handoffId: applicationId });
  else await chrome.storage.local.remove("handoffId");
}

interface Envelope<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

async function call<T>(s: ExtensionSettings, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${s.baseUrl}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${s.token}`, "content-type": "application/json", ...(init.headers ?? {}) },
    credentials: "omit",
  });
  const json = (await res.json().catch(() => null)) as Envelope<T> | null;
  if (!res.ok || !json?.success) throw new Error(json?.error?.message ?? `Request failed (${res.status})`);
  return json.data as T;
}

export const extensionApi = {
  me: (s: ExtensionSettings) => call<{ signedIn: boolean; name: string | null; email: string | null }>(s, "/api/extension/me"),
  /** Sends only the reviewed fields - minimal data. */
  importJob: (s: ExtensionSettings, job: ExtractedJob) =>
    call<{ imported: { jobId: string; duplicate: boolean }[] }>(s, "/api/jobs/import/browser", {
      method: "POST",
      body: JSON.stringify({ ...job, userConfirmed: true }),
    }),
  prefill: (s: ExtensionSettings, code: string) => call<PrefillPayload>(s, `/api/extension/prefill?code=${encodeURIComponent(code)}`),
  /** Applications waiting for a manual application (fetched when the popup opens or on "Refresh"; never polled). */
  handoffs: (s: ExtensionSettings) => call<HandoffList>(s, "/api/extension/handoffs"),
};
