import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@applywise/database";
import { env } from "@/env";
import { automationSettingsService } from "@/server/services/automation-settings.service";
import { consentService } from "@/server/services/consent.service";
import { bareUser, disableTrackedUsers, onboardedUser } from "./automation-helpers";

/** Automation control centre: validation, rules versioning, scheduling, readiness blockers and the AUTO_APPLY consent. */

const SLOW = 120_000;
const update = automationSettingsService.update.bind(automationSettingsService);
const settingsRow = (userId: string) => prisma.automationSettings.findUniqueOrThrow({ where: { userId } });
const autoApplyConsentRow = (userId: string) => prisma.userConsent.findUnique({ where: { userId_type: { userId, type: "AUTO_APPLY" } } });

const TURNED_OFF = "Automation is turned off.";
const MANUAL_MODE = "Application mode is Manual: applications are prepared but never submitted automatically.";
const REVIEW_MODE = "Application mode is Review: applications are submitted only after you approve them.";
const NO_CONSENT = "Grant the auto-apply consent to let the automation submit applications for you.";
const NO_AUTO_PROVIDER = "None of your enabled job sources supports automatic submission on this server.";
const LIMIT_ZERO = "The daily application limit is 0.";

afterEach(() => {
  vi.unstubAllEnvs();
});
afterAll(disableTrackedUsers);

describe("validation", () => {
  it("enforces recommend <= minimum match <= auto-apply, also against the stored values", async () => {
    const u = await bareUser("settings-order");
    const invalid = [
      { recommendScore: 80, minMatchScore: 70 },
      { minMatchScore: 95 }, // stored auto-apply is 90
      { recommendScore: 75 }, // stored minimum is 70
      { autoApplyScore: 60 }, // stored minimum is 70
    ];
    for (const input of invalid) {
      await expect(update(u, input)).rejects.toMatchObject({ code: "VALIDATION_ERROR", status: 422, message: expect.stringContaining("recommend") });
    }
    expect(await settingsRow(u)).toMatchObject({ recommendScore: 50, minMatchScore: 70, autoApplyScore: 90, rulesVersion: 1 });

    // Equal thresholds are fine, and several thresholds moved together are checked against their new values.
    await expect(update(u, { recommendScore: 70, minMatchScore: 70, autoApplyScore: 70 })).resolves.toMatchObject({ recommendScore: 70, minMatchScore: 70, autoApplyScore: 70 });
    await expect(update(u, { recommendScore: 20, minMatchScore: 40, autoApplyScore: 60 })).resolves.toMatchObject({ recommendScore: 20, minMatchScore: 40, autoApplyScore: 60 });
  });

  it("enforces 0-100 scores and the server's daily cap in the service itself (not only in the request schema)", async () => {
    const u = await bareUser("settings-ranges");
    const cap = env().AUTOMATION_MAX_DAILY_LIMIT;
    for (const input of [{ autoApplyScore: 101 }, { recommendScore: -1 }, { minMatchScore: 70.5 }, { recommendScore: 0, minMatchScore: 0, autoApplyScore: 150 }]) {
      await expect(update(u, input), JSON.stringify(input)).rejects.toMatchObject({ code: "VALIDATION_ERROR", status: 422 });
    }
    for (const maxApplicationsPerDay of [-1, 2.5, cap + 1]) {
      await expect(update(u, { maxApplicationsPerDay }), String(maxApplicationsPerDay)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    }
    expect(await settingsRow(u)).toMatchObject({ recommendScore: 50, minMatchScore: 70, autoApplyScore: 90, maxApplicationsPerDay: 10, rulesVersion: 1 });
    // The bounds themselves are fine.
    await expect(update(u, { recommendScore: 0, autoApplyScore: 100, maxApplicationsPerDay: 0 })).resolves.toMatchObject({ recommendScore: 0, autoApplyScore: 100, maxApplicationsPerDay: 0 });
  });

  it("rejects unknown job sources, unknown timezones and daily limits above the server cap - before writing anything", async () => {
    const u = await bareUser("settings-invalid");
    const cap = env().AUTOMATION_MAX_DAILY_LIMIT;
    await expect(update(u, { enabledProviders: ["demo", "monster-jobs"] })).rejects.toMatchObject({ code: "VALIDATION_ERROR", message: "Unknown job source: monster-jobs." });
    await expect(update(u, { timezone: "Mars/Olympus_Mons" })).rejects.toMatchObject({ code: "VALIDATION_ERROR", fieldErrors: { timezone: [expect.any(String)] } });
    await expect(update(u, { maxApplicationsPerDay: cap + 1 })).rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining(`at most ${cap}`) });
    // The consent in the same (rejected) request is not granted either.
    await expect(update(u, { autoApplyConsent: true, mode: "AUTO", enabledProviders: ["nope"] })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(await autoApplyConsentRow(u)).toBeNull();
    expect(await settingsRow(u)).toMatchObject({ enabledProviders: [], timezone: "Asia/Kolkata", maxApplicationsPerDay: 10, mode: "MANUAL", rulesVersion: 1 });

    const view = await update(u, { enabledProviders: ["demo", "linkedin"], timezone: "Europe/Berlin", maxApplicationsPerDay: cap });
    expect(view).toMatchObject({ enabledProviders: ["demo", "linkedin"], timezone: "Europe/Berlin", maxApplicationsPerDay: cap });
    expect(view.status.dailyLimit).toBe(cap);
    // A limit stored above the cap (the operator lowered it later) is capped wherever it is used.
    await prisma.automationSettings.update({ where: { userId: u }, data: { maxApplicationsPerDay: 500 } });
    expect((await automationSettingsService.getView(u)).status.dailyLimit).toBe(cap);
  });
});

