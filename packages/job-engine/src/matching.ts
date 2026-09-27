import {
  isVerifiedTruthStatus,
  type ApplicationRecommendation,
  type EvidenceLevel,
  type FactKind,
  type FitResult,
  type JobMatchReport,
  type JobSkill,
  type MatchEvidence,
  type NormalizedJob,
  type ScoreFactor,
  type ScoreLabel,
  type SkillSource,
  type TruthStatus,
  type WorkModePreference,
} from "@applywise/types";
import { detectDomains, extractSkillsFromText, getRelatedSkills, normalizeSkill } from "./taxonomy";
import { isRemoteLocation, locationsMatch } from "./locations";

/**
 * Transparent, deterministic "estimated resume-to-job match".
 *
 * The numeric score is fully reproducible from these rules; AI may only explain it.
 * It is a heuristic - NOT an official ATS score.
 */
export const MATCH_ENGINE_VERSION = "match-v1.3";

export const MATCH_DISCLAIMER =
  "This score is a transparent heuristic. It does not guarantee ATS selection, an interview, or an offer.";

export const SCORE_WEIGHTS = {
  required_skill_coverage: 35,
  evidence_strength: 25,
  role_seniority_alignment: 15,
  domain_relevance: 10,
  location_workmode_fit: 10,
  resume_format: 5,
  max_penalty: 25,
} as const;

/** Evidence weights: skills-only listing is weaker than experience; unverified counts ~0. */
export const EVIDENCE_WEIGHTS: Record<EvidenceLevel, number> = {
  experience: 1,
  project: 0.8,
  questionnaire: 0.6,
  skills_section: 0.35,
  unverified: 0,
  none: 0,
};

/** Coverage credit per match type. Related technology is not equal to exact technology. */
export const COVERAGE_CREDIT = {
  exact: 1,
  related: 0.4,
  unverified: 0.2,
  missing: 0,
} as const;

export const PENALTIES = {
  missingMandatorySkill: 7,
  /** A related technology does not satisfy a mandatory requirement. */
  mandatoryOnlyRelated: 4,
  yoeShortfallMajor: 8,
  yoeShortfallMinor: 3,
  locationConflict: 5,
} as const;

export interface MatchFact {
  id: string;
  kind: FactKind;
  text: string;
  status: TruthStatus;
}

export interface MatchSkill {
  id: string;
  name: string;
  canonicalName?: string;
  source: SkillSource;
  status: TruthStatus;
}

export interface MatchCandidate {
  yoe: number | null;
  preferredLocations: string[];
  workModePreference: WorkModePreference;
  openToRelocation: boolean;
  targetRoles: string[];
  currentTitle: string | null;
  facts: MatchFact[];
  skills: MatchSkill[];
  resumeFormatWarnings?: string[];
}

interface SkillEvidence {
  level: EvidenceLevel;
  factIds: string[];
  texts: string[];
}

const LEVEL_RANK: EvidenceLevel[] = ["experience", "project", "questionnaire", "skills_section", "unverified", "none"];

function betterLevel(a: EvidenceLevel, b: EvidenceLevel): EvidenceLevel {
  return LEVEL_RANK.indexOf(a) <= LEVEL_RANK.indexOf(b) ? a : b;
}

function factLevel(kind: FactKind): EvidenceLevel {
  switch (kind) {
    case "EXPERIENCE":
    case "EXPERIENCE_BULLET":
    case "ACHIEVEMENT":
      return "experience";
    case "PROJECT":
      return "project";
    case "QUESTIONNAIRE_ANSWER":
      return "questionnaire";
    case "SKILL":
      return "skills_section";
    default:
      return "skills_section";
  }
}

function skillSourceLevel(source: SkillSource): EvidenceLevel {
  switch (source) {
    case "EXPERIENCE":
      return "experience";
    case "PROJECT":
      return "project";
    case "QUESTIONNAIRE":
      return "questionnaire";
    default:
      return "skills_section";
  }
}

