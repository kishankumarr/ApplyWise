import type { SearchProviderAdapter } from "../types";
import { adzunaProvider } from "./adzuna";
import { himalayasProvider } from "./himalayas";
import { jobicyProvider } from "./jobicy";
import { theMuseProvider } from "./themuse";

export { adzunaProvider, himalayasProvider, jobicyProvider, theMuseProvider };

/**
 * Job-search API providers, India coverage first. Remotive, Remote OK, Jooble and Careerjet were
 * evaluated and left out (broken filters, lifetime quotas or per-end-user IP requirements).
 */
export const SEARCH_PROVIDERS: SearchProviderAdapter[] = [adzunaProvider, himalayasProvider, jobicyProvider, theMuseProvider];

export function getSearchProvider(id: string): SearchProviderAdapter | null {
  return SEARCH_PROVIDERS.find((p) => p.id === id) ?? null;
}