describe("rules version and scheduling", () => {
  it("bumps rulesVersion only when a rule-relevant value actually changes", async () => {
    const u = await bareUser("settings-version");
    const version = async () => (await settingsRow(u)).rulesVersion;
    await update(u, { minMatchScore: 70, maxJobAgeDays: 14 }); // unchanged values
    expect(await version()).toBe(1);
    await update(u, { notifyStrongMatches: false, quietHoursStart: 22 * 60, quietHoursEnd: 7 * 60, dailySummaryHour: 8, tailorResume: false, mode: "REVIEW" });
    expect(await version()).toBe(1);
    await update(u, { minMatchScore: 75 });
    expect(await version()).toBe(2);
    await update(u, { enabledProviders: ["demo"] });
    expect(await version()).toBe(3);
    await update(u, { enabledProviders: ["demo"] });
    expect(await version()).toBe(3);
    await update(u, { maxApplicationsPerDay: 5 });
    expect(await version()).toBe(4);
    await update(u, { rules: { excludedCompanies: ["Globex"] } });
    expect(await version()).toBe(5);
    await update(u, { rules: {} });
    expect(await version()).toBe(5);
    // Saving the rules form again with the same values changes nothing (earlier AUTO decisions stay valid).
    await update(u, { rules: { excludedCompanies: ["Globex"], requiredSkillsMode: "any", minSalary: null } });
    expect(await version()).toBe(5);
    await update(u, { rules: { excludedCompanies: ["Globex"], minSalary: 1_500_000 } });
    expect(await version()).toBe(6);
    expect((await automationSettingsService.getView(u)).rules.excludedCompanies).toEqual(["Globex"]);
  });

  it("turning automation on schedules a run right away; turning it off clears the schedule", async () => {
    const u = await bareUser("settings-schedule");
    const before = Date.now();
    let view = await update(u, { enabled: true });
    let row = await settingsRow(u);
    expect(row.nextRunAt!.getTime()).toBeGreaterThanOrEqual(before - 1_000);
    expect(row.nextRunAt!.getTime()).toBeLessThanOrEqual(Date.now());
    expect(view.status.nextRunAt).toBe(row.nextRunAt!.toISOString());

    view = await update(u, { enabled: false });
    row = await settingsRow(u);
    expect(row.nextRunAt).toBeNull();
    expect(view.status.nextRunAt).toBeNull();

    // A frequency change reschedules too.
    await prisma.automationSettings.update({ where: { userId: u }, data: { enabled: true, nextRunAt: new Date(Date.now() + 86_400_000) } });
    await update(u, { searchFrequencyMinutes: 60 });
    expect((await settingsRow(u)).nextRunAt!.getTime()).toBeLessThanOrEqual(Date.now());
  });
});