/** Build the canonical-skill -> strongest evidence index for a candidate. */
export function buildEvidenceIndex(candidate: MatchCandidate): {
  verified: Map<string, SkillEvidence>;
  unverified: Map<string, SkillEvidence>;
} {
  const verified = new Map<string, SkillEvidence>();
  const unverified = new Map<string, SkillEvidence>();

  const add = (map: Map<string, SkillEvidence>, skill: string, level: EvidenceLevel, id: string, text: string) => {
    const current = map.get(skill);
    if (!current) {
      map.set(skill, { level, factIds: [id], texts: [text] });
      return;
    }
    const stronger = LEVEL_RANK.indexOf(level) < LEVEL_RANK.indexOf(current.level);
    current.level = betterLevel(current.level, level);
    // Keep the strongest evidence first so the UI quotes it.
    if (!current.factIds.includes(id)) {
      if (stronger) current.factIds.unshift(id);
      else current.factIds.push(id);
    }
    if (!current.texts.includes(text)) {
      if (stronger) current.texts.unshift(text);
      else current.texts.push(text);
      current.texts = current.texts.slice(0, 3);
    }
  };

  for (const fact of candidate.facts) {
    if (fact.status === "USER_REJECTED") continue;
    const target = isVerifiedTruthStatus(fact.status) ? verified : unverified;
    const level = isVerifiedTruthStatus(fact.status) ? factLevel(fact.kind) : "unverified";
    for (const skill of extractSkillsFromText(fact.text)) add(target, skill, level, fact.id, fact.text);
  }
  for (const s of candidate.skills) {
    if (s.status === "USER_REJECTED") continue;
    const canonical = normalizeSkill(s.canonicalName ?? s.name);
    const isVerified = isVerifiedTruthStatus(s.status);
    add(isVerified ? verified : unverified, canonical, isVerified ? skillSourceLevel(s.source) : "unverified", s.id, s.name);
  }
  // A skill that is verified somewhere should not also appear as unverified-only.
  for (const key of verified.keys()) unverified.delete(key);
  return { verified, unverified };
}

function evaluateRequirement(
  req: JobSkill,
  required: boolean,
  index: ReturnType<typeof buildEvidenceIndex>,
): MatchEvidence {
  const canonical = normalizeSkill(req.canonicalName || req.name);
  const base = { requirement: req.name, canonicalName: canonical, mandatory: req.mandatory, required, relatedVia: null };
  const exact = index.verified.get(canonical);
  if (exact) {
    return { ...base, matchType: "exact", evidenceLevel: exact.level, sourceFactIds: exact.factIds, evidenceText: exact.texts };
  }
  let bestRelated: { skill: string; ev: SkillEvidence } | null = null;
  for (const rel of getRelatedSkills(canonical)) {
    const ev = index.verified.get(rel);
    if (ev && (!bestRelated || LEVEL_RANK.indexOf(ev.level) < LEVEL_RANK.indexOf(bestRelated.ev.level))) {
      bestRelated = { skill: rel, ev };
    }
  }
  if (bestRelated) {
    return {
      ...base,
      matchType: "related",
      evidenceLevel: bestRelated.ev.level,
      sourceFactIds: bestRelated.ev.factIds,
      evidenceText: bestRelated.ev.texts,
      relatedVia: bestRelated.skill,
    };
  }
  const unv = index.unverified.get(canonical);
  if (unv) {
    return { ...base, matchType: "unverified", evidenceLevel: "unverified", sourceFactIds: unv.factIds, evidenceText: unv.texts };
  }
  return { ...base, matchType: "missing", evidenceLevel: "none", sourceFactIds: [], evidenceText: [] };
}

const round1 = (n: number) => Math.round(n * 10) / 10;

// ---------------------------------------------------------------- role/title

const ROLE_FAMILIES: Record<string, RegExp> = {
  frontend: /\b(front[- ]?end|ui engineer|ui developer|react|web developer|javascript developer|angular|vue)\b/i,
  fullstack: /\b(full[- ]?stack|mern|mean)\b/i,
  backend: /\b(back[- ]?end|api engineer|server|node(\.js)? developer|java developer|golang)\b/i,
  mobile: /\b(mobile|android|ios|react native|flutter)\b/i,
  devops: /\b(devops|sre|site reliability|platform engineer|infrastructure)\b/i,
  data: /\b(data (engineer|scientist|analyst)|machine learning|ml engineer)\b/i,
  design: /\b(designer|ux|product design)\b/i,
  qa: /\b(qa|sdet|test engineer|quality)\b/i,
};

