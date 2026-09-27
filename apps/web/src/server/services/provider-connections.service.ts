import "server-only";
import { getProvider, type JobProvider, type ProviderEnv } from "@applywise/job-engine";
import { prisma, type ProviderAuthType, type ProviderConnection } from "@applywise/database";
import type { ProviderConnectionView } from "@applywise/types";
import { audit } from "../audit";
import { decryptText, encryptText } from "../crypto";
import { Errors } from "../errors";
import { logger } from "../logger";
import { dayKey } from "./automation-time";
import { notificationService } from "./notification.service";

/**
 * Provider connections: encrypted API keys / OAuth tokens for providers that officially offer them (never
 * job-platform passwords or cookies). Secrets are AES-256-GCM encrypted (ProviderConnection.secretEnc), decrypted
 * only for a single executor call, never returned to the client and never logged.
 */

const MAX_TOKEN_LENGTH = 4096;

function providerEnv(): ProviderEnv {
  return { ...process.env };
}

export function connectionView(row: ProviderConnection): ProviderConnectionView {
  return {
    status: row.status,
    authType: row.authType,
    accountLabel: row.accountLabel,
    lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
    lastError: row.lastError,
    expiresAt: row.expiresAt?.toISOString() ?? null,
  };
}

/** Never show a full identifier: "ka***@example.com", "Key ending 1a2b". */
export function maskAccountLabel(label: string | null | undefined, token: string): string {
  const given = label?.trim().replace(/\s+/g, " ").slice(0, 80);
  if (given) {
    const at = given.indexOf("@");
    if (at > 0) return `${given.slice(0, Math.min(2, at))}***${given.slice(at)}`;
    return given;
  }
  return token.length >= 12 ? `Key ending ${token.slice(-4)}` : "API key";
}

function resolveProvider(providerId: string): { provider: JobProvider; label: string; auth: string } {
  const provider = getProvider(providerId);
  if (!provider) throw Errors.notFound("Provider");
  const info = provider.info(providerEnv());
  return { provider, label: info.label, auth: info.auth };
}

/** One "reconnect" notification per provider per day, whichever path noticed the problem first. */
function authDedupeKey(providerId: string, at: Date): string {
  return `provider-auth:${providerId}:${dayKey(at, "UTC")}`;
}

function labelFor(providerId: string): string {
  try {
    return getProvider(providerId)?.info(providerEnv()).label ?? providerId;
  } catch {
    return providerId;
  }
}

