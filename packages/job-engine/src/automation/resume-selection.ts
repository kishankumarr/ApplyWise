import type { ResumeSelectionCandidate, ResumeSelectionJob, ResumeSelectionResult, ResumeSelectionScore } from "@applywise/types";
import { roleFamilies } from "../matching";
import { normalizeSkill } from "../taxonomy";
import { skillMentionMatcher } from "./questions";

/**
 * Automatic resume selection.
 *
 * Deterministic: each resume variant is scored by the job requirements it covers WITH VERIFIED EVIDENCE (a skill
 * counts only if the resume names it - in its skill list or its text - and the candidate's verified skills include
 * it), weighted mandatory 3 > required 2 > preferred 1, plus role alignment between the job title and the resume's
 * label / target roles / titles:
 *   score = round(85 * coveredWeight / totalWeight + alignment), alignment = 15 when the variant's label/target roles
 *   fit the job's role, 10 when only its experience titles do, else 0; no job skills: 70 / 65 / 40.
 * Ties: primary resume, then newest, then resume id. Returns null when there are no candidates.
 */

export const RESUME_SELECTION_VERSION = "resume-select-v1";

export const RESUME_SKILL_WEIGHTS = { mandatory: 3, required: 2, preferred: 1 } as const;

/** Title words that say nothing about the role itself. */
const GENERIC_TITLE_WORDS = new Set([
  "senior",
  "sr",
  "junior",
  "jr",
  "staff",
  "principal",
  "associate",
  "intern",
  "trainee",
  "engineer",
  "engineers",
  "engineering",
  "developer",
  "developers",
  "dev",
  "specialist",
  "professional",
  "role",
  "position",
  "resume",
  "cv",
  "the",
  "and",
  "for",
  "of",
  "in",
  "at",
  "to",
  "with",
  "a",
  "an",
  "i",
  "ii",
  "iii",
  "iv",
  "level",
]);

interface JobSkill {
  name: string;
  key: string;
  weight: number;
}

function skillKey(name: string): string {
  return normalizeSkill(name).toLowerCase();
}

/** Job skills with weights; a skill listed twice keeps its highest weight and first position. */
function weightedJobSkills(job: ResumeSelectionJob): JobSkill[] {
  const byKey = new Map<string, JobSkill>();
  const add = (name: string, weight: number) => {
    if (!name?.trim()) return;
    const key = skillKey(name);
    const existing = byKey.get(key);
    if (!existing) byKey.set(key, { name: name.trim(), key, weight });
    else if (weight > existing.weight) existing.weight = weight;
  };
  for (const s of job.requiredSkills) add(s.canonicalName, s.mandatory ? RESUME_SKILL_WEIGHTS.mandatory : RESUME_SKILL_WEIGHTS.required);
  for (const s of job.preferredSkills) add(s, RESUME_SKILL_WEIGHTS.preferred);
  return [...byKey.values()];
}

function significantWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9+#]+/)
      .filter((w) => w.length >= 2 && !GENERIC_TITLE_WORDS.has(w)),
  );
}

/**
 * How the resume variant fits the job's role: "label" = the variant itself is written for it (its label or target
 * roles share the job's role family or a significant title word, e.g. "Frontend Resume" for "Frontend Engineer");
 * "titles" = only its experience titles fit (every variant of the same person usually shares those); null = no fit.
 */
function roleAlignment(jobTitle: string, candidate: ResumeSelectionCandidate): "label" | "titles" | null {
  const jobFamilies = roleFamilies(jobTitle);
  const jobWords = significantWords(jobTitle);
  const named = [candidate.label, ...candidate.targetRoles];
  if (jobFamilies.length > 0 && named.some((t) => roleFamilies(t ?? "").some((f) => jobFamilies.includes(f)))) return "label";
  if (jobWords.size > 0 && named.some((t) => [...significantWords(t ?? "")].some((w) => jobWords.has(w)))) return "label";
  if (jobFamilies.length > 0 && candidate.titles.some((t) => roleFamilies(t ?? "").some((f) => jobFamilies.includes(f)))) return "titles";
  return null;
}

/** Points for role alignment: a variant written for the role beats one that only shares experience titles. */
const ALIGNMENT_POINTS = { label: 15, titles: 10 } as const;

