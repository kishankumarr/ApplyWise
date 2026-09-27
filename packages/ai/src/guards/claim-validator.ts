import { extractSkillsFromText, findSkillMentions } from "@applywise/job-engine";
import type { ClaimSeverity, ClaimValidationResult, SourceFact, SourcedClaim } from "@applywise/types";

/**
 * G. Deterministic hallucination / claim validator.
 *
 * Every generated claim must cite allowed (verified) source facts, and everything
 * concrete in the claim - numbers, technologies, employers, credentials - must be
 * present in the cited facts. This runs on ALL generated output, including Claude's.
 */

export const CLAIM_VALIDATOR_VERSION = "claim-validator-v1";

const NUMBER_RE = /(?<![a-z])(\d+(?:[.,]\d+)?)\s*(%|x\b|\+|k\b|lakh|lpa|crore|million|m\b|users|ms\b|s\b|years?|yrs|months?)?/gi;
const CREDENTIAL_RE = /\b(certified|certification|certificate|ph\.?d|doctorate|master'?s|mba|m\.?tech|b\.?tech|bachelor'?s|degree|diploma)\b/gi;
const EXAGGERATION_RE = /\b(world[- ]class|best[- ]in[- ]class|rockstar|ninja|guru|10x|unparalleled|unmatched|visionary|the best|expert in everything)\b/i;
const EMPLOYER_RE = /\b(?:at|for|with|joined)\s+([A-Z][A-Za-z0-9&.'-]+(?:\s+[A-Z][A-Za-z0-9&.'-]+){0,3})/g;
const STOP_WORDS = new Set(["I", "The", "My", "Your", "This", "A", "An", "Scale", "Speed", "Present", "React", "TypeScript"]);

function normalizeNumber(n: string): string {
  return n.replace(/,/g, "");
}

function numbersIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(NUMBER_RE)) {
    const value = normalizeNumber(m[1] ?? "");
    // Ignore list markers / tiny ordinals like "1." at the start.
    if (value) out.push(value);
  }
  return out;
}

