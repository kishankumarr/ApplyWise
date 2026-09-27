import { MailAuthError, MailTransientError } from "./errors";
import { formPost, isRetryableStatus, plainCursor, requestJson, str, type JsonResponse } from "./http";
import { hasScope } from "./oauth";
import { parseRawEmail } from "./parse";
import { gmailQuery, matchesSender, normalizeSenders } from "./senders";
import type { FetchOptions, FetchResult, MailCursor, MailMessage } from "./types";

/**
 * Gmail REST API with the narrowest scope that can search and read bodies (gmail.readonly).
 * Plain fetch, OAuth 2.0 web-server flow with PKCE. Tokens are never logged or put in errors.
 */
export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const API_URL = "https://gmail.googleapis.com/gmail/v1/users/me";

/** Larger messages are not parsed; job alerts are far smaller (Gmail reports the size only with the message). */
const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
/** Message ids remembered in the cursor, so overlapping searches never import a message twice. */
export const GMAIL_PROCESSED_IDS_MAX = 300;
/** Each search starts this long before the newest message seen, so late-indexed mail is not missed. */
const OVERLAP_MS = 2 * 3600_000;
const LIST_PAGE_SIZE = 100;
const MAX_LIST_PAGES = 10;
const GET_CONCURRENCY = 4;

const RECONNECT = "Gmail access was revoked or has expired. Reconnect Gmail.";
const MISSING_SCOPE =
  'ApplyWise was not allowed to read your Gmail. Reconnect Gmail and tick "View your email messages and settings" on the Google consent screen.';

interface GmailCursor {
  /** internalDate (epoch ms) of the newest message seen. */
  lastInternalDate: number;
  /** Newest last, at most GMAIL_PROCESSED_IDS_MAX. */
  processedIds: string[];
}

export function gmailAuthUrl(p: { clientId: string; redirectUri: string; state: string; codeChallenge: string; loginHint?: string }): string {
  const q = new URLSearchParams({
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    response_type: "code",
    scope: GMAIL_SCOPE,
    // offline + consent: Google only returns a refresh token on a fresh consent.
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state: p.state,
    code_challenge: p.codeChallenge,
    code_challenge_method: "S256",
  });
  if (p.loginHint) q.set("login_hint", p.loginHint);
  return `${AUTH_URL}?${q.toString()}`;
}

/** Exchanges the callback code; requires the gmail.readonly grant and a refresh token. */
export async function gmailExchangeCode(p: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
  codeVerifier: string;
}): Promise<{ refreshToken: string; accessToken: string; scope: string; email: string }> {
  const r = await requestJson(
    TOKEN_URL,
    formPost({
      grant_type: "authorization_code",
      code: p.code,
      client_id: p.clientId,
      client_secret: p.clientSecret,
      redirect_uri: p.redirectUri,
      code_verifier: p.codeVerifier,
    }),
    "Google",
  );
  if (!r.ok) throw tokenError(r, "exchange");
  const accessToken = str(r.data.access_token);
  const refreshToken = str(r.data.refresh_token);
  const scope = str(r.data.scope) ?? "";
  if (!accessToken) throw new MailTransientError("Google returned an incomplete sign-in response. Try connecting Gmail again.");
  if (!hasScope(scope, GMAIL_SCOPE)) {
    // Granular consent lets users untick the permission; drop the useless grant.
    await gmailRevoke(refreshToken ?? accessToken);
    throw new MailAuthError(MISSING_SCOPE);
  }
  if (!refreshToken) {
    throw new MailAuthError("Google did not grant offline access. Remove ApplyWise from your Google Account's third-party connections, then connect Gmail again.");
  }
  let email: string | undefined;
  try {
    email = str((await gmailApi(accessToken, "/profile")).emailAddress)?.toLowerCase();
    if (!email) throw new MailTransientError("Google returned an incomplete profile. Try connecting Gmail again.");
  } catch (e) {
    // The caller never receives this grant, so do not leave a live refresh token behind (Google keeps 100 per client).
    await gmailRevoke(refreshToken);
    throw e;
  }
  return { refreshToken, accessToken, scope, email };
}

