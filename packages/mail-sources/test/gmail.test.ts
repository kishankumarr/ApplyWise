import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchAlertEmailsGmail,
  GMAIL_PROCESSED_IDS_MAX,
  GMAIL_SCOPE,
  gmailAccessToken,
  gmailAuthUrl,
  gmailExchangeCode,
  gmailRevoke,
  MailAuthError,
  MailTransientError,
  type FetchOptions,
} from "../src";

interface Call {
  url: URL;
  method: string;
  body: URLSearchParams;
  auth: string | null;
}
type Handler = (call: Call) => Response | Promise<Response>;

let calls: Call[] = [];
let handler: Handler;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const call = { url: new URL(String(input)), method: init?.method ?? "GET", body: new URLSearchParams(String(init?.body ?? "")), auth: headers.get("authorization") };
      calls.push(call);
      return handler(call);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const client = { clientId: "cid.apps.googleusercontent.com", clientSecret: "GOCSPX-secret-value", redirectUri: "http://localhost:3000/api/job-feeds/mailbox/gmail/callback" };

describe("gmailAuthUrl", () => {
  it("asks for offline, consented, read-only access with PKCE", () => {
    const url = new URL(gmailAuthUrl({ clientId: client.clientId, redirectUri: client.redirectUri, state: "st", codeChallenge: "ch", loginHint: "priya@gmail.com" }));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: client.clientId,
      redirect_uri: client.redirectUri,
      response_type: "code",
      scope: GMAIL_SCOPE,
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      state: "st",
      code_challenge: "ch",
      code_challenge_method: "S256",
      login_hint: "priya@gmail.com",
    });
  });
});

describe("gmailExchangeCode", () => {
  const exchange = () => gmailExchangeCode({ ...client, code: "4/0code", codeVerifier: "verifier-123" });

  it("exchanges the code and reads the address from the profile", async () => {
    handler = ({ url }) =>
      url.hostname === "oauth2.googleapis.com"
        ? json({ access_token: "ya29.access", refresh_token: "1//refresh", scope: `openid ${GMAIL_SCOPE}`, token_type: "Bearer", expires_in: 3599 })
        : json({ emailAddress: "Priya.Sharma@gmail.com", messagesTotal: 10, historyId: "1" });
    expect(await exchange()).toEqual({ refreshToken: "1//refresh", accessToken: "ya29.access", scope: `openid ${GMAIL_SCOPE}`, email: "priya.sharma@gmail.com" });
    expect(Object.fromEntries(calls[0]!.body)).toEqual({
      grant_type: "authorization_code",
      code: "4/0code",
      client_id: client.clientId,
      client_secret: client.clientSecret,
      redirect_uri: client.redirectUri,
      code_verifier: "verifier-123",
    });
    expect(calls[1]!.url.pathname).toBe("/gmail/v1/users/me/profile");
    expect(calls[1]!.auth).toBe("Bearer ya29.access");
  });

  it("rejects a grant without gmail.readonly and revokes it", async () => {
    handler = ({ url }) => (url.pathname === "/revoke" ? json({}) : json({ access_token: "ya29.access", refresh_token: "1//refresh", scope: "openid email" }));
    await expect(exchange()).rejects.toThrow(/tick "View your email messages and settings"/);
    expect(calls.map((c) => c.url.pathname)).toEqual(["/token", "/revoke"]);
    expect(calls[1]!.body.get("token")).toBe("1//refresh");
  });

  it("requires a refresh token", async () => {
    handler = () => json({ access_token: "ya29.access", scope: GMAIL_SCOPE });
    await expect(exchange()).rejects.toBeInstanceOf(MailAuthError);
  });

  it("revokes the new grant when the profile cannot be read", async () => {
    handler = ({ url }) =>
      url.pathname === "/token"
        ? json({ access_token: "ya29.access", refresh_token: "1//refresh", scope: GMAIL_SCOPE })
        : url.pathname === "/revoke"
          ? json({})
          : json({ error: { code: 503, status: "UNAVAILABLE" } }, 503);
    await expect(exchange()).rejects.toBeInstanceOf(MailTransientError);
    expect(calls.map((c) => c.url.pathname)).toEqual(["/token", "/gmail/v1/users/me/profile", "/revoke"]);
    expect(calls[2]!.body.get("token")).toBe("1//refresh");

    calls = [];
    handler = ({ url }) => (url.pathname === "/token" ? json({ access_token: "ya29.access", refresh_token: "1//refresh", scope: GMAIL_SCOPE }) : json({}));
    await expect(exchange()).rejects.toThrow(/incomplete profile/);
    expect(calls.at(-1)!.url.pathname).toBe("/revoke");
  });

  it("maps a reused code to MailAuthError", async () => {
    handler = () => json({ error: "invalid_grant", error_description: "Bad Request" }, 400);
    await expect(exchange()).rejects.toThrow("The Google sign-in expired or was already used. Connect Gmail again.");
  });
});