describe("readiness", () => {
  it("lists every blocker for a new account", async () => {
    const u = await bareUser("ready-new");
    const { readiness } = await automationSettingsService.getView(u);
    expect(readiness.canAutoApply).toBe(false);
    expect(readiness.blockers).toEqual([
      TURNED_OFF,
      MANUAL_MODE,
      NO_CONSENT,
      "Add your name and email to your profile.",
      "Verify your profile facts - only verified facts are ever used in applications.",
      "Upload and parse a resume.",
    ]);
  });

  it("an onboarded user in AUTO mode with consent is ready; each switch adds exactly its blocker", async () => {
    const u = await onboardedUser("ready");
    const blockers = async (input: Parameters<typeof update>[1]) => (await update(u, input)).readiness;

    expect(await blockers({ enabled: true, mode: "AUTO", autoApplyConsent: true })).toEqual({ canAutoApply: true, blockers: [] });
    expect(await blockers({ mode: "REVIEW" })).toEqual({ canAutoApply: false, blockers: [REVIEW_MODE] });
    expect(await blockers({ mode: "MANUAL" })).toEqual({ canAutoApply: false, blockers: [MANUAL_MODE] });
    expect(await blockers({ mode: "AUTO", enabled: false })).toEqual({ canAutoApply: false, blockers: [TURNED_OFF] });
    expect(await blockers({ enabled: true, autoApplyConsent: false })).toEqual({ canAutoApply: false, blockers: [NO_CONSENT] });
    // Only providers without automatic submission (job boards) enabled: nothing can be submitted.
    expect(await blockers({ autoApplyConsent: true, enabledProviders: ["linkedin", "naukri", "indeed"] })).toEqual({ canAutoApply: false, blockers: [NO_AUTO_PROVIDER] });
    expect(await blockers({ enabledProviders: ["linkedin", "demo"] })).toEqual({ canAutoApply: true, blockers: [] });
    expect(await blockers({ maxApplicationsPerDay: 0 })).toEqual({ canAutoApply: false, blockers: [LIMIT_ZERO] });
    expect(await blockers({ maxApplicationsPerDay: 10 })).toEqual({ canAutoApply: true, blockers: [] });

    // Without the demo provider this server has no automatic submission at all.
    vi.stubEnv("DEMO_PROVIDER_ENABLED", "false");
    expect((await automationSettingsService.getView(u)).readiness).toEqual({ canAutoApply: false, blockers: [NO_AUTO_PROVIDER] });
  }, SLOW);
});

describe("auto-apply consent", () => {
  it("granting and revoking it through the settings writes the AUTO_APPLY consent (not a rule change)", async () => {
    const u = await bareUser("settings-consent");
    let view = await update(u, { autoApplyConsent: true });
    let row = await autoApplyConsentRow(u);
    expect(row).toMatchObject({ granted: true, revokedAt: null });
    expect(row!.grantedAt).not.toBeNull();
    expect(view.autoApplyConsent).toBe(true);
    expect((await consentService.get(u)).autoApply).toBe(true);
    expect((await settingsRow(u)).rulesVersion).toBe(1);

    view = await update(u, { autoApplyConsent: false });
    row = await autoApplyConsentRow(u);
    expect(row).toMatchObject({ granted: false });
    expect(row!.revokedAt).not.toBeNull();
    expect(view.autoApplyConsent).toBe(false);
    expect((await consentService.get(u)).autoApply).toBe(false);
    expect(view.readiness.blockers).toContain(NO_CONSENT);

    // Both changes are audited: the consent change itself and the settings update that carried it.
    const consentAudits = await prisma.auditLog.findMany({ where: { userId: u, action: "consent.updated" }, orderBy: { createdAt: "asc" } });
    expect(consentAudits.map((a) => (a.metadata as { changes?: { autoApply?: boolean } }).changes?.autoApply)).toEqual([true, false]);
    const settingsAudits = await prisma.auditLog.findMany({ where: { userId: u, action: "automation.settings_updated" }, orderBy: { createdAt: "asc" } });
    expect(settingsAudits.map((a) => (a.metadata as { autoApplyConsent?: boolean }).autoApplyConsent)).toEqual([true, false]);
    // Leaving it out does not touch it.
    await update(u, { mode: "AUTO" });
    expect((await autoApplyConsentRow(u))!.granted).toBe(false);
  });
});