const ADJACENT_FAMILIES: Record<string, string[]> = {
  frontend: ["fullstack"],
  fullstack: ["frontend", "backend"],
  backend: ["fullstack"],
  mobile: ["frontend"],
};

export function roleFamilies(title: string): string[] {
  return Object.entries(ROLE_FAMILIES)
    .filter(([, re]) => re.test(title))
    .map(([f]) => f);
}

function scoreTitle(jobTitle: string, candidate: MatchCandidate): { points: number; explanation: string } {
  const jobFamilies = roleFamilies(jobTitle);
  const candidateTitles = [...candidate.targetRoles, candidate.currentTitle ?? ""].filter(Boolean);
  const candFamilies = new Set(candidateTitles.flatMap(roleFamilies));
  if (candidateTitles.length === 0) return { points: 4, explanation: "No target roles set; neutral title score." };
  if (jobFamilies.some((f) => candFamilies.has(f))) {
    return { points: 8, explanation: `Job title "${jobTitle}" matches your target role family.` };
  }
  if (jobFamilies.some((f) => (ADJACENT_FAMILIES[f] ?? []).some((a) => candFamilies.has(a)))) {
    return { points: 5, explanation: `Job title "${jobTitle}" is adjacent to your target roles.` };
  }
  const jobTokens = new Set(jobTitle.toLowerCase().split(/[^a-z]+/).filter((t) => t.length > 2));
  const overlap = candidateTitles.join(" ").toLowerCase().split(/[^a-z]+/).filter((t) => jobTokens.has(t)).length;
  const points = Math.min(3, overlap);
  return { points, explanation: `Job title "${jobTitle}" is outside your target role families.` };
}

export function scoreYoe(
  yoe: number | null,
  min: number | null,
  max: number | null,
): { points: number; fit: FitResult; penalty: number } {
  const maxPts = 7;
  if (yoe == null) {
    return { points: 3, fit: { fit: "unknown", explanation: "Add your years of experience to assess fit." }, penalty: 0 };
  }
  if (min == null && max == null) {
    return { points: 5, fit: { fit: "unknown", explanation: "The job does not state an experience range." }, penalty: 0 };
  }
  if (min != null && yoe < min) {
    const gap = min - yoe;
    const points = Math.max(0, round1(maxPts - gap * 2.5));
    const penalty = gap >= 2 ? PENALTIES.yoeShortfallMajor : gap >= 1 ? PENALTIES.yoeShortfallMinor : 0;
    return {
      points,
      penalty,
      fit: {
        fit: gap >= 2 ? "poor" : "partial",
        explanation: `You have ${yoe} years; the job asks for at least ${min}.`,
      },
    };
  }
  if (max != null && yoe > max) {
    const over = yoe - max;
    const points = Math.max(2, round1(maxPts - over * 1.5));
    return {
      points,
      penalty: 0,
      fit: { fit: over > 3 ? "partial" : "good", explanation: `You have ${yoe} years; the range tops out at ${max}. You may be over-qualified.` },
    };
  }
  const range = max != null ? `${min ?? 0}-${max}` : `${min}+`;
  return { points: maxPts, penalty: 0, fit: { fit: "good", explanation: `Your ${yoe} years fit the ${range} year range.` } };
}

// ------------------------------------------------------------ location/mode