/** Fresh access token from the stored refresh token. */
export async function gmailAccessToken(p: { clientId: string; clientSecret: string; refreshToken: string }): Promise<string> {
  const r = await requestJson(
    TOKEN_URL,
    formPost({ grant_type: "refresh_token", refresh_token: p.refreshToken, client_id: p.clientId, client_secret: p.clientSecret }),
    "Google",
  );
  if (!r.ok) throw tokenError(r, "refresh");
  const token = str(r.data.access_token);
  if (!token) throw new MailTransientError("Google returned an incomplete token response. It will be retried.");
  const scope = str(r.data.scope);
  if (scope && !hasScope(scope, GMAIL_SCOPE)) throw new MailAuthError(MISSING_SCOPE);
  return token;
}

/** Revokes a refresh (or access) token. Best effort: never throws. */
export async function gmailRevoke(token: string): Promise<void> {
  if (!token) return;
  try {
    await requestJson(REVOKE_URL, formPost({ token }), "Google");
  } catch {
    // Disconnecting still deletes the stored token.
  }
}

/**
 * Job-alert emails via messages.list (q = from:(...) after:<unix>) + messages.get?format=raw.
 * Returns the newest `maxMessages` not processed before, newest first.
 */
export async function fetchAlertEmailsGmail(accessToken: string, opts: FetchOptions): Promise<FetchResult> {
  const base = plainCursor(opts.cursor);
  const prev = readCursor(base);
  const senders = normalizeSenders(opts.senderDomains);
  const max = clampMax(opts.maxMessages);
  if (!senders.length || !max) return { messages: [], cursor: base };

  const floor = opts.since.getTime();
  const sinceMs = Math.max(Number.isFinite(floor) ? floor : 0, prev.lastInternalDate ? prev.lastInternalDate - OVERLAP_MS : 0);
  const q = gmailQuery(senders, new Date(sinceMs));
  const processed = new Set(prev.processedIds);
  const ids: string[] = [];
  let pageToken: string | null = null;
  // messages.list is newest first; stop once enough unprocessed ids are collected.
  for (let page = 0; page < MAX_LIST_PAGES && ids.length < max; page++) {
    const params = new URLSearchParams({ q, maxResults: String(LIST_PAGE_SIZE), includeSpamTrash: "false" });
    if (pageToken) params.set("pageToken", pageToken);
    const data = await gmailApi(accessToken, `/messages?${params.toString()}`);
    for (const m of Array.isArray(data.messages) ? data.messages : []) {
      const id = str((m as { id?: unknown }).id);
      if (id && !processed.has(id) && !ids.includes(id)) ids.push(id);
      if (ids.length >= max) break;
    }
    pageToken = str(data.nextPageToken);
    if (!pageToken) break;
  }

  const fetched = await mapLimit(ids, GET_CONCURRENCY, (id) => fetchRaw(accessToken, id));
  let lastInternalDate = prev.lastInternalDate;
  const found: { msg: MailMessage; at: number }[] = [];
  const done: string[] = [];
  for (const f of fetched) {
    if (!f) continue;
    done.push(f.id);
    lastInternalDate = Math.max(lastInternalDate, Math.min(f.internalDate, Date.now()));
    if (f.size > MAX_MESSAGE_BYTES) continue;
    let msg: MailMessage;
    try {
      msg = await parseRawEmail(f.raw);
    } catch {
      continue; // unparsable: remembered as processed so it is not retried every run
    }
    if (matchesSender(msg.from, senders)) found.push({ msg, at: f.internalDate });
  }

  // Oldest of this batch first, so the cap keeps the ids most likely to show up in the next overlap.
  const doneSet = new Set(done);
  const processedIds = [...prev.processedIds.filter((id) => !doneSet.has(id)), ...done.reverse()].slice(-GMAIL_PROCESSED_IDS_MAX);
  const gmail: GmailCursor = { lastInternalDate, processedIds };
  return {
    messages: found.sort((a, b) => b.at - a.at).map((f) => f.msg),
    cursor: { ...base, gmail },
  };
}

// ---------------------------------------------------------------- internals

async function fetchRaw(accessToken: string, id: string): Promise<{ id: string; internalDate: number; size: number; raw: Buffer } | null> {
  const r = await requestJson(`${API_URL}/messages/${encodeURIComponent(id)}?format=raw`, bearer(accessToken), "Gmail");
  if (r.status === 404) return null; // deleted between list and get
  if (!r.ok) throw apiError(r);
  const raw = Buffer.from(str(r.data.raw) ?? "", "base64url");
  const internalDate = Number(r.data.internalDate) || 0;
  const size = Math.max(Number(r.data.sizeEstimate) || 0, raw.length);
  return { id, internalDate, size, raw };
}

