import { detectPlatformFromUrl } from "../jd-parser";
import { normalizeRawJob } from "./normalize";
import { ConnectorInputError, type ImportInput, type JobSourceConnector, type RawImportedJob } from "./types";

export interface BrowserImportPayload {
  pageUrl: string;
  pageTitle?: string;
  title: string;
  company?: string;
  location?: string;
  description: string;
  applyUrl?: string | null;
  contactEmail?: string | null;
  userConfirmed: true;
}

/**
 * User-initiated browser import: the extension only sends what the user saw, reviewed and
 * clicked "Import" on. The backend never visits the page.
 */
export const browserImportConnector: JobSourceConnector = {
  provider: "OTHER",
  importMethod: "USER_INITIATED_BROWSER_IMPORT",
  integrationClass: "user_initiated_browser_import",
  description: "Import the job page you are viewing via the ApplyWise extension (explicit click only).",
  isConfigured: () => true,
  async importJobs(input: ImportInput): Promise<RawImportedJob[]> {
    const p = input.payload as BrowserImportPayload | null;
    if (!p || p.userConfirmed !== true) throw new ConnectorInputError("Browser imports require explicit user confirmation.");
    if (!p.pageUrl || !p.title || !p.description) throw new ConnectorInputError("pageUrl, title and description are required.");
    const provider = detectPlatformFromUrl(p.pageUrl) ?? "COMPANY_CAREER_PAGE";
    return [
      {
        provider,
        importMethod: "USER_INITIATED_BROWSER_IMPORT",
        externalId: null,
        sourceUrl: p.pageUrl,
        attribution: `Imported by you from ${new URL(p.pageUrl).hostname}`,
        raw: { kind: "browser_import", pageUrl: p.pageUrl, pageTitle: p.pageTitle ?? null },
        text: p.description,
        hints: {
          platform: provider,
          title: p.title,
          company: p.company || undefined,
          location: p.location || undefined,
          applyUrl: p.applyUrl ?? p.pageUrl,
          hrEmail: p.contactEmail ?? undefined,
        },
      },
    ];
  },
  normalize: normalizeRawJob,
};
