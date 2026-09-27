"use client";

import { useQuery } from "@tanstack/react-query";
import type { AutomationSettingsView, ProviderSourceCard } from "@applywise/types";
import { api } from "@/lib/api";

/** Query keys shared with other views of the same endpoints (invalidate these after changes). */
export const PROVIDERS_KEY = ["automation-providers"] as const;
export const AUTOMATION_SETTINGS_KEY = ["automation-settings"] as const;

export function useProviderCards(initial?: ProviderSourceCard[]) {
  return useQuery({ queryKey: PROVIDERS_KEY, queryFn: () => api<ProviderSourceCard[]>("/api/automation/providers"), initialData: initial });
}

export function useAutomationSettings() {
  return useQuery({ queryKey: AUTOMATION_SETTINGS_KEY, queryFn: () => api<AutomationSettingsView>("/api/automation/settings") });
}

/**
 * The enabledProviders list to save when one provider is switched on or off. An empty list means "every provider",
 * so switching one off from "all" lists every other provider, and a list that covers every provider collapses back
 * to "all". Returns null when the change would leave no provider enabled (not representable - [] means all).
 */
export function nextEnabledProviders(current: string[], allIds: string[], id: string, enable: boolean): string[] | null {
  const effective = current.length === 0 ? allIds : current;
  const next = enable ? Array.from(new Set([...effective, id])) : effective.filter((p) => p !== id);
  if (!next.some((p) => allIds.includes(p))) return null;
  return allIds.every((p) => next.includes(p)) ? [] : next;
}
