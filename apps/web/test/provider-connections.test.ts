import { describe, expect, it, vi } from "vitest";
import { prisma } from "@applywise/database";
import type * as JobEngine from "@applywise/job-engine";
import type { JobProvider } from "@applywise/job-engine";
import type { ProviderAuthMode, ProviderInfo } from "@applywise/types";
import { maskAccountLabel, providerConnectionsService } from "@/server/services/provider-connections.service";

// The provider registry belongs to another workstream: inject fake providers with each auth mode.
const h = vi.hoisted(() => ({ auth: {} as Record<string, string> }));

vi.mock("@applywise/job-engine", async (importOriginal) => {
  const actual = await importOriginal<typeof JobEngine>();
  return {
    ...actual,
    getProvider: (id: string): JobProvider | null => {
      const auth = h.auth[id];
      if (!auth) return null;
      const cap = { status: "AVAILABLE" as const, via: null, note: "" };
      const info: ProviderInfo = {
        id,
        label: `Fake ${id}`,
        kind: "ats",
        platforms: ["OTHER"],
        auth: auth as ProviderAuthMode,
        capabilities: { DISCOVERY: cap, DETAIL_FETCH: cap, QUESTION_EXTRACTION: cap, AUTO_APPLY: cap, STATUS_TRACKING: cap },
        manualOnly: false,
        externalRequirements: [],
        notes: [],
        demo: false,
      };
      return { id, info: () => info, matchesJob: () => false };
    },
  };
});
h.auth["acme-key"] = "api_key";
h.auth["acme-oauth"] = "oauth_token";
h.auth["jobboard"] = "not_supported";
h.auth["public-board"] = "none";

const TOKEN = "sk-test-0123456789abcdef";

async function newUser(label: string): Promise<string> {
  const user = await prisma.user.create({ data: { email: `conn-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.test`, passwordHash: "unused-in-tests" } });
  return user.id;
}

describe("provider connections", () => {
  it("stores the token encrypted and never returns it", async () => {
    const u = await newUser("encrypt");
    const view = await providerConnectionsService.connect(u, "acme-key", { token: `  ${TOKEN}  ` }, "req-1");
    expect(view).toMatchObject({ status: "CONNECTED", authType: "API_KEY", accountLabel: "Key ending cdef", lastError: null, expiresAt: null });
    const row = await prisma.providerConnection.findUniqueOrThrow({ where: { userId_provider: { userId: u, provider: "acme-key" } } });
    expect(row.secretEnc).toMatch(/^v1:/);
    expect(row.secretEnc).not.toBe(TOKEN);
    expect(row.secretEnc).not.toContain(TOKEN);
    expect(row.secretEnc).not.toContain(Buffer.from(TOKEN).toString("base64"));

    const listed = await providerConnectionsService.list(u);
    expect(Object.keys(listed)).toEqual(["acme-key"]);
    const json = JSON.stringify(listed) + JSON.stringify(await providerConnectionsService.statusFor(u, "acme-key"));
    expect(json).not.toContain(TOKEN);
    expect(json).not.toContain(row.secretEnc!);
    expect(json).not.toContain("secretEnc");

    const audits = await prisma.auditLog.findMany({ where: { userId: u, action: "provider.connected" } });
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits)).not.toContain(TOKEN);

    await expect(providerConnectionsService.credentialFor(u, "acme-key")).resolves.toEqual({ token: TOKEN });
    // OAuth providers are recorded as such; account labels are masked.
    const oauth = await providerConnectionsService.connect(u, "acme-oauth", { token: "oauth-token-value-123", accountLabel: "asha.rao@example.test" });
    expect(oauth).toMatchObject({ authType: "OAUTH_TOKEN", accountLabel: "as***@example.test" });
    expect(maskAccountLabel(null, "short")).toBe("API key");
  });

  it("refuses providers without account connections, empty tokens and unknown providers", async () => {
    const u = await newUser("refuse");
    await expect(providerConnectionsService.connect(u, "jobboard", { token: TOKEN })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringContaining("job-platform passwords are never stored"),
    });
    await expect(providerConnectionsService.connect(u, "acme-key", { token: "   " })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(providerConnectionsService.connect(u, "acme-key", { token: TOKEN, expiresAt: "2000-01-01T00:00:00Z" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(providerConnectionsService.connect(u, "nope", { token: TOKEN })).rejects.toMatchObject({ code: "NOT_FOUND" });
    // A provider without authentication would never use a token: nothing is stored for it.
    await expect(providerConnectionsService.connect(u, "public-board", { token: TOKEN })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringContaining("needs no account connection"),
    });
    await expect(providerConnectionsService.credentialFor(u, "public-board")).resolves.toBeNull();
    expect(await prisma.providerConnection.count({ where: { userId: u } })).toBe(0);
    await expect(providerConnectionsService.credentialFor(u, "acme-key")).resolves.toBeNull();
  });

  it("an expired token moves to NEEDS_ATTENTION with a single notification", async () => {
    const u = await newUser("expired");
    await providerConnectionsService.connect(u, "acme-key", { token: TOKEN, expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    await prisma.providerConnection.update({ where: { userId_provider: { userId: u, provider: "acme-key" } }, data: { expiresAt: new Date(Date.now() - 1_000) } });
    await expect(providerConnectionsService.credentialFor(u, "acme-key")).resolves.toBeNull();
    await expect(providerConnectionsService.credentialFor(u, "acme-key")).resolves.toBeNull();
    expect(await providerConnectionsService.statusFor(u, "acme-key")).toMatchObject({ status: "NEEDS_ATTENTION" });
    expect(await prisma.notification.count({ where: { userId: u, type: "provider.needs_attention" } })).toBe(1);
  });

  it("an auth failure marks NEEDS_ATTENTION, counts failures and notifies once a day", async () => {
    const u = await newUser("authfail");
    await providerConnectionsService.connect(u, "acme-key", { token: TOKEN });
    await providerConnectionsService.markAuthFailed(u, "acme-key", "401 Unauthorized");
    await providerConnectionsService.markAuthFailed(u, "acme-key", "401 Unauthorized");
    const row = await prisma.providerConnection.findUniqueOrThrow({ where: { userId_provider: { userId: u, provider: "acme-key" } } });
    expect(row).toMatchObject({ status: "NEEDS_ATTENTION", consecutiveFailures: 2, lastError: "401 Unauthorized" });
    expect(await prisma.notification.count({ where: { userId: u, type: "provider.needs_attention" } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { userId: u, action: "provider.auth_failed" } })).toBe(2);
    // No credential is handed out until the user reconnects.
    await expect(providerConnectionsService.credentialFor(u, "acme-key")).resolves.toBeNull();
    await providerConnectionsService.connect(u, "acme-key", { token: `${TOKEN}-new` });
    expect(await providerConnectionsService.statusFor(u, "acme-key")).toMatchObject({ status: "CONNECTED", lastError: null });
  });

  it("disconnect deletes the secret", async () => {
    const u = await newUser("disconnect");
    await providerConnectionsService.connect(u, "acme-key", { token: TOKEN });
    await expect(providerConnectionsService.disconnect(u, "acme-key")).resolves.toEqual({ removed: true });
    await expect(providerConnectionsService.disconnect(u, "acme-key")).resolves.toEqual({ removed: false });
    expect(await prisma.providerConnection.count({ where: { userId: u } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { userId: u, action: "provider.disconnected" } })).toBe(1);
    await expect(providerConnectionsService.statusFor(u, "acme-key")).resolves.toBeNull();
  });
});
