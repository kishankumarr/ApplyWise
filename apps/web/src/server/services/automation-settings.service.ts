import "server-only";
import { prisma, type Prisma } from "@applywise/database";
import { providerInfos } from "@applywise/job-engine";
import type { AutomationReadiness, AutomationRuleConfig, AutomationRuleView, AutomationSettingsView } from "@applywise/types";
import type { AutomationSettingsUpdateInput } from "@applywise/validation";
import { env } from "@/env";
import { audit } from "../audit";
import { Errors } from "../errors";
import { inQuietHours, isValidTimeZone } from "./automation-time";
import { runSummary } from "./automation-runs.service";
import { consentService } from "./consent.service";
import { dailyLimitService } from "./daily-limit.service";

type SettingsRow = Prisma.AutomationSettingsGetPayload<object>;
type RuleRow = Prisma.AutomationRuleGetPayload<object>;

/** Fields whose change can alter a rule decision: pipeline applications are re-evaluated when they change. */
const RULE_FIELDS = ["recommendScore", "minMatchScore", "autoApplyScore", "maxJobAgeDays", "enabledProviders", "maxApplicationsPerDay"] as const;
const SCORE_FIELDS = ["recommendScore", "minMatchScore", "autoApplyScore"] as const;

const sameValue = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export function ruleView(r: RuleRow): AutomationRuleView {
  return {
    targetTitles: r.targetTitles,
    excludedTitles: r.excludedTitles,
    preferredCompanies: r.preferredCompanies,
    excludedCompanies: r.excludedCompanies,
    requiredSkills: r.requiredSkills,
    requiredSkillsMode: r.requiredSkillsMode === "all" ? "all" : "any",
    allowMissingMandatorySkills: r.allowMissingMandatorySkills,
    maxExperienceGapYears: r.maxExperienceGapYears,
    locationMode: r.locationMode === "any" ? "any" : "preferences",
    allowedWorkModes: r.allowedWorkModes,
    minSalary: r.minSalary,
    salaryCurrency: r.salaryCurrency,
    allowedApplyMethods: r.allowedApplyMethods,
  };
}

/** Merged configuration handed to the (pure) rule engine. */
export function ruleConfig(s: SettingsRow, r: RuleRow): AutomationRuleConfig {
  return {
    recommendScore: s.recommendScore,
    minMatchScore: s.minMatchScore,
    autoApplyScore: s.autoApplyScore,
    maxJobAgeDays: s.maxJobAgeDays,
    maxApplicationsPerDay: effectiveDailyLimit(s),
    enabledProviders: s.enabledProviders,
    ...ruleView(r),
  };
}

/** The user's daily limit, capped by the operator's AUTOMATION_MAX_DAILY_LIMIT. */
export function effectiveDailyLimit(s: Pick<SettingsRow, "maxApplicationsPerDay">): number {
  return Math.max(0, Math.min(s.maxApplicationsPerDay, env().AUTOMATION_MAX_DAILY_LIMIT));
}

/** Providers whose automatic submission works with this server's configuration. */
export function autoApplyProviderIds(): string[] {
  return providerInfos(process.env)
    .filter((p) => p.capabilities.AUTO_APPLY.status === "SUPPORTED" || p.capabilities.AUTO_APPLY.status === "EXPERIMENTAL")
    .map((p) => p.id);
}

