import { DEMO_JOBS, type DemoJobSpec } from "../demo/jobs";
import { normalizeRawJob } from "./normalize";
import type { ImportInput, JobSourceConnector, RawImportedJob } from "./types";

export const DEMO_NOTICE = "[DEMO CONTENT] This is a fictional job posting created for local development. It is not a real job.";

export function buildDemoDescription(spec: DemoJobSpec): string {
  const [min, max] = spec.yoe;
  const lines: string[] = [
    DEMO_NOTICE,
    "",
    `${spec.title} at ${spec.company}`,
    "",
    "About us",
    spec.about,
    "",
    "What you'll do",
    ...spec.responsibilities.map((r) => `- ${r}`),
    "",
    "Requirements",
    `- ${min}-${max} years of professional experience`,
    ...spec.required.map((s) =>
      spec.mandatory?.includes(s) ? `- Must have strong hands-on experience with ${s}` : `- Experience with ${s}`,
    ),
    ...(spec.extras ?? []).map((e) => `- ${e}`),
    "",
    "Nice to have",
    ...spec.preferred.map((s) => `- ${s}`),
    "",
    `Location: ${spec.locations.join(", ")} (${spec.workMode})`,
  ];
  if (spec.salaryLpa) lines.push(`Compensation: ${spec.salaryLpa[0]}-${spec.salaryLpa[1]} LPA`);
  if (spec.screening?.length) {
    lines.push("", "Screening questions", ...spec.screening.map((q) => `- ${q}`));
  }
  lines.push("", "How to apply", spec.apply.instructions ?? (spec.apply.url ? `Apply on the official page: ${spec.apply.url}` : ""));
  return lines.join("\n");
}

export function demoSpecToRaw(spec: DemoJobSpec, appUrl: string, now: Date = new Date()): RawImportedJob {
  const resolve = (u: string | undefined) => (u ? u.replace("{{APP_URL}}", appUrl.replace(/\/$/, "")) : undefined);
  const applyUrl = resolve(spec.apply.url);
  const withUrl = { ...spec, apply: { ...spec.apply, url: applyUrl } };
  const posted = new Date(now.getTime() - spec.postedDaysAgo * 86_400_000);
  const expires = new Date(posted.getTime() + 45 * 86_400_000);
  return {
    provider: spec.platform,
    importMethod: "SEEDED_DEMO",
    externalId: `demo-${spec.key}`,
    sourceUrl: applyUrl ?? null,
    attribution: spec.sourceLabel,
    raw: { kind: "seeded_demo", key: spec.key, sourceLabel: spec.sourceLabel, demo: true },
    text: buildDemoDescription(withUrl),
    hints: {
      platform: spec.platform,
      title: spec.title,
      company: spec.company,
      location: spec.locations,
      workMode: spec.workMode,
      employmentType: "full_time",
      requiredSkillNames: spec.required.map((s) => (spec.mandatory?.includes(s) ? `${s} (must)` : s)),
      preferredSkillNames: spec.preferred,
      experienceMinYears: spec.yoe[0],
      experienceMaxYears: spec.yoe[1],
      salaryMin: spec.salaryLpa ? spec.salaryLpa[0] * 100000 : undefined,
      salaryMax: spec.salaryLpa ? spec.salaryLpa[1] * 100000 : undefined,
      currency: spec.salaryLpa ? "INR" : undefined,
      postedAt: posted.toISOString(),
      expiresAt: expires.toISOString(),
      applyUrl,
      hrEmail: spec.apply.email,
      applicationInstructions: spec.apply.instructions,
      responsibilities: spec.responsibilities,
      isDemo: true,
    },
  };
}

/** 6. Seeded demo jobs (Naukri-like, Indeed-like, Instahyre-like, ATS career pages, email-only). */
export const seededDemoConnector: JobSourceConnector = {
  provider: "OTHER",
  importMethod: "SEEDED_DEMO",
  integrationClass: "user_manual_entry",
  description: "Fictional demo jobs for local development.",
  isConfigured: () => true,
  async importJobs(input: ImportInput): Promise<RawImportedJob[]> {
    const appUrl = (input.payload as { appUrl?: string } | null)?.appUrl ?? "http://localhost:3000";
    return DEMO_JOBS.map((spec) => demoSpecToRaw(spec, appUrl));
  },
  normalize: normalizeRawJob,
};
