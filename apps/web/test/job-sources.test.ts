import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@applywise/database";
import { decryptText } from "@/server/crypto";
import { automationSettingsService } from "@/server/services/automation-settings.service";
import { demoAutomationService } from "@/server/services/demo-automation.service";
import { jobSourcesService } from "@/server/services/job-sources.service";
import { providerConnectionsService } from "@/server/services/provider-connections.service";
import { bareUser, connectDemo, disableTrackedUsers } from "./automation-helpers";

/** Settings -> Job sources cards: honest capability statuses per provider, connections without secrets. */

const cardsById = async (userId: string) => new Map((await jobSourcesService.cards(userId)).map((c) => [c.id, c]));

afterEach(() => {
  vi.unstubAllEnvs();
});
afterAll(disableTrackedUsers);

describe("job sources cards", () => {
  it("reports honest statuses: job boards are manual-only, only the demo provider (and delivering email) auto-applies", async () => {
    const u = await bareUser("sources-new");
    const cards = await jobSourcesService.cards(u);
    const byId = new Map(cards.map((c) => [c.id, c]));

    for (const id of ["linkedin", "naukri", "indeed"]) {
      expect(byId.get(id)).toMatchObject({
        auth: "not_supported",
        manualOnly: true,
        cardStatus: "MANUAL_ONLY",
        connection: null,
        feeds: 0,
        capabilities: { AUTO_APPLY: { status: "EXTERNAL_LIMITATION" }, DISCOVERY: { status: "LIMITED" } },
      });
    }
    // Nothing but the demo provider (and email applications with a delivering email provider) claims SUPPORTED.
    const supported = cards.filter((c) => c.capabilities.AUTO_APPLY.status === "SUPPORTED").map((c) => c.id);
    expect(supported).toContain("demo");
    expect(supported.filter((id) => id !== "demo" && id !== "email_application")).toEqual([]);
    // The dev outbox never reaches employers: email applications are only LIMITED on this server.
    expect(byId.get("email_application")!.capabilities.AUTO_APPLY.status).toBe("LIMITED");
    // manualOnly is exactly "cannot submit automatically".
    for (const c of cards) expect(c.manualOnly).toBe(!["SUPPORTED", "EXPERIMENTAL"].includes(c.capabilities.AUTO_APPLY.status));
    // ATS boards need the employer's credentials (or the operator's experimental browser opt-in).
    for (const id of ["greenhouse", "lever", "smartrecruiters", "workday"]) expect(byId.get(id)!.manualOnly).toBe(true);
    // The demo provider needs its (API key) connection first; every source is enabled for automation by default.
    expect(byId.get("demo")).toMatchObject({ auth: "api_key", cardStatus: "NEEDS_AUTHENTICATION", connection: null, feeds: 0, demo: true });
    expect(cards.every((c) => c.enabledForAutomation)).toBe(true);
  });

  it("shows the demo source CONNECTED after setup and never exposes the secret", async () => {
    const u = await bareUser("sources-demo");
    await demoAutomationService.setup(u, { run: false });
    const cards = await jobSourcesService.cards(u);
    const demo = cards.find((c) => c.id === "demo")!;
    expect(demo).toMatchObject({
      cardStatus: "CONNECTED",
      feeds: 1,
      jobsFound: 0,
      connection: { status: "CONNECTED", authType: "API_KEY", accountLabel: "Demo account (fictional)", lastError: null, expiresAt: null },
    });

    const row = await prisma.providerConnection.findUniqueOrThrow({ where: { userId_provider: { userId: u, provider: "demo" } } });
    const token = decryptText(row.secretEnc!);
    expect(token).toMatch(/^demo-/);
    const json = JSON.stringify(cards);
    expect(json).not.toContain(token);
    expect(json).not.toContain(row.secretEnc!);
    expect(json).not.toContain("secretEnc");
    expect(JSON.stringify(await prisma.auditLog.findMany({ where: { userId: u } }))).not.toContain(token);

    // Setup is idempotent: still one feed and one connection (the token is not replaced).
    await demoAutomationService.setup(u, { run: false });
    expect((await cardsById(u)).get("demo")!.feeds).toBe(1);
    expect(await prisma.providerConnection.count({ where: { userId: u } })).toBe(1);
    expect((await prisma.providerConnection.findUniqueOrThrow({ where: { id: row.id } })).secretEnc).toBe(row.secretEnc);
  });

  it("asks to reconnect a rejected or expired connection, and reflects the sources enabled for automation", async () => {
    const u = await bareUser("sources-attention");
    await connectDemo(u);
    expect((await cardsById(u)).get("demo")!.cardStatus).toBe("CONNECTED");

    await providerConnectionsService.markAuthFailed(u, "demo", "401 Unauthorized");
    const demo = (await cardsById(u)).get("demo")!;
    expect(demo.cardStatus).toBe("NEEDS_AUTHENTICATION");
    expect(demo.connection).toMatchObject({ status: "NEEDS_ATTENTION", lastError: "401 Unauthorized" });

    await automationSettingsService.update(u, { enabledProviders: ["demo", "linkedin"] });
    const enabled = [...(await cardsById(u)).values()].filter((c) => c.enabledForAutomation).map((c) => c.id);
    expect(enabled.sort()).toEqual(["demo", "linkedin"]);
  });

  it("hides the demo source when the operator disables the demo provider", async () => {
    const u = await bareUser("sources-no-demo");
    vi.stubEnv("DEMO_PROVIDER_ENABLED", "false");
    const cards = await jobSourcesService.cards(u);
    expect(cards.some((c) => c.id === "demo")).toBe(false);
    expect(cards.filter((c) => c.capabilities.AUTO_APPLY.status === "SUPPORTED").map((c) => c.id)).toEqual([]);
    await expect(demoAutomationService.setup(u, { run: false })).rejects.toMatchObject({ code: "PROVIDER_NOT_CONFIGURED" });
  });
});
