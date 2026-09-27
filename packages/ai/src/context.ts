import type { JobMatchReport, NormalizedJob, SourceFact } from "@applywise/types";

/** Everything a generator may use. `facts` must contain VERIFIED facts only. */
export interface GenerationContext {
  job: NormalizedJob & { id: string };
  candidate: {
    fullName: string | null;
    email: string | null;
    phone: string | null;
    yoe: number | null;
    currentTitle: string | null;
    currentCompany: string | null;
    noticePeriod: string | null;
    preferredLocations: string[];
    openToRelocation: boolean;
    linkedinUrl: string | null;
    githubUrl: string | null;
    portfolioUrl: string | null;
  };
  facts: SourceFact[];
  /** Experience bullets grouped by experience, for bullet-level tailoring. */
  experiences: { id: string; title: string; company: string; bulletFactIds: string[] }[];
  answers: { questionId: string; questionText: string; value: string; freeText: string | null; factId: string | null }[];
  matchReport: JobMatchReport;
}

/**
 * Facts worth showing a drafting model: profile facts, facts that mention the job's (or the
 * question's) skills, then the remaining experience bullets - capped to keep prompts small.
 */
export function relevantFacts(facts: SourceFact[], skills: Set<string>, extractSkills: (t: string) => string[], limit = 18): SourceFact[] {
  const profile = facts.filter((f) => f.id.startsWith("profile:"));
  const matching = facts.filter((f) => !f.id.startsWith("profile:") && extractSkills(f.text).some((s) => skills.has(s)));
  const bullets = facts.filter((f) => f.kind === "EXPERIENCE_BULLET" && !matching.includes(f));
  return [...profile, ...matching, ...bullets].slice(0, limit);
}

export function factsBlock(facts: SourceFact[]): string {
  return facts.map((f) => `[${f.id}] (${f.kind}) ${f.text}`).join("\n");
}

export function jobBlock(job: NormalizedJob): string {
  return [
    `Title: ${job.title}`,
    `Company: ${job.company}`,
    `Locations: ${job.location.join(", ") || "not stated"} (${job.workMode})`,
    `Experience: ${job.experienceMinYears ?? "?"}-${job.experienceMaxYears ?? "?"} years`,
    `Required skills: ${job.requiredSkills.map((s) => `${s.name}${s.mandatory ? " (mandatory)" : ""}`).join(", ") || "none listed"}`,
    `Preferred skills: ${job.preferredSkills.map((s) => s.name).join(", ") || "none listed"}`,
    `Screening questions: ${job.screeningQuestions.join(" | ") || "none"}`,
    "",
    job.description.slice(0, 12_000),
  ].join("\n");
}