async function gmailApi(accessToken: string, path: string): Promise<Record<string, unknown>> {
  const r = await requestJson(`${API_URL}${path}`, bearer(accessToken), "Gmail");
  if (!r.ok) throw apiError(r);
  return r.data;
}

function bearer(accessToken: string): RequestInit {
  return { headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" } };
}

/** Maps a Gmail API error ({ error: { code, status, errors[{reason}], details[{reason}] } }). */
function apiError(r: JsonResponse): MailAuthError | MailTransientError {
  const e = (r.data.error && typeof r.data.error === "object" ? r.data.error : {}) as { status?: unknown; errors?: unknown; details?: unknown };
  const items = [...(Array.isArray(e.errors) ? e.errors : []), ...(Array.isArray(e.details) ? e.details : [])] as { reason?: unknown }[];
  const reasons = [...items.map((i) => String(i?.reason ?? "")), String(e.status ?? "")].join(" ");
  if (r.status === 401) return new MailAuthError(RECONNECT);
  // Quota reasons come as 403 too; reconnecting would not help, waiting does.
  if (isRetryableStatus(r.status) || /rateLimitExceeded|dailyLimitExceeded|quotaExceeded|concurrentLimitExceeded|RATE_LIMIT_EXCEEDED|RESOURCE_EXHAUSTED|backendError/i.test(reasons)) {
    return new MailTransientError("Gmail is busy right now. It will be retried.", r.retryAfterSec, String(r.status));
  }
  if (r.status === 403) {
    if (/accessNotConfigured|SERVICE_DISABLED/i.test(reasons)) {
      return new MailAuthError("The Gmail API is not enabled in this server's Google Cloud project. Enable it, then sync again.");
    }
    if (/insufficientPermissions|SCOPE_INSUFFICIENT/i.test(reasons)) return new MailAuthError(MISSING_SCOPE);
    return new MailAuthError("Google denied access to this mailbox. Reconnect Gmail.");
  }
  if (r.status === 400 && /failedPrecondition/i.test(reasons)) return new MailAuthError("Gmail is not turned on for this Google account.");
  return new MailTransientError("Gmail returned an unexpected error. It will be retried.", null, String(r.status));
}

/** Maps an OAuth token endpoint error ({ error, error_description }); the description is never shown. */
function tokenError(r: JsonResponse, phase: "exchange" | "refresh"): MailAuthError | MailTransientError {
  const code = str(r.data.error) ?? "";
  if (isRetryableStatus(r.status) || code === "temporarily_unavailable") {
    return new MailTransientError("Google sign-in is temporarily unavailable. It will be retried.", r.retryAfterSec, String(r.status));
  }
  if (code === "invalid_grant") {
    return new MailAuthError(phase === "refresh" ? RECONNECT : "The Google sign-in expired or was already used. Connect Gmail again.");
  }
  if (code === "invalid_client" || code === "unauthorized_client") {
    return new MailAuthError("Google rejected this server's OAuth client ID or secret. Check the Gmail API settings, then reconnect Gmail.");
  }
  if (code === "redirect_uri_mismatch") {
    return new MailAuthError("The redirect URI is not registered for this Google OAuth client. Add it under Authorized redirect URIs and try again.");
  }
  if (code === "invalid_scope") return new MailAuthError(MISSING_SCOPE);
  const safe = /^[a-z_]{1,40}$/.test(code) ? ` (${code})` : "";
  return new MailAuthError(`Google sign-in failed${safe}. Connect Gmail again.`);
}

function readCursor(c: MailCursor): GmailCursor {
  const g = (c.gmail && typeof c.gmail === "object" ? c.gmail : {}) as { lastInternalDate?: unknown; processedIds?: unknown };
  const last = typeof g.lastInternalDate === "number" && Number.isFinite(g.lastInternalDate) ? Math.min(g.lastInternalDate, Date.now()) : 0;
  const ids = Array.isArray(g.processedIds) ? g.processedIds.filter((x): x is string => typeof x === "string") : [];
  return { lastInternalDate: Math.max(0, last), processedIds: ids.slice(-GMAIL_PROCESSED_IDS_MAX) };
}

function clampMax(n: number): number {
  return Math.max(0, Math.min(500, Math.floor(Number.isFinite(n) ? n : 0)));
}

/** Runs `fn` over `items` with at most `limit` in flight; results keep input order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
