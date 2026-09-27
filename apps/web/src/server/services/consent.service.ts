import "server-only";
import { describeAiProvider } from "@applywise/ai";
import { prisma, type ConsentType } from "@applywise/database";
import type { ConsentUpdateInput } from "@applywise/validation";
import { audit } from "../audit";
import { Errors } from "../errors";

export const CONSENT_VERSION = "2026-09";

/**
 * AI consent is recorded together with the kind of provider it was given for ("local" = the
 * model runs on this server, "external" = data goes to a third party). Consent given for a local
 * model does not cover an external provider: after such a switch the user must opt in again.
 * Rows without a scope (recorded before scoping existed) are treated as local-only.
 */
export type AiConsentScope = "local" | "external";

export function aiConsentVersion(scope: AiConsentScope): string {
  return `${CONSENT_VERSION}:${scope}`;
}

export function aiConsentScope(version: string | null | undefined): AiConsentScope {
  return version?.endsWith(":external") ? "external" : "local";
}

export function currentAiScope(): AiConsentScope {
  return describeAiProvider().external ? "external" : "local";
}

export interface ConsentState {
  cvProcessing: boolean;
  /** Effective: granted AND given for the kind of provider that is configured now. */
  aiProcessing: boolean;
  /** Granted for a local model, but the server now uses an external provider. */
  aiProcessingNeedsRenewal: boolean;
  emailSending: boolean;
  analytics: boolean;
  /** Standing authorisation for AUTO mode to submit applications on the user's behalf. */
  autoApply: boolean;
}

type ConsentKey = "cvProcessing" | "aiProcessing" | "emailSending" | "analytics" | "autoApply";

const MAP: Record<ConsentKey, ConsentType> = {
  cvProcessing: "CV_PROCESSING",
  aiProcessing: "AI_PROCESSING",
  emailSending: "EMAIL_SENDING",
  analytics: "ANALYTICS",
  autoApply: "AUTO_APPLY",
};

export const consentService = {
  async get(userId: string): Promise<ConsentState> {
    const rows = await prisma.userConsent.findMany({ where: { userId } });
    const granted = (t: ConsentType) => rows.some((r) => r.type === t && r.granted);
    const ai = rows.find((r) => r.type === "AI_PROCESSING");
    const aiCovered = !!ai?.granted && (currentAiScope() === "local" || aiConsentScope(ai.version) === "external");
    return {
      cvProcessing: granted("CV_PROCESSING"),
      aiProcessing: aiCovered,
      aiProcessingNeedsRenewal: !!ai?.granted && !aiCovered,
      emailSending: granted("EMAIL_SENDING"),
      analytics: granted("ANALYTICS"),
      autoApply: granted("AUTO_APPLY"),
    };
  },

  async update(userId: string, input: ConsentUpdateInput, requestId?: string): Promise<ConsentState> {
    const aiScope = currentAiScope();
    for (const [key, type] of Object.entries(MAP) as [ConsentKey, ConsentType][]) {
      const value = input[key];
      if (value === undefined) continue;
      const version = type === "AI_PROCESSING" ? aiConsentVersion(aiScope) : CONSENT_VERSION;
      await prisma.userConsent.upsert({
        where: { userId_type: { userId, type } },
        create: { userId, type, granted: value, version, grantedAt: value ? new Date() : null, revokedAt: value ? null : new Date() },
        update: { granted: value, version, ...(value ? { grantedAt: new Date(), revokedAt: null } : { revokedAt: new Date() }) },
      });
    }
    await audit(userId, "consent.updated", { requestId, metadata: { changes: input, ...(input.aiProcessing !== undefined ? { aiScope } : {}) } });
    return this.get(userId);
  },

  async require(userId: string, key: ConsentKey): Promise<void> {
    const state = await this.get(userId);
    if (!state[key]) {
      const label = { cvProcessing: "CV processing", aiProcessing: "AI processing", emailSending: "email sending", analytics: "analytics", autoApply: "automatic applications" }[key];
      throw Errors.consentRequired(label);
    }
  },
};