interface Scored extends ResumeSelectionScore {
  candidate: ResumeSelectionCandidate;
  coveredCount: number;
  totalCount: number;
}

function scoreCandidate(job: ResumeSelectionJob, jobSkills: JobSkill[], candidate: ResumeSelectionCandidate, verified: ReadonlySet<string>): Scored {
  const listed = new Set(candidate.skills.map(skillKey));
  const mentions = skillMentionMatcher(candidate.text ?? "");
  const matchedSkills: string[] = [];
  const missingSkills: string[] = [];
  let covered = 0;
  let total = 0;
  for (const s of jobSkills) {
    total += s.weight;
    const named = listed.has(s.key) || mentions(s.name);
    if (named && verified.has(s.key)) {
      covered += s.weight;
      matchedSkills.push(s.name);
    } else {
      missingSkills.push(s.name);
    }
  }
  const alignment = roleAlignment(job.title, candidate);
  const roleAligned = alignment !== null;
  const alignPoints = alignment ? ALIGNMENT_POINTS[alignment] : 0;
  const score = total === 0 ? 40 + (alignment === "label" ? 30 : alignment === "titles" ? 25 : 0) : Math.round(85 * (covered / total) + alignPoints);
  return {
    resumeId: candidate.resumeId,
    versionId: candidate.versionId,
    label: candidate.label,
    score,
    matchedSkills,
    missingSkills,
    roleAligned,
    candidate,
    coveredCount: matchedSkills.length,
    totalCount: jobSkills.length,
  };
}

function createdAtMs(candidate: ResumeSelectionCandidate): number {
  const ms = Date.parse(candidate.createdAt);
  return Number.isFinite(ms) ? ms : 0;
}

/** Locale-independent string order (keeps the ranking identical on every machine). */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareScored(a: Scored, b: Scored): number {
  return (
    b.score - a.score ||
    Number(b.candidate.isPrimary) - Number(a.candidate.isPrimary) ||
    createdAtMs(b.candidate) - createdAtMs(a.candidate) ||
    compareStrings(a.resumeId, b.resumeId) ||
    compareStrings(a.versionId ?? "", b.versionId ?? "")
  );
}

function listSkills(names: string[]): string {
  return names.length > 3 ? `${names.slice(0, 3).join(", ")}, ...` : names.join(", ");
}

function reasonFor(job: ResumeSelectionJob, best: Scored, runnerUp: Scored | undefined): string {
  const title = job.title.trim() || "this";
  const role = best.roleAligned ? `matches the "${title}" role` : `is not aimed at the "${title}" role`;
  let reason: string;
  if (best.totalCount === 0) {
    reason = `The job lists no skills; ${best.label} ${role}.`;
  } else if (best.coveredCount === 0) {
    reason = `${best.label} covers none of the ${best.totalCount} job skills with verified evidence; it ${role}.`;
  } else {
    reason = `${best.label} covers ${best.coveredCount} of ${best.totalCount} job skills with verified evidence (${listSkills(best.matchedSkills)}); ${role}.`;
  }
  if (runnerUp && runnerUp.score === best.score) {
    if (best.candidate.isPrimary && !runnerUp.candidate.isPrimary) reason += " Chosen over an equally scored resume because it is your primary resume.";
    else if (createdAtMs(best.candidate) !== createdAtMs(runnerUp.candidate)) reason += " Chosen over an equally scored resume because it is the newest.";
  }
  return reason;
}

export function selectResume(job: ResumeSelectionJob, candidates: ResumeSelectionCandidate[], verifiedSkills: ReadonlySet<string>): ResumeSelectionResult | null {
  if (candidates.length === 0) return null;
  const verified = new Set([...verifiedSkills].map(skillKey));
  const jobSkills = weightedJobSkills(job);
  const scored = candidates.map((c) => scoreCandidate(job, jobSkills, c, verified)).sort(compareScored);
  const best = scored[0]!;
  return {
    resumeId: best.resumeId,
    versionId: best.versionId,
    label: best.label,
    score: best.score,
    reason: reasonFor(job, best, scored[1]),
    ranking: scored.map((s) => ({
      resumeId: s.resumeId,
      versionId: s.versionId,
      label: s.label,
      score: s.score,
      matchedSkills: s.matchedSkills,
      missingSkills: s.missingSkills,
      roleAligned: s.roleAligned,
    })),
  };
}