export const automationSettingsService = {
  /** Get or create the user's settings and rule rows (defaults: automation off, MANUAL mode). */
  async ensure(userId: string): Promise<{ settings: SettingsRow; rule: RuleRow }> {
    // Settings (with rulesVersion) first, rules second: if a rules update commits in between, this evaluation is
    // stamped with the old version and re-evaluated next run - never new rules silently stamped as current.
    const settings = await prisma.automationSettings.upsert({ where: { userId }, create: { userId }, update: {} });
    const rule = await prisma.automationRule.upsert({ where: { userId }, create: { userId }, update: {} });
    return { settings, rule };
  },

  async readiness(userId: string, settings: SettingsRow): Promise<AutomationReadiness> {
    const blockers: string[] = [];
    if (!settings.enabled) blockers.push("Automation is turned off.");
    if (settings.mode === "MANUAL") blockers.push("Application mode is Manual: applications are prepared but never submitted automatically.");
    if (settings.mode === "REVIEW") blockers.push("Application mode is Review: applications are submitted only after you approve them.");
    const consents = await consentService.get(userId);
    if (!consents.autoApply) blockers.push("Grant the auto-apply consent to let the automation submit applications for you.");
    const autoIds = autoApplyProviderIds();
    const enabled = settings.enabledProviders.length ? autoIds.filter((id) => settings.enabledProviders.includes(id)) : autoIds;
    if (enabled.length === 0) blockers.push("None of your enabled job sources supports automatic submission on this server.");
    if (effectiveDailyLimit(settings) === 0) blockers.push("The daily application limit is 0.");
    const profile = await prisma.candidateProfile.findUnique({
      where: { userId },
      select: { fullName: true, email: true, _count: { select: { truthBankItems: { where: { status: { in: ["USER_VERIFIED", "USER_EDITED"] } } } } } },
    });
    if (!profile?.fullName || !profile.email) blockers.push("Add your name and email to your profile.");
    if (!profile || profile._count.truthBankItems === 0) blockers.push("Verify your profile facts - only verified facts are ever used in applications.");
    const resumes = await prisma.resumeVersion.count({ where: { userId, kind: { in: ["ORIGINAL", "EDITED"] } } });
    if (resumes === 0) blockers.push("Upload and parse a resume.");
    return { canAutoApply: blockers.length === 0, blockers };
  },

  async getView(userId: string, now = new Date()): Promise<AutomationSettingsView> {
    const { settings, rule } = await this.ensure(userId);
    const [consents, applicationsToday, lastRun, readiness] = await Promise.all([
      consentService.get(userId),
      dailyLimitService.countToday(userId, settings.timezone, now),
      prisma.automationRun.findFirst({ where: { userId }, orderBy: { startedAt: "desc" } }),
      this.readiness(userId, settings),
    ]);
    return {
      enabled: settings.enabled,
      mode: settings.mode,
      recommendScore: settings.recommendScore,
      minMatchScore: settings.minMatchScore,
      autoApplyScore: settings.autoApplyScore,
      maxApplicationsPerDay: settings.maxApplicationsPerDay,
      maxJobAgeDays: settings.maxJobAgeDays,
      searchFrequencyMinutes: settings.searchFrequencyMinutes,
      enabledProviders: settings.enabledProviders,
      quietHoursStart: settings.quietHoursStart,
      quietHoursEnd: settings.quietHoursEnd,
      timezone: settings.timezone,
      tailorResume: settings.tailorResume,
      generateCoverLetter: settings.generateCoverLetter,
      allowEmailApplications: settings.allowEmailApplications,
      notifyStrongMatches: settings.notifyStrongMatches,
      dailySummaryHour: settings.dailySummaryHour,
      rulesVersion: settings.rulesVersion,
      rules: ruleView(rule),
      autoApplyConsent: consents.autoApply,
      status: {
        lastRunAt: settings.lastRunAt?.toISOString() ?? null,
        nextRunAt: settings.enabled ? (settings.nextRunAt?.toISOString() ?? null) : null,
        running: !!settings.runLeaseUntil && settings.runLeaseUntil > now,
        applicationsToday,
        dailyLimit: effectiveDailyLimit(settings),
        inQuietHours: inQuietHours(settings, now),
        lastRun: lastRun ? runSummary(lastRun) : null,
      },
      readiness,
    };
  },

  async update(userId: string, input: AutomationSettingsUpdateInput, requestId?: string): Promise<AutomationSettingsView> {
    const { settings, rule } = await this.ensure(userId);
    if (input.timezone !== undefined && !isValidTimeZone(input.timezone)) throw Errors.validation("Unknown timezone.", { timezone: ["Use an IANA timezone such as Asia/Kolkata."] });
    // Enforced here too (not only by the request schema): every caller gets the same limits.
    for (const k of SCORE_FIELDS) {
      const v = input[k];
      if (v !== undefined && (!Number.isInteger(v) || v < 0 || v > 100)) throw Errors.validation("Scores must be whole numbers from 0 to 100.", { [k]: ["Use a whole number from 0 to 100."] });
    }
    const recommend = input.recommendScore ?? settings.recommendScore;
    const min = input.minMatchScore ?? settings.minMatchScore;
    const auto = input.autoApplyScore ?? settings.autoApplyScore;
    if (recommend > min || min > auto) throw Errors.validation("Scores must satisfy: recommend ≤ minimum match ≤ auto-apply.");
    const cap = env().AUTOMATION_MAX_DAILY_LIMIT;
    if (input.maxApplicationsPerDay !== undefined && (!Number.isInteger(input.maxApplicationsPerDay) || input.maxApplicationsPerDay < 0 || input.maxApplicationsPerDay > cap)) {
      throw Errors.validation(`The daily limit on this server is at most ${cap}.`, { maxApplicationsPerDay: [`Use a whole number from 0 to ${cap}.`] });
    }
    if (input.enabledProviders) {
      const known = new Set(providerInfos(process.env).map((p) => p.id));
      const unknown = input.enabledProviders.filter((p) => !known.has(p));
      if (unknown.length) throw Errors.validation(`Unknown job source: ${unknown.join(", ")}.`);
    }
    // AUTO mode is only meaningful with the standing consent; granting it is part of the same explicit action.
    if (input.autoApplyConsent !== undefined) await consentService.update(userId, { autoApply: input.autoApplyConsent }, requestId);

    const { rules, autoApplyConsent: _consent, ...fields } = input;
    // The rules version (which invalidates earlier AUTO_ELIGIBLE decisions) moves only when a value really changes.
    const ruleChanged = !!rules && (Object.keys(rules) as (keyof typeof rules)[]).some((k) => rules[k] !== undefined && !sameValue(rules[k], rule[k]));
    const thresholdChanged = RULE_FIELDS.some((k) => input[k] !== undefined && !sameValue(input[k], settings[k]));
    const enabling = input.enabled === true && !settings.enabled;
    const frequencyChanged = input.searchFrequencyMinutes !== undefined && input.searchFrequencyMinutes !== settings.searchFrequencyMinutes;
    await prisma.$transaction(async (tx) => {
      if (ruleChanged) await tx.automationRule.update({ where: { userId }, data: rules });
      await tx.automationSettings.update({
        where: { userId },
        data: {
          ...fields,
          ...(ruleChanged || thresholdChanged ? { rulesVersion: { increment: 1 } } : {}),
          // Turning automation on (or changing the frequency) schedules the next run right away.
          ...(enabling || frequencyChanged ? { nextRunAt: new Date() } : {}),
          ...(input.enabled === false ? { nextRunAt: null } : {}),
        },
      });
    });
    await audit(userId, "automation.settings_updated", {
      requestId,
      entityType: "AutomationSettings",
      metadata: { fields: Object.keys(fields), rules: rules ? Object.keys(rules) : [], mode: input.mode ?? null, enabled: input.enabled ?? null, autoApplyConsent: input.autoApplyConsent ?? null },
    });
    return this.getView(userId);
  },
};
