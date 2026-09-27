import Papa from "papaparse";
import { JOB_PLATFORMS, type JobPlatform, type JobWorkMode } from "@applywise/types";
import { detectPlatformFromUrl } from "../jd-parser";
import { normalizeRawJob } from "./normalize";
import { ConnectorInputError, type ImportInput, type JobSourceConnector, type RawImportedJob } from "./types";

export const CSV_COLUMNS = [
  "title",
  "company",
  "location",
  "work_mode",
  "description",
  "required_skills",
  "preferred_skills",
  "experience_min",
  "experience_max",
  "apply_url",
  "hr_email",
  "platform",
  "source_url",
  "posted_at",
  "salary_min",
  "salary_max",
] as const;

export const CSV_MAX_ROWS = 200;

const list = (v: string | undefined) =>
  (v ?? "")
    .split(/[;,|]/)
    .map((s) => s.trim())
    .filter(Boolean);

const num = (v: string | undefined) => {
  if (v == null || v.trim() === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

const WORK_MODES: JobWorkMode[] = ["remote", "hybrid", "onsite", "unknown"];

/** 3. CSV upload of jobs the user collected themselves. */
export const csvImportConnector: JobSourceConnector = {
  provider: "OTHER",
  importMethod: "CSV_IMPORT",
  integrationClass: "user_manual_entry",
  description: `Upload a CSV with columns: ${CSV_COLUMNS.join(", ")}.`,
  isConfigured: () => true,
  async importJobs(input: ImportInput): Promise<RawImportedJob[]> {
    const csv = (input.payload as { csv?: string } | null)?.csv;
    if (typeof csv !== "string" || !csv.trim()) throw new ConnectorInputError("CSV content is required.");
    const parsed = Papa.parse<Record<string, string>>(csv.trim(), {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h) => h.trim().toLowerCase().replace(/\s+/g, "_"),
    });
    if (!parsed.meta.fields?.includes("description") || !parsed.meta.fields.includes("title")) {
      throw new ConnectorInputError('CSV must include at least "title" and "description" columns.');
    }
    if (parsed.data.length > CSV_MAX_ROWS) {
      throw new ConnectorInputError(`CSV imports are limited to ${CSV_MAX_ROWS} rows.`);
    }
    const jobs: RawImportedJob[] = [];
    parsed.data.forEach((row, i) => {
      const description = (row.description ?? "").trim();
      const title = (row.title ?? "").trim();
      if (!title || description.length < 20) return;
      const platformRaw = (row.platform ?? "").trim().toUpperCase().replace(/[\s-]+/g, "_");
      const platform: JobPlatform =
        (JOB_PLATFORMS as readonly string[]).includes(platformRaw)
          ? (platformRaw as JobPlatform)
          : detectPlatformFromUrl(row.source_url || row.apply_url) ?? "OTHER";
      const wm = (row.work_mode ?? "").trim().toLowerCase() as JobWorkMode;
      jobs.push({
        provider: platform,
        importMethod: "CSV_IMPORT",
        externalId: null,
        sourceUrl: row.source_url?.trim() || null,
        attribution: `CSV import (row ${i + 2})`,
        raw: { kind: "csv_row", rowNumber: i + 2, row },
        text: description,
        hints: {
          title,
          company: row.company?.trim() || undefined,
          location: list(row.location),
          workMode: WORK_MODES.includes(wm) ? wm : undefined,
          requiredSkillNames: list(row.required_skills),
          preferredSkillNames: list(row.preferred_skills),
          experienceMinYears: num(row.experience_min),
          experienceMaxYears: num(row.experience_max),
          applyUrl: row.apply_url?.trim() || undefined,
          hrEmail: row.hr_email?.trim().toLowerCase() || undefined,
          postedAt: row.posted_at?.trim() || undefined,
          salaryMin: num(row.salary_min),
          salaryMax: num(row.salary_max),
          currency: num(row.salary_min) != null ? "INR" : undefined,
        },
      });
    });
    if (jobs.length === 0) throw new ConnectorInputError("No valid rows found (each row needs a title and description).");
    return jobs;
  },
  normalize: normalizeRawJob,
};