export function normalizeFactId(id: string): string {
  return id.trim().replace(/^[[("'`]+|[\])"'`.,;]+$/g, "").trim();
}

export interface ClaimValidatorOptions {
  /** Treat skills that appear in ANY allowed fact (not just cited ones) as medium instead of high. */
  lenientSkillCitations?: boolean;
  /** Names that may appear without a citation, e.g. the target job title and company. */
  allowedEntities?: string[];
}

export function validateClaims(
  claims: SourcedClaim[],
  allowedFacts: SourceFact[],
  options: ClaimValidatorOptions = {},
): ClaimValidationResult {
  const factMap = new Map(allowedFacts.map((f) => [f.id, f]));
  const allAllowedText = allowedFacts.map((f) => f.text).join("\n");
  const allAllowedSkills = new Set(extractSkillsFromText(allAllowedText));
  const valid: SourcedClaim[] = [];
  const unsupported: ClaimValidationResult["unsupportedClaims"] = [];

  for (const original of claims) {
    // Models sometimes copy the display format "[id]"; normalise before lookup.
    const claim: SourcedClaim = { ...original, sourceFactIds: original.sourceFactIds.map(normalizeFactId).filter(Boolean) };
    const problems: { reason: string; severity: ClaimSeverity }[] = [];
    if (!claim.text.trim()) continue;
    if (claim.sourceFactIds.length === 0) {
      problems.push({ reason: "The claim does not cite any source fact.", severity: "high" });
    }
    const unknown = claim.sourceFactIds.filter((id) => !factMap.has(id));
    if (unknown.length) {
      problems.push({ reason: `Cites unknown or unverified fact(s): ${unknown.join(", ")}.`, severity: "high" });
    }
    const cited = claim.sourceFactIds.map((id) => factMap.get(id)).filter((f): f is SourceFact => !!f);
    const citedText = cited.map((f) => f.text).join("\n");
    const citedNumbers = new Set(numbersIn(citedText));

    for (const n of numbersIn(claim.text)) {
      if (!citedNumbers.has(n)) {
        problems.push({ reason: `The number "${n}" does not appear in the cited facts (possible fabricated metric).`, severity: "high" });
      }
    }

    const citedSkills = new Set(extractSkillsFromText(citedText));
    for (const skill of extractSkillsFromText(claim.text)) {
      if (citedSkills.has(skill)) continue;
      if (allAllowedSkills.has(skill)) {
        problems.push({ reason: `Mentions "${skill}" but the cited facts do not.`, severity: options.lenientSkillCitations ? "low" : "medium" });
      } else {
        problems.push({ reason: `Mentions "${skill}", which is not in the verified profile.`, severity: "high" });
      }
    }

    const citedLower = citedText.toLowerCase();
    for (const m of claim.text.matchAll(CREDENTIAL_RE)) {
      if (!citedLower.includes((m[1] ?? "").toLowerCase().replace(/'s$/, ""))) {
        problems.push({ reason: `Mentions a credential ("${m[1]}") not present in the cited facts.`, severity: "high" });
      }
    }

    const entities = (options.allowedEntities ?? []).map((e) => e.toLowerCase());
    const mentions = findSkillMentions(claim.text);
    for (const m of claim.text.matchAll(EMPLOYER_RE)) {
      const name = (m[1] ?? "").trim();
      const first = name.split(/\s+/)[0] ?? "";
      const nameStart = (m.index ?? 0) + m[0].indexOf(name);
      // A capitalised skill phrase ("with Video editing timelines") is not an employer.
      if (mentions.some((x) => x.start <= nameStart && nameStart < x.end)) continue;
      if (!name || STOP_WORDS.has(first) || extractSkillsFromText(name).length) continue;
      if (entities.some((e) => e.includes(first.toLowerCase()))) continue;
      if (!allAllowedText.includes(first)) {
        problems.push({ reason: `Mentions an organisation ("${name}") not present in the verified profile.`, severity: "high" });
      }
    }

    if (EXAGGERATION_RE.test(claim.text)) {
      problems.push({ reason: "Uses exaggerated wording; prefer factual, conservative language.", severity: "low" });
    }

    const worst = problems.reduce<ClaimSeverity | null>((acc, p) => {
      const rank = { low: 1, medium: 2, high: 3 } as const;
      return !acc || rank[p.severity] > rank[acc] ? p.severity : acc;
    }, null);
    if (!worst || worst === "low") {
      valid.push(claim);
    }
    for (const p of problems) unsupported.push({ claim, reason: p.reason, severity: p.severity });
  }

  const blocking = unsupported.filter((u) => u.severity === "high");
  return {
    validClaims: valid,
    unsupportedClaims: unsupported,
    mayShow: blocking.length === 0,
    requiredRevisions: unsupported
      .filter((u) => u.severity !== "low")
      .map((u) => `"${u.claim.text.slice(0, 80)}${u.claim.text.length > 80 ? "..." : ""}": ${u.reason}`),
  };
}

/** Find numbers in free text (e.g. an email body) that are not supported by any allowed fact. */
export function findUnsupportedNumbers(text: string, allowedFacts: SourceFact[], allowedExtra: string[] = []): string[] {
  const allowed = new Set([...numbersIn(allowedFacts.map((f) => f.text).join("\n")), ...allowedExtra.flatMap(numbersIn)]);
  return [...new Set(numbersIn(text).filter((n) => !allowed.has(n)))];
}

/** Skills mentioned in text that are not supported by any allowed fact or job context. */
export function findUnsupportedSkills(text: string, allowedFacts: SourceFact[]): string[] {
  const allowed = new Set(extractSkillsFromText(allowedFacts.map((f) => f.text).join("\n")));
  return extractSkillsFromText(text).filter((s) => !allowed.has(s));
}

export function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}
