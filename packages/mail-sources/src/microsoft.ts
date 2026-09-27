import { MailAuthError, MailTransientError } from "./errors";
import { formPost, isRetryableStatus, requestJson, str, type JsonResponse } from "./http";
import { decodeJwtClaims } from "./oauth";

/**
 * Outlook.com, Hotmail and Microsoft 365: OAuth only (basic auth for IMAP is off). Device-code sign-in
 * with a public client (no secret, no redirect URI), then IMAP over SASL XOAUTH2.
 */
export const MICROSOFT_IMAP_SCOPE = "https://outlook.office.com/IMAP.AccessAsUser.All offline_access";
/** OIDC scopes may be combined with any resource's scopes; they add an id_token carrying the address. */
const DEVICE_SCOPE = `${MICROSOFT_IMAP_SCOPE} openid email`;
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const RECONNECT = "Outlook access was revoked or has expired. Reconnect Outlook.";

export async function microsoftStartDeviceCode(p: { clientId: string; tenant?: string }): Promise<{
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
  message: string;
}> {
  const r = await requestJson(`${authority(p.tenant)}/devicecode`, formPost({ client_id: p.clientId, scope: DEVICE_SCOPE }), "Microsoft");
  if (!r.ok) throw msError(r);
  const deviceCode = str(r.data.device_code);
  const userCode = str(r.data.user_code);
  const verificationUri = str(r.data.verification_uri);
  if (!deviceCode || !userCode || !verificationUri) throw new MailTransientError("Microsoft returned an incomplete sign-in response. Try again.");
  const expiresIn = positive(r.data.expires_in, 900);
  return {
    deviceCode,
    userCode,
    verificationUri,
    expiresIn,
    interval: positive(r.data.interval, 5),
    message: str(r.data.message) ?? `To sign in, open ${verificationUri} and enter the code ${userCode}.`,
  };
}

/** One poll of the device-code grant. Callers wait `interval` seconds between polls (longer after slow_down). */
export async function microsoftPollDeviceCode(p: {
  clientId: string;
  tenant?: string;
  deviceCode: string;
}): Promise<{ status: "pending" | "slow_down" | "expired" | "denied" } | { status: "ok"; refreshToken: string; accessToken: string; email: string | null }> {
  const r = await requestJson(
    `${authority(p.tenant)}/token`,
    formPost({ grant_type: DEVICE_GRANT, client_id: p.clientId, device_code: p.deviceCode }),
    "Microsoft",
  );
  if (!r.ok) {
    const code = str(r.data.error) ?? "";
    if (code === "authorization_pending") return { status: "pending" };
    if (code === "slow_down") return { status: "slow_down" };
    if (code === "expired_token" || code === "bad_verification_code" || code === "invalid_grant") return { status: "expired" };
    if (code === "authorization_declined" || code === "access_denied") return { status: "denied" };
    throw msError(r);
  }
  const accessToken = str(r.data.access_token);
  const refreshToken = str(r.data.refresh_token);
  if (!accessToken) throw new MailTransientError("Microsoft returned an incomplete sign-in response. Try again.");
  if (!refreshToken) throw new MailAuthError("Microsoft did not grant offline access. Sign in again and accept all requested permissions.");
  const scope = str(r.data.scope);
  if (scope && !/IMAP\.AccessAsUser\.All/i.test(scope)) {
    throw new MailAuthError("Microsoft did not grant mailbox (IMAP) access. Sign in again and accept all requested permissions.");
  }
  return { status: "ok", accessToken, refreshToken, email: emailFromIdToken(str(r.data.id_token)) };
}

/** Access token for IMAP. Microsoft rotates refresh tokens: store `refreshToken` when it is not null. */
export async function microsoftAccessToken(p: { clientId: string; tenant?: string; refreshToken: string }): Promise<{ accessToken: string; refreshToken: string | null }> {
  const r = await requestJson(
    `${authority(p.tenant)}/token`,
    formPost({ grant_type: "refresh_token", client_id: p.clientId, refresh_token: p.refreshToken, scope: MICROSOFT_IMAP_SCOPE }),
    "Microsoft",
  );
  if (!r.ok) throw msError(r);
  const accessToken = str(r.data.access_token);
  if (!accessToken) throw new MailTransientError("Microsoft returned an incomplete token response. It will be retried.");
  return { accessToken, refreshToken: str(r.data.refresh_token) };
}

// ---------------------------------------------------------------- internals

function authority(tenant: string | undefined): string {
  const t = tenant?.trim() || "common";
  // A tenant is a GUID, a domain or common/consumers/organizations; anything else (".." included) could alter the URL path.
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}))*$/.test(t) || t.length > 100) {
    throw new MailAuthError("The Microsoft tenant setting is invalid. Use common, consumers, organizations or a tenant ID.");
  }
  return `https://login.microsoftonline.com/${t}/oauth2/v2.0`;
}

/** Maps { error, error_description } (AADSTS details are never shown). */
function msError(r: JsonResponse): MailAuthError | MailTransientError {
  const code = str(r.data.error) ?? "";
  if (isRetryableStatus(r.status) || code === "temporarily_unavailable") {
    return new MailTransientError("Microsoft sign-in is temporarily unavailable. It will be retried.", r.retryAfterSec, String(r.status));
  }
  if (["invalid_grant", "interaction_required", "consent_required", "login_required"].includes(code)) return new MailAuthError(RECONNECT);
  if (code === "invalid_client" || code === "unauthorized_client") {
    return new MailAuthError(
      "Microsoft rejected this server's app registration. Check the Outlook client ID and that public client flows are allowed for the app.",
    );
  }
  if (code === "invalid_scope") return new MailAuthError("The Microsoft app registration cannot request mailbox (IMAP) access.");
  const safe = /^[a-z_]{1,40}$/.test(code) ? ` (${code})` : "";
  return new MailAuthError(`Microsoft sign-in failed${safe}. Reconnect Outlook.`);
}

function emailFromIdToken(idToken: string | null): string | null {
  const claims = decodeJwtClaims(idToken);
  for (const key of ["email", "preferred_username"]) {
    const v = claims[key];
    if (typeof v === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return v.toLowerCase();
  }
  return null;
}

function positive(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback;
}