export function scoreLocation(
  job: Pick<NormalizedJob, "location" | "workMode">,
  candidate: Pick<MatchCandidate, "preferredLocations" | "workModePreference" | "openToRelocation">,
): { points: number; fit: FitResult; penalty: number } {
  const prefs = candidate.preferredLocations;
  const wantsRemote = prefs.some(isRemoteLocation) || candidate.workModePreference === "remote";
  const jobIsRemote = job.workMode === "remote" || (job.location.length > 0 && job.location.every(isRemoteLocation));

  // Work mode (4 pts)
  let modePts = 4;
  const pref = candidate.workModePreference;
  const jm = jobIsRemote ? "remote" : job.workMode;
  if (pref !== "any" && jm !== "unknown" && pref !== jm) {
    const table: Record<string, Record<string, number>> = {
      remote: { hybrid: 1, onsite: 0 },
      hybrid: { remote: 3, onsite: 2 },
      onsite: { remote: 2, hybrid: 3 },
    };
    modePts = table[pref]?.[jm] ?? 2;
  } else if (jm === "unknown") {
    modePts = 2;
  }

  // Location (6 pts)
  let locPts: number;
  let fit: FitResult;
  let penalty = 0;
  if (jobIsRemote) {
    locPts = wantsRemote || pref === "any" ? 6 : 5;
    fit = { fit: "good", explanation: "Remote role." };
  } else if (job.location.length === 0) {
    locPts = 3;
    fit = { fit: "unknown", explanation: "The job does not state a location." };
  } else {
    const cityMatch = job.location.find((l) => prefs.some((p) => !isRemoteLocation(p) && locationsMatch(l, p)));
    if (cityMatch) {
      locPts = 6;
      fit = { fit: "good", explanation: `${cityMatch} is one of your preferred locations.` };
    } else if (candidate.openToRelocation) {
      locPts = 4;
      fit = { fit: "partial", explanation: `Requires ${job.location.join(" / ")}; you are open to relocation.` };
    } else {
      locPts = 0;
      fit = { fit: "poor", explanation: `Requires ${job.location.join(" / ")}, which is not in your preferred locations.` };
      penalty = PENALTIES.locationConflict;
    }
  }
  return { points: locPts + modePts, fit, penalty };
}

// ------------------------------------------------------------------- engine

function labelFor(score: number): ScoreLabel {
  if (score >= 70) return "strong";
  if (score >= 45) return "moderate";
  return "low";
}

