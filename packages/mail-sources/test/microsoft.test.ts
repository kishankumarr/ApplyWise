import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MailAuthError, MailTransientError, MICROSOFT_IMAP_SCOPE, microsoftAccessToken, microsoftPollDeviceCode, microsoftStartDeviceCode } from "../src";

let calls: { url: string; body: URLSearchParams }[] = [];
let respond: () => Response;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const idToken = (claims: Record<string, unknown>) => `${Buffer.from('{"alg":"RS256"}').toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: new URLSearchParams(String(init?.body ?? "")) });
      return respond();
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const clientId = "11111111-2222-3333-4444-555555555555";

describe("microsoftStartDeviceCode", () => {
  it("requests a device code for IMAP plus an id_token", async () => {
    respond = () =>
      json({
        device_code: "DAQABAAEAAAD",
        user_code: "F8K2QWERT",
        verification_uri: "https://microsoft.com/devicelogin",
        expires_in: 900,
        interval: 5,
        message: "To sign in, use a web browser to open the page https://microsoft.com/devicelogin and enter the code F8K2QWERT to authenticate.",
      });
    const r = await microsoftStartDeviceCode({ clientId });
    expect(r).toEqual({
      deviceCode: "DAQABAAEAAAD",
      userCode: "F8K2QWERT",
      verificationUri: "https://microsoft.com/devicelogin",
      expiresIn: 900,
      interval: 5,
      message: expect.stringContaining("F8K2QWERT"),
    });
    expect(calls[0]!.url).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/devicecode");
    expect(calls[0]!.body.get("client_id")).toBe(clientId);
    expect(calls[0]!.body.get("scope")).toBe(`${MICROSOFT_IMAP_SCOPE} openid email`);
  });

  it("uses the configured tenant and rejects unsafe ones", async () => {
    respond = () => json({ device_code: "d", user_code: "u", verification_uri: "https://microsoft.com/devicelogin", expires_in: 600, interval: 5 });
    await microsoftStartDeviceCode({ clientId, tenant: "consumers" });
    expect(calls[0]!.url).toBe("https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode");
    await expect(microsoftStartDeviceCode({ clientId, tenant: "evil.example/x?" })).rejects.toBeInstanceOf(MailAuthError);
    await microsoftStartDeviceCode({ clientId, tenant: "contoso.onmicrosoft.com" });
    await microsoftStartDeviceCode({ clientId, tenant: "9188040d-6c67-4c5b-b112-36a304b66dad" });
    expect(calls.slice(1).map((c) => new URL(c.url).pathname)).toEqual([
      "/contoso.onmicrosoft.com/oauth2/v2.0/devicecode",
      "/9188040d-6c67-4c5b-b112-36a304b66dad/oauth2/v2.0/devicecode",
    ]);
  });

  it.each(["..", ".", "a..b", ".common", "common.", "-common"])("rejects the path-changing tenant %s without a request", async (tenant) => {
    calls = [];
    await expect(microsoftStartDeviceCode({ clientId, tenant })).rejects.toThrow(/tenant setting is invalid/);
    expect(calls).toHaveLength(0);
  });

  it("maps a timeout without the URL", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }),
    );
    const err = await microsoftStartDeviceCode({ clientId }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MailTransientError);
    expect(err).toMatchObject({ code: "ETIMEOUT", message: "Microsoft did not respond in time. It will be retried." });
    expect((err as Error).message).not.toContain("login.microsoftonline.com");
  });

  it("maps a misconfigured app registration and outages", async () => {
    respond = () => json({ error: "invalid_client", error_description: "AADSTS7000218: The request body must contain client_assertion or client_secret." }, 401);
    const err = await microsoftStartDeviceCode({ clientId }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MailAuthError);
    expect((err as Error).message).not.toContain("AADSTS");
    respond = () => json({ error: "temporarily_unavailable" }, 503);
    await expect(microsoftStartDeviceCode({ clientId })).rejects.toBeInstanceOf(MailTransientError);
  });
});

describe("microsoftPollDeviceCode", () => {
  const poll = () => microsoftPollDeviceCode({ clientId, deviceCode: "DAQABAAEAAAD" });

  it.each([
    ["authorization_pending", "pending"],
    ["slow_down", "slow_down"],
    ["expired_token", "expired"],
    ["bad_verification_code", "expired"],
    ["authorization_declined", "denied"],
    ["access_denied", "denied"],
  ])("maps %s to %s", async (error, status) => {
    respond = () => json({ error, error_description: "AADSTS70016: ..." }, 400);
    expect(await poll()).toEqual({ status });
  });

  it("returns tokens and the address from the id_token", async () => {
    respond = () =>
      json({
        token_type: "Bearer",
        scope: "https://outlook.office.com/IMAP.AccessAsUser.All",
        access_token: "EwB-access",
        refresh_token: "M.C1-refresh",
        id_token: idToken({ aud: clientId, email: "Priya@Outlook.com", preferred_username: "priya@outlook.com" }),
      });
    expect(await poll()).toEqual({ status: "ok", accessToken: "EwB-access", refreshToken: "M.C1-refresh", email: "priya@outlook.com" });
    expect(calls[0]!.url).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/token");
    expect(Object.fromEntries(calls[0]!.body)).toEqual({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", client_id: clientId, device_code: "DAQABAAEAAAD" });
  });

  it("falls back to preferred_username, then null", async () => {
    respond = () => json({ access_token: "a", refresh_token: "r", id_token: idToken({ preferred_username: "priya@contoso.onmicrosoft.com" }) });
    expect(await poll()).toMatchObject({ email: "priya@contoso.onmicrosoft.com" });
    respond = () => json({ access_token: "a", refresh_token: "r", id_token: "not-a-jwt" });
    expect(await poll()).toMatchObject({ status: "ok", email: null });
    respond = () => json({ access_token: "a", refresh_token: "r" });
    expect(await poll()).toMatchObject({ status: "ok", email: null });
  });

  it("requires a refresh token and the IMAP permission", async () => {
    respond = () => json({ access_token: "a", scope: "https://outlook.office.com/IMAP.AccessAsUser.All" });
    await expect(poll()).rejects.toBeInstanceOf(MailAuthError);
    respond = () => json({ access_token: "a", refresh_token: "r", scope: "openid email" });
    await expect(poll()).rejects.toThrow(/IMAP/);
  });
});

describe("microsoftAccessToken", () => {
  const refresh = () => microsoftAccessToken({ clientId, tenant: "common", refreshToken: "M.C1-old-refresh" });

  it("returns the rotated refresh token", async () => {
    respond = () => json({ access_token: "EwB-new", refresh_token: "M.C1-new-refresh", scope: "https://outlook.office.com/IMAP.AccessAsUser.All" });
    expect(await refresh()).toEqual({ accessToken: "EwB-new", refreshToken: "M.C1-new-refresh" });
    expect(Object.fromEntries(calls[0]!.body)).toEqual({ grant_type: "refresh_token", client_id: clientId, refresh_token: "M.C1-old-refresh", scope: MICROSOFT_IMAP_SCOPE });
    respond = () => json({ access_token: "EwB-new" });
    expect(await refresh()).toEqual({ accessToken: "EwB-new", refreshToken: null });
  });

  it("maps invalid_grant to MailAuthError without secrets", async () => {
    respond = () => json({ error: "invalid_grant", error_description: "AADSTS70000: The refresh token has expired. M.C1-old-refresh" }, 400);
    const err = await refresh().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MailAuthError);
    expect((err as Error).message).toBe("Outlook access was revoked or has expired. Reconnect Outlook.");
  });

  it("maps 429 to MailTransientError", async () => {
    respond = () => json({ error: "too_many_requests" }, 429);
    await expect(refresh()).rejects.toBeInstanceOf(MailTransientError);
  });
});