describe("gmailAccessToken", () => {
  const refresh = () => gmailAccessToken({ clientId: client.clientId, clientSecret: client.clientSecret, refreshToken: "1//refresh-token-value" });

  it("returns a fresh access token", async () => {
    handler = () => json({ access_token: "ya29.new", scope: GMAIL_SCOPE, expires_in: 3599 });
    expect(await refresh()).toBe("ya29.new");
    expect(calls[0]!.body.get("grant_type")).toBe("refresh_token");
  });

  it("maps invalid_grant to a reconnect message without secrets", async () => {
    handler = () => json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, 400);
    const err = await refresh().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MailAuthError);
    expect((err as Error).message).toBe("Gmail access was revoked or has expired. Reconnect Gmail.");
    expect((err as Error).message).not.toMatch(/refresh-token-value|GOCSPX|oauth2\.googleapis/);
  });

  it("maps a bad client to MailAuthError", async () => {
    handler = () => json({ error: "invalid_client", error_description: "The OAuth client was not found." }, 401);
    await expect(refresh()).rejects.toThrow(/OAuth client ID or secret/);
  });

  it("maps 429, 5xx and network failures to MailTransientError", async () => {
    handler = () => json({ error: "rate_limited" }, 429, { "retry-after": "30" });
    const err = await refresh().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MailTransientError);
    expect(err).toMatchObject({ retryAfterSec: 30, name: "MailTransientError" });

    handler = () => new Response("<html>oops</html>", { status: 503 });
    await expect(refresh()).rejects.toBeInstanceOf(MailTransientError);

    handler = () => {
      throw new TypeError("fetch failed");
    };
    const net = await refresh().catch((e: unknown) => e);
    expect(net).toBeInstanceOf(MailTransientError);
    expect((net as Error).message).toBe("Could not reach Google. It will be retried.");
  });
});