export function computeMatchReport(job: NormalizedJob, candidate: MatchCandidate): JobMatchReport {
  const index = buildEvidenceIndex(candidate);
  const required = job.requiredSkills.map((s) => evaluateRequirement(s, true, index));
  const preferred = job.preferredSkills.map((s) => evaluateRequirement(s, false, index));
  const all = [...required, ...preferred];

  // 1. Required-skill coverage (35)
  let coverageRatio: number;
  let coverageExplanation: string;
  const coverageOf = (items: MatchEvidence[]) => {
    const weight = (m: MatchEvidence) => (m.mandatory ? 1.5 : 1);
    const total = items.reduce((s, m) => s + weight(m), 0);
    return total === 0 ? 0 : items.reduce((s, m) => s + COVERAGE_CREDIT[m.matchType] * weight(m), 0) / total;
  };
  if (required.length > 0) {
    coverageRatio = coverageOf(required);
    const exactCount = required.filter((m) => m.matchType === "exact").length;
    coverageExplanation = `${exactCount} of ${required.length} required skills backed by verified facts (related matches earn ${COVERAGE_CREDIT.related * 100}%, unverified claims ${COVERAGE_CREDIT.unverified * 100}%).`;
  } else if (preferred.length > 0) {
    coverageRatio = coverageOf(preferred);
    coverageExplanation = "No explicit required skills; coverage is based on preferred skills.";
  } else {
    coverageRatio = 0.5;
    coverageExplanation = "The job lists no recognisable skills; neutral coverage applied.";
  }
  const coveragePts = round1(SCORE_WEIGHTS.required_skill_coverage * coverageRatio);

  // 2. Evidence strength (25)
  let evidencePts: number;
  let evidenceExplanation: string;
  if (all.length > 0) {
    const w = (m: MatchEvidence) => (m.required ? 1 : 0.5);
    const total = all.reduce((s, m) => s + w(m), 0);
    const weighted = all.reduce((s, m) => {
      const lvl = EVIDENCE_WEIGHTS[m.evidenceLevel];
      const factor = m.matchType === "exact" ? 1 : m.matchType === "related" ? 0.5 : 0;
      return s + lvl * factor * w(m);
    }, 0);
    evidencePts = round1(SCORE_WEIGHTS.evidence_strength * (weighted / total));
    const expBacked = all.filter((m) => m.matchType === "exact" && (m.evidenceLevel === "experience" || m.evidenceLevel === "project")).length;
    const skillsOnly = all.filter((m) => m.matchType === "exact" && m.evidenceLevel === "skills_section").length;
    evidenceExplanation = `${expBacked} matched skills are demonstrated in verified experience/projects; ${skillsOnly} appear only in a skills list (weaker evidence).`;
  } else {
    evidencePts = round1(SCORE_WEIGHTS.evidence_strength * 0.4);
    evidenceExplanation = "No skills to evidence; neutral score applied.";
  }

  // 3. Role & seniority alignment (15) = title 8 + YOE 7
  const title = scoreTitle(job.title, candidate);
  const yoe = scoreYoe(candidate.yoe, job.experienceMinYears, job.experienceMaxYears);
  const rolePts = round1(title.points + yoe.points);

  // 4. Domain relevance (10)
  const verifiedText = candidate.facts
    .filter((f) => isVerifiedTruthStatus(f.status))
    .map((f) => f.text)
    .join("\n");
  const candidateDomains = new Set(detectDomains(verifiedText));
  let domainPts: number;
  let domainExplanation: string;
  if (job.domains.length === 0) {
    domainPts = 6;
    domainExplanation = "The job has no specific domain; neutral score applied.";
  } else {
    const overlap = job.domains.filter((d) => candidateDomains.has(d));
    domainPts = round1(2 + 8 * (overlap.length / job.domains.length));
    domainExplanation =
      overlap.length > 0
        ? `Verified experience overlaps with the job's domain: ${overlap.join(", ")}.`
        : `No verified experience in the job's domain (${job.domains.join(", ")}).`;
  }

  // 5. Location / work mode / eligibility (10)
  const loc = scoreLocation(job, candidate);

  // 6. Resume format (5)
  const formatWarnings = candidate.resumeFormatWarnings ?? [];
  const formatPts = Math.max(0, SCORE_WEIGHTS.resume_format - formatWarnings.length);

  // Penalties (max 25)
  const missingMandatory = required.filter((m) => m.mandatory && m.matchType === "missing");
  const relatedOnlyMandatory = required.filter((m) => m.mandatory && (m.matchType === "related" || m.matchType === "unverified"));
  const rawPenalty =
    missingMandatory.length * PENALTIES.missingMandatorySkill +
    relatedOnlyMandatory.length * PENALTIES.mandatoryOnlyRelated +
    yoe.penalty +
    loc.penalty;
  const penalty = Math.min(SCORE_WEIGHTS.max_penalty, rawPenalty);
  const penaltyParts: string[] = [];
  if (missingMandatory.length) penaltyParts.push(`${missingMandatory.length} missing mandatory skill(s) (-${PENALTIES.missingMandatorySkill} each)`);
  if (relatedOnlyMandatory.length) {
    penaltyParts.push(`${relatedOnlyMandatory.length} mandatory skill(s) only matched by related or unverified evidence (-${PENALTIES.mandatoryOnlyRelated} each)`);
  }
  if (yoe.penalty) penaltyParts.push(`experience shortfall (-${yoe.penalty})`);
  if (loc.penalty) penaltyParts.push(`location conflict (-${loc.penalty})`);

  const factors: ScoreFactor[] = [
    { key: "required_skill_coverage", label: "Required-skill coverage", points: coveragePts, maxPoints: 35, explanation: coverageExplanation },
    { key: "evidence_strength", label: "Evidence strength (verified experience/projects)", points: evidencePts, maxPoints: 25, explanation: evidenceExplanation },
    { key: "role_seniority_alignment", label: "Role & seniority alignment", points: rolePts, maxPoints: 15, explanation: `${title.explanation} ${yoe.fit.explanation}` },
    { key: "domain_relevance", label: "Domain relevance", points: domainPts, maxPoints: 10, explanation: domainExplanation },
    { key: "location_workmode_fit", label: "Location / work-mode fit", points: loc.points, maxPoints: 10, explanation: loc.fit.explanation },
    {
      key: "resume_format",
      label: "Resume format & readability",
      points: formatPts,
      maxPoints: 5,
      explanation: formatWarnings.length ? `${formatWarnings.length} format warning(s).` : "No format issues detected.",
    },
    {
      key: "mandatory_gap_penalty",
      label: "Mandatory gaps & conflicts",
      points: -penalty,
      maxPoints: 0,
      explanation: penaltyParts.length ? `Deductions: ${penaltyParts.join("; ")}${rawPenalty > penalty ? " (capped at 25)" : ""}.` : "No mandatory gaps or conflicts.",
    },
  ];

  const positive = factors.filter((f) => f.key !== "mandatory_gap_penalty").reduce((s, f) => s + f.points, 0);
  const score = Math.max(0, Math.min(100, Math.round(positive - penalty)));
  const label = labelFor(score);

  const exactMatches = all.filter((m) => m.matchType === "exact");
  const relatedMatches = all.filter((m) => m.matchType === "related");
  const unverifiedMatches = all.filter((m) => m.matchType === "unverified");
  const missingMandatoryRequirements = required.filter((m) => m.matchType === "missing" && (m.mandatory || m.required));
  const missingPreferredRequirements = preferred.filter((m) => m.matchType === "missing");

  const risks: string[] = [];
  for (const m of missingMandatory) risks.push(`Mandatory skill "${m.requirement}" is not evidenced in your verified profile.`);
  for (const m of relatedOnlyMandatory) {
    risks.push(
      m.matchType === "related"
        ? `Mandatory skill "${m.requirement}" is only covered by the related skill ${m.relatedVia}.`
        : `Mandatory skill "${m.requirement}" is only an unverified CV claim.`,
    );
  }
  if (yoe.fit.fit === "poor") risks.push(yoe.fit.explanation);
  if (loc.fit.fit === "poor") risks.push(loc.fit.explanation);
  for (const r of job.otherRequirements.filter((r) => r.mandatory)) risks.push(`Check eligibility: "${r.text}".`);
  if (unverifiedMatches.length) risks.push(`${unverifiedMatches.length} matching skill(s) come from unverified CV claims - verify them to count as evidence.`);

  const improvements: string[] = [];
  for (const m of exactMatches.filter((m) => m.evidenceLevel === "skills_section").slice(0, 4)) {
    improvements.push(`"${m.requirement}" appears only in your skills list - add a truthful experience or project bullet that shows how you used it.`);
  }
  for (const m of unverifiedMatches.slice(0, 4)) {
    improvements.push(`Verify the parsed claim about "${m.requirement}" in your profile if it is accurate.`);
  }
  for (const m of relatedMatches.slice(0, 3)) {
    improvements.push(`You have ${m.relatedVia}, which is related to "${m.requirement}". Mention ${m.requirement} only if you have actually used it.`);
  }
  for (const m of missingMandatoryRequirements.slice(0, 3)) {
    improvements.push(`"${m.requirement}" is required. If you have real experience with it, answer the questionnaire so it can be included; otherwise do not claim it.`);
  }
  improvements.push(...formatWarnings.map((w) => `Format: ${w}`));

  let recommendation: ApplicationRecommendation;
  if (label === "strong" && missingMandatory.length === 0 && relatedOnlyMandatory.length === 0 && loc.fit.fit !== "poor") recommendation = "apply";
  else if (label !== "low" && missingMandatory.length <= 1) recommendation = "apply_with_caution";
  else recommendation = "do_not_prioritize";

  const summary =
    `Estimated resume-to-job match ${score}/100 (${label}). ` +
    `${exactMatches.length} exact, ${relatedMatches.length} related and ${unverifiedMatches.length} unverified skill matches; ` +
    `${missingMandatoryRequirements.length} required skill(s) missing. ${yoe.fit.explanation} ${loc.fit.explanation}`;

  return {
    estimatedMatchScore: score,
    scoreLabel: label,
    summary,
    exactMatches,
    relatedMatches,
    unverifiedMatches,
    missingMandatoryRequirements,
    missingPreferredRequirements,
    scoreFactors: factors,
    resumeFormatWarnings: formatWarnings,
    locationFit: loc.fit,
    yoeFit: yoe.fit,
    applicationRecommendation: recommendation,
    risks,
    resumeImprovements: improvements,
    engineVersion: MATCH_ENGINE_VERSION,
  };
}