export const providerConnectionsService = {
  async list(userId: string): Promise<Record<string, ProviderConnectionView>> {
    const rows = await prisma.providerConnection.findMany({ where: { userId }, orderBy: { provider: "asc" } });
    return Object.fromEntries(rows.map((r) => [r.provider, connectionView(r)]));
  },

  /**
   * Store the user's API key / access token. Only providers that officially authenticate with one (auth api_key or
   * oauth_token) accept it: for "none" providers it would never be used, for "not_supported" ones it would be a
   * job-platform credential. Reconnecting resumes the applications that were paused while the connection was broken.
   */
  async connect(userId: string, providerId: string, input: { token: string; accountLabel?: string | null; expiresAt?: string | null }, requestId?: string): Promise<ProviderConnectionView> {
    const { label, auth } = resolveProvider(providerId);
    if (auth === "none") {
      throw Errors.validation(`${label} needs no account connection - nothing is stored.`);
    }
    if (auth !== "api_key" && auth !== "oauth_token") {
      throw Errors.validation(`${label}: this provider does not support account connections; job-platform passwords are never stored.`);
    }
    const token = (input.token ?? "").trim();
    if (!token) throw Errors.validation("Enter the API key or access token.", { token: ["Required"] });
    if (token.length > MAX_TOKEN_LENGTH) throw Errors.validation("That key is too long.", { token: ["Too long"] });
    let expiresAt: Date | null = null;
    if (input.expiresAt) {
      expiresAt = new Date(input.expiresAt);
      if (Number.isNaN(expiresAt.getTime())) throw Errors.validation("Invalid expiry date.", { expiresAt: ["Invalid date"] });
      if (expiresAt.getTime() <= Date.now()) throw Errors.validation("This token has already expired.", { expiresAt: ["In the past"] });
    }
    const authType: ProviderAuthType = auth === "oauth_token" ? "OAUTH_TOKEN" : "API_KEY";
    const data = {
      authType,
      status: "CONNECTED" as const,
      secretEnc: encryptText(token),
      accountLabel: maskAccountLabel(input.accountLabel, token),
      expiresAt,
      lastCheckedAt: new Date(),
      lastError: null,
      consecutiveFailures: 0,
    };
    const row = await prisma.providerConnection.upsert({
      where: { userId_provider: { userId, provider: providerId } },
      create: { userId, provider: providerId, ...data },
      update: data,
    });
    await audit(userId, "provider.connected", { requestId, entityType: "ProviderConnection", entityId: row.id, metadata: { provider: providerId, authType } });
    // Applications held while the credential was broken go out again (each re-checked by the execution service).
    // Imported lazily: the execution service itself depends on this module.
    const { applicationExecutionService } = await import("./application-execution.service");
    await applicationExecutionService.resumePausedForProvider(userId, providerId);
    return connectionView(row);
  },

  async disconnect(userId: string, providerId: string, requestId?: string): Promise<{ removed: boolean }> {
    const res = await prisma.providerConnection.deleteMany({ where: { userId, provider: providerId } });
    if (res.count > 0) await audit(userId, "provider.disconnected", { requestId, entityType: "ProviderConnection", metadata: { provider: providerId } });
    return { removed: res.count > 0 };
  },

  /** Decrypted credential for one executor call; null when not connected or expired (marks NEEDS_ATTENTION). */
  async credentialFor(userId: string, providerId: string, now = new Date()): Promise<{ token: string } | null> {
    const row = await prisma.providerConnection.findUnique({ where: { userId_provider: { userId, provider: providerId } } });
    if (!row || row.status !== "CONNECTED" || !row.secretEnc) return null;
    if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) {
      const moved = await prisma.providerConnection.updateMany({
        where: { id: row.id, status: "CONNECTED" },
        data: { status: "NEEDS_ATTENTION", lastError: "The saved access token expired.", lastCheckedAt: now },
      });
      if (moved.count === 1) {
        const label = labelFor(providerId);
        await notificationService.notify(userId, {
          type: "provider.needs_attention",
          title: `Reconnect ${label}`,
          body: `The saved ${label} access token expired. Automatic applications through ${label} are paused until you reconnect it in Job sources.`,
          link: "/jobs/sources",
          dedupeKey: authDedupeKey(providerId, now),
        });
      }
      return null;
    }
    try {
      return { token: decryptText(row.secretEnc) };
    } catch (e) {
      // Never log the value; the key rotated or the row is corrupt - the user has to reconnect.
      logger.warn("provider.credential_unreadable", { userId, provider: providerId, error: e instanceof Error ? e.name : "unknown" });
      await prisma.providerConnection.updateMany({ where: { id: row.id }, data: { status: "ERROR", lastError: "The saved credential could not be read - reconnect this provider.", lastCheckedAt: now } });
      return null;
    }
  },

  /** The provider rejected the credential: NEEDS_ATTENTION + one notification; the automation stops retrying. */
  async markAuthFailed(userId: string, providerId: string, detail: string): Promise<void> {
    const safeDetail = detail.replace(/\s+/g, " ").trim().slice(0, 300) || "The provider rejected the saved credential.";
    const before = await prisma.providerConnection.findUnique({ where: { userId_provider: { userId, provider: providerId } }, select: { status: true } });
    if (!before) return;
    const res = await prisma.providerConnection.updateMany({
      where: { userId, provider: providerId },
      data: { status: "NEEDS_ATTENTION", lastError: safeDetail, consecutiveFailures: { increment: 1 }, lastCheckedAt: new Date() },
    });
    if (res.count === 0) return;
    const row = await prisma.providerConnection.findUnique({ where: { userId_provider: { userId, provider: providerId } }, select: { id: true, updatedAt: true, consecutiveFailures: true } });
    // Notify when the connection breaks (the dedupe key also caps it at one per provider per day under races).
    if (before.status !== "NEEDS_ATTENTION") {
      const label = labelFor(providerId);
      await notificationService.notify(userId, {
        type: "provider.needs_attention",
        title: `Reconnect ${label}`,
        body: `${label} rejected the saved credential. Automatic applications through ${label} are paused until you reconnect it in Job sources.`,
        link: "/jobs/sources",
        dedupeKey: authDedupeKey(providerId, row?.updatedAt ?? new Date()),
      });
    }
    await audit(userId, "provider.auth_failed", {
      entityType: "ProviderConnection",
      ...(row ? { entityId: row.id } : {}),
      metadata: { provider: providerId, consecutiveFailures: row?.consecutiveFailures ?? null },
    });
  },

  async statusFor(userId: string, providerId: string): Promise<ProviderConnectionView | null> {
    const row = await prisma.providerConnection.findUnique({ where: { userId_provider: { userId, provider: providerId } } });
    return row ? connectionView(row) : null;
  },
};