describe("gmailRevoke", () => {
  it("is best effort", async () => {
    handler = () => json({ error: "invalid_token" }, 400);
    await expect(gmailRevoke("tok")).resolves.toBeUndefined();
    handler = () => {
      throw new TypeError("fetch failed");
    };
    await expect(gmailRevoke("tok")).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------- fetching alerts

const raw = (from: string, subject: string) =>
  Buffer.from(`From: ${from}\r\nSubject: ${subject}\r\nMessage-ID: <${subject.replace(/\W/g, "")}@test>\r\nContent-Type: text/plain\r\n\r\n${subject}\r\n`).toString("base64url");

interface FakeGmail {
  id: string;
  from: string;
  subject: string;
  at: number;
  size?: number;
}

/** A fake Gmail API: newest-first listing with 2 ids per page. */
function gmailApi(messages: FakeGmail[], opts: { pageSize?: number; missing?: string[] } = {}): Handler {
  const sorted = [...messages].sort((a, b) => b.at - a.at);
  const pageSize = opts.pageSize ?? 2;
  return ({ url }) => {
    if (url.pathname === "/gmail/v1/users/me/messages") {
      const start = Number(url.searchParams.get("pageToken") ?? 0);
      const page = sorted.slice(start, start + pageSize).map((m) => ({ id: m.id, threadId: m.id }));
      const next = start + pageSize < sorted.length ? String(start + pageSize) : undefined;
      return json({ messages: page, nextPageToken: next, resultSizeEstimate: sorted.length });
    }
    const id = decodeURIComponent(url.pathname.split("/").pop() ?? "");
    const m = sorted.find((x) => x.id === id);
    if (!m || opts.missing?.includes(id)) return json({ error: { code: 404, message: "Not Found", status: "NOT_FOUND" } }, 404);
    return json({ id, threadId: id, internalDate: String(m.at), sizeEstimate: m.size ?? 900, raw: raw(m.from, m.subject) });
  };
}

const T0 = Date.parse("2026-09-20T00:00:00Z");
const inbox: FakeGmail[] = [
  { id: "a1", from: "Naukri <jobs@naukri.com>", subject: "Frontend Developer at Kavach", at: T0 + 1_000 },
  { id: "a2", from: "jobalerts-noreply@linkedin.com", subject: "React Engineer at Lotus", at: T0 + 2_000 },
  { id: "a3", from: "LinkedIn Jobs <jobs-listings@linkedin.com>", subject: "Not an allowed address", at: T0 + 3_000 },
  { id: "a4", from: "alerts@mail.naukri.com", subject: "Backend Engineer at Tara", at: T0 + 4_000 },
];
const since = new Date("2026-09-12T00:00:00Z");
const opts = (over: Partial<FetchOptions> = {}): FetchOptions => ({ since, senderDomains: ["naukri.com", "jobalerts-noreply@linkedin.com"], maxMessages: 50, cursor: {}, ...over });

describe("fetchAlertEmailsGmail", () => {
  it("searches by sender, follows pagination and returns the newest alerts first", async () => {
    handler = gmailApi(inbox);
    const r = await fetchAlertEmailsGmail("ya29.access", opts());
    const lists = calls.filter((c) => c.url.pathname.endsWith("/messages"));
    expect(lists).toHaveLength(2);
    expect(lists[0]!.url.searchParams.get("q")).toBe(`from:(naukri.com OR jobalerts-noreply@linkedin.com) after:${since.getTime() / 1000}`);
    expect(lists[0]!.url.searchParams.get("includeSpamTrash")).toBe("false");
    expect(lists[1]!.url.searchParams.get("pageToken")).toBe("2");
    const gets = calls.filter((c) => /\/messages\/[^/]+$/.test(c.url.pathname));
    expect(gets.every((c) => c.url.searchParams.get("format") === "raw" && c.auth === "Bearer ya29.access")).toBe(true);
    expect(r.messages.map((m) => m.subject)).toEqual(["Backend Engineer at Tara", "React Engineer at Lotus", "Frontend Developer at Kavach"]);
    expect(r.messages[2]).toMatchObject({ from: "jobs@naukri.com", text: expect.stringContaining("Kavach") });
    expect(r.cursor).toEqual({ gmail: { lastInternalDate: T0 + 4_000, processedIds: ["a1", "a2", "a3", "a4"] } });
  });

  it("skips processed ids, overlaps the last search window and keeps other cursor keys", async () => {
    handler = gmailApi([...inbox, { id: "a5", from: "jobs@naukri.com", subject: "Data Engineer at Veda", at: T0 + 5_000 }]);
    const cursor = { gmail: { lastInternalDate: T0 + 4_000, processedIds: ["a1", "a2", "a3", "a4"] }, forwardingConfirmation: null };
    const r = await fetchAlertEmailsGmail("ya29.access", opts({ cursor }));
    const q = calls[0]!.url.searchParams.get("q")!;
    expect(q).toContain(`after:${Math.floor((T0 + 4_000 - 2 * 3600_000) / 1000)}`);
    expect(calls.filter((c) => /\/messages\/[^/]+$/.test(c.url.pathname)).map((c) => c.url.pathname.split("/").pop())).toEqual(["a5"]);
    expect(r.messages.map((m) => m.subject)).toEqual(["Data Engineer at Veda"]);
    expect(r.cursor).toEqual({ gmail: { lastInternalDate: T0 + 5_000, processedIds: ["a1", "a2", "a3", "a4", "a5"] }, forwardingConfirmation: null });
  });

  it("caps at maxMessages (newest) and skips oversized or deleted messages", async () => {
    handler = gmailApi(
      [...inbox, { id: "big", from: "jobs@naukri.com", subject: "Huge", at: T0 + 3_500, size: 3 * 1024 * 1024 }],
      { missing: ["a3"] },
    );
    const r = await fetchAlertEmailsGmail("ya29.access", opts({ maxMessages: 3 }));
    const lists = calls.filter((c) => c.url.pathname.endsWith("/messages"));
    expect(lists).toHaveLength(2);
    // Newest three: a4, big (too large), a3 (deleted between list and get). a2 and a1 are past the cap.
    expect(calls.filter((c) => /\/messages\/[^/]+$/.test(c.url.pathname)).map((c) => c.url.pathname.split("/").pop())).toEqual(["a4", "big", "a3"]);
    expect(r.messages.map((m) => m.subject)).toEqual(["Backend Engineer at Tara"]);
    expect((r.cursor.gmail as { processedIds: string[] }).processedIds).toEqual(["big", "a4"]);
  });

  it(`keeps at most ${GMAIL_PROCESSED_IDS_MAX} processed ids`, async () => {
    handler = gmailApi(inbox);
    const old = Array.from({ length: GMAIL_PROCESSED_IDS_MAX }, (_, i) => `old${i}`);
    const r = await fetchAlertEmailsGmail("ya29.access", opts({ cursor: { gmail: { lastInternalDate: 0, processedIds: old } } }));
    const ids = (r.cursor.gmail as { processedIds: string[] }).processedIds;
    expect(ids).toHaveLength(GMAIL_PROCESSED_IDS_MAX);
    expect(ids.slice(-4)).toEqual(["a1", "a2", "a3", "a4"]);
    expect(ids[0]).toBe("old4");
  });

  it("does nothing without valid senders", async () => {
    handler = gmailApi(inbox);
    expect(await fetchAlertEmailsGmail("ya29.access", opts({ senderDomains: ["bad domain"] }))).toEqual({ messages: [], cursor: {} });
    expect(calls).toHaveLength(0);
  });

  it("maps API errors", async () => {
    handler = () => json({ error: { code: 401, message: "Invalid Credentials", status: "UNAUTHENTICATED" } }, 401);
    await expect(fetchAlertEmailsGmail("ya29.access", opts())).rejects.toThrow("Gmail access was revoked or has expired. Reconnect Gmail.");

    handler = () =>
      json({ error: { code: 403, status: "PERMISSION_DENIED", errors: [{ reason: "insufficientPermissions" }], details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] } }, 403);
    await expect(fetchAlertEmailsGmail("ya29.access", opts())).rejects.toThrow(/tick "View your email messages/);

    handler = () => json({ error: { code: 403, status: "PERMISSION_DENIED", errors: [{ reason: "accessNotConfigured" }] } }, 403);
    await expect(fetchAlertEmailsGmail("ya29.access", opts())).rejects.toThrow(/Gmail API is not enabled/);

    handler = () => json({ error: { code: 403, errors: [{ reason: "userRateLimitExceeded" }] } }, 403);
    await expect(fetchAlertEmailsGmail("ya29.access", opts())).rejects.toBeInstanceOf(MailTransientError);

    handler = () => json({ error: { code: 429, status: "RESOURCE_EXHAUSTED" } }, 429, { "retry-after": "12" });
    await expect(fetchAlertEmailsGmail("ya29.access", opts())).rejects.toMatchObject({ name: "MailTransientError", retryAfterSec: 12 });

    const messagesOnly = gmailApi(inbox);
    handler = (c) => (c.url.pathname.endsWith("/messages") ? messagesOnly(c) : json({ error: { code: 500, status: "INTERNAL" } }, 500));
    const err = await fetchAlertEmailsGmail("ya29.access", opts()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MailTransientError);
    expect((err as Error).message).not.toContain("ya29.access");
  });

  it.each(["dailyLimitExceeded", "quotaExceeded", "concurrentLimitExceeded"])("treats 403 %s as a quota wait, not a reconnect", async (reason) => {
    handler = () => json({ error: { code: 403, status: "PERMISSION_DENIED", errors: [{ reason }] } }, 403);
    const err = await fetchAlertEmailsGmail("ya29.access", opts()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MailTransientError);
    expect(err).not.toBeInstanceOf(MailAuthError);
  });

  it("throws only MailAuthError or MailTransientError, even for unexpected statuses", async () => {
    handler = () => json({ error: { code: 400, status: "INVALID_ARGUMENT", errors: [{ reason: "invalidArgument" }] } }, 400);
    const err = await fetchAlertEmailsGmail("ya29.access", opts()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MailTransientError);
    expect(err).toMatchObject({ code: "400", message: "Gmail returned an unexpected error. It will be retried." });
  });

  it("never searches with after:NaN and ignores a cursor that is not a plain object", async () => {
    handler = gmailApi(inbox);
    const r = await fetchAlertEmailsGmail("ya29.access", opts({ since: new Date("invalid"), cursor: "corrupt" as unknown as Record<string, unknown> }));
    expect(calls[0]!.url.searchParams.get("q")).toBe("from:(naukri.com OR jobalerts-noreply@linkedin.com) after:0");
    expect(Object.keys(r.cursor)).toEqual(["gmail"]);

    calls = [];
    await fetchAlertEmailsGmail("ya29.access", opts({ since: new Date("invalid"), cursor: { gmail: { lastInternalDate: T0 + 4_000, processedIds: [] } } }));
    expect(calls[0]!.url.searchParams.get("q")).toContain(`after:${Math.floor((T0 + 4_000 - 2 * 3600_000) / 1000)}`);
  });
});
