import type { JobPlatform } from "@applywise/types";
import type { RawImportedJob } from "../../connectors/types";
import { FeedProviderError } from "../types";
import { definedOnly, prettifySlug } from "../util";
import { SUGGESTED_COMPANIES } from "./directory";

/** Board tokens as used in API paths; anything else never reaches a request URL. */
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,99}$/;

export function cleanSlug(value: string | null | undefined): string | null {
  if (!value) return null;
  let slug = value;
  try {
    slug = decodeURIComponent(value);
  } catch {
    return null;
  }
  slug = slug.trim();
  return SLUG_RE.test(slug) ? slug : null;
}

export function requireSlug(value: string, label: string): string {
  const slug = cleanSlug(value);
  if (!slug) throw new FeedProviderError(`"${value.slice(0, 60)}" is not a valid ${label} board name.`, false);
  return slug;
}

export function pathSegments(url: URL): string[] {
  return url.pathname.split("/").filter(Boolean);
}

/** Company name from the seed directory for providers whose API has no name field (Lever, Ashby). */
export function directoryName(provider: string, slug: string): string | null {
  const key = slug.toLowerCase();
  return SUGGESTED_COMPANIES.find((c) => c.provider === provider && c.slug.toLowerCase() === key)?.name ?? null;
}

export function fallbackCompany(provider: string, slug: string): string {
  return directoryName(provider, slug) ?? prettifySlug(slug);
}

/**
 * Build a RawImportedJob for an ATS job-board posting. `raw` stays small: no payload copies.
 * The attribution uses the directory's brand name when known ("Razorpay careers (Greenhouse)"),
 * while the company hint keeps the name the API reports.
 */
export function toBoardJob(input: {
  provider: string;
  platform: JobPlatform;
  label: string;
  slug: string;
  id: string;
  company: string;
  sourceUrl: string | null;
  text: string;
  descriptionLevel?: "FULL" | "SNIPPET";
  hints: RawImportedJob["hints"];
}): RawImportedJob {
  const slug = input.slug.toLowerCase();
  return {
    provider: input.platform,
    importMethod: "OFFICIAL_API",
    externalId: `${input.provider}:${slug}:${input.id}`,
    sourceUrl: input.sourceUrl,
    attribution: `${directoryName(input.provider, slug) ?? input.company} careers (${input.label})`,
    raw: { kind: "ats_board_api", provider: input.provider, slug, id: input.id },
    text: input.text,
    descriptionLevel: input.descriptionLevel ?? "FULL",
    hints: definedOnly({ ...input.hints, company: input.company }),
  };
}

export function notFoundError(label: string, slug: string): FeedProviderError {
  return new FeedProviderError(`No ${label} job board named "${slug}" was found.`, false, 404);
}
