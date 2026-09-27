import { classifyQuestion, extractSkillsFromText, normalizeSkill } from "@applywise/job-engine";
import type { SourceFact, TailoredBulletChange, TailoredResumePlan } from "@applywise/types";
import type { GenerationContext } from "./context";
import { countWords } from "./guards/claim-validator";

/**
 * Deterministic generators used when Claude is not configured or its output is rejected.
 * They only recombine verified facts; they never add new claims or numbers.
 */

export const FALLBACK_VERSION = "deterministic-v1";

function jobSkillSet(ctx: GenerationContext): string[] {
  return [...ctx.job.requiredSkills, ...ctx.job.preferredSkills].map((s) => normalizeSkill(s.canonicalName || s.name));
}

function relevance(fact: SourceFact, skills: string[]): number {
  const found = extractSkillsFromText(fact.text);
  return found.filter((s) => skills.includes(s)).length;
}

function joinList(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function lcFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

function stripPeriod(s: string): string {
  return s.trim().replace(/[.;]+$/, "");
}

/** Replace alias spellings with the job's canonical spelling (e.g. ReactJS -> React). No new content. */
function alignTerminology(text: string, jobSkills: string[]): string {
  let out = text;
  const aliasPairs: [RegExp, string][] = [
    [/\bReact\.?js\b/gi, "React"],
    [/\bNode\.?js\b/gi, "Node.js"],
    [/\bTypescript\b/g, "TypeScript"],
    [/\bJavascript\b/g, "JavaScript"],
  ];
  for (const [re, canonical] of aliasPairs) if (jobSkills.includes(canonical)) out = out.replace(re, canonical);
  return out;
}

export function yoeFactId(ctx: GenerationContext): string | null {
  return ctx.facts.find((f) => f.id === "profile:yoe")?.id ?? null;
}

export function fallbackSummary(ctx: GenerationContext): { text: string; sourceFactIds: string[] } {
  const skills = jobSkillSet(ctx);
  const ids: string[] = [];
  const role = ctx.candidate.currentTitle ?? "Software engineer";
  const titleFact = ctx.facts.find((f) => f.id === "profile:title");
  if (titleFact) ids.push(titleFact.id);
  const yoeId = yoeFactId(ctx);
  let first = role;
  if (ctx.candidate.yoe != null && yoeId) {
    first = `${role} with ${ctx.candidate.yoe} years of professional experience`;
    ids.push(yoeId);
  }
  const evidence = ctx.facts
    .filter((f) => f.kind === "EXPERIENCE_BULLET" || f.kind === "PROJECT" || f.kind === "SKILL" || f.kind === "QUESTIONNAIRE_ANSWER")
    .map((f) => ({ f, skills: extractSkillsFromText(f.text).filter((s) => skills.includes(s)) }))
    .filter((x) => x.skills.length > 0);
  const matched: string[] = [];
  for (const e of evidence) {
    for (const s of e.skills) {
      if (!matched.includes(s) && matched.length < 5) {
        matched.push(s);
        if (!ids.includes(e.f.id)) ids.push(e.f.id);
      }
    }
  }
  let text = `${first}.`;
  if (matched.length) text += ` Hands-on experience with ${joinList(matched)}.`;
  return { text, sourceFactIds: ids };
}

export function fallbackTailoredPlan(ctx: GenerationContext): TailoredResumePlan {
  const skills = jobSkillSet(ctx);
  const factById = new Map(ctx.facts.map((f) => [f.id, f]));
  const bulletChanges: TailoredBulletChange[] = [];
  for (const exp of ctx.experiences) {
    const bullets = exp.bulletFactIds.map((id) => factById.get(id)).filter((f): f is SourceFact => !!f);
    const ranked = [...bullets].sort((a, b) => relevance(b, skills) - relevance(a, skills));
    for (const b of ranked) {
      const score = relevance(b, skills);
      const proposed = alignTerminology(b.text, skills);
      bulletChanges.push({
        experienceId: exp.id,
        originalFactId: b.id,
        original: b.text,
        proposed,
        sourceFactIds: [b.id],
        rationale:
          score > 0
            ? `Moved up: evidences ${extractSkillsFromText(b.text).filter((s) => skills.includes(s)).join(", ")} required by the job.`
            : "Kept as-is; less relevant to this job.",
        confidence: score > 0 ? "high" : "low",
      });
    }
  }
  const selectedSkills: TailoredResumePlan["selectedSkills"] = [];
  const skillFacts = ctx.facts.filter((f) => f.kind !== "CONTACT");
  const addSkill = (name: string) => {
    if (selectedSkills.some((s) => s.name === name)) return;
    const ids = skillFacts.filter((f) => extractSkillsFromText(f.text).includes(name)).map((f) => f.id).slice(0, 3);
    if (ids.length) selectedSkills.push({ name, sourceFactIds: ids });
  };
  for (const s of skills) addSkill(s);
  for (const f of ctx.facts.filter((f) => f.kind === "SKILL")) for (const s of extractSkillsFromText(f.text)) addSkill(s);

  const hasRelevantProjects = ctx.facts.some((f) => f.kind === "PROJECT" && relevance(f, skills) > 0);
  const warnings = ctx.matchReport.missingMandatoryRequirements.map(
    (m) => `"${m.requirement}" is required but not in your verified profile - it has not been added.`,
  );
  return {
    summary: fallbackSummary(ctx),
    bulletChanges,
    selectedSkills: selectedSkills.slice(0, 20),
    sectionOrder: hasRelevantProjects
      ? ["summary", "experience", "projects", "skills", "education", "achievements"]
      : ["summary", "experience", "skills", "projects", "education", "achievements"],
    orderingNotes: [
      "Bullets that evidence the job's required skills are listed first within each role.",
      hasRelevantProjects ? "Projects are placed before skills because they demonstrate relevant technologies." : "Skills are placed before projects.",
    ],
    warnings,
  };
}

/** "Do you ...?", "Are you ...?", "Have you ...?": the question expects a yes/no answer. */
const YES_NO_QUESTION = /^(?:do|does|did|are|is|am|have|has|had|can|could|will|would|were|was|shall|should|may)\b/i;
/** A number, a threshold, a duration or an explicit confirmation: facts that merely mention a skill do not answer it. */
const NUMERIC_OR_CONFIRMATION =
  /\d|\b(?:how many|how much|how long|minimum|at least|more than|less than|fewer than|or more|or above|years?|yrs?|months?|confirm|yes\s*\/\s*no|yes or no)\b/i;

export const CANNOT_CONFIRM_ANSWER = "I cannot confirm this from my verified profile yet. [Please answer this question yourself before submitting.]";

function cannotConfirm(): { answer: string; canConfirm: false; claims: [] } {
  return { answer: CANNOT_CONFIRM_ANSWER, canConfirm: false, claims: [] };
}

/** Questionnaire answer codes as the user meant them; null for "not sure" / empty. */
function questionnaireText(value: string, freeText: string | null | undefined): string | null {
  const text = freeText?.trim();
  if (text) return text;
  const code = value.trim().toLowerCase();
  if (!code || code === "not_sure" || code === "unsure") return null;
  if (code === "yes" || code === "yes_professional" || code === "yes_project" || code === "yes_relocate") return "Yes";
  if (code === "no") return "No";
  return value.trim();
}

/**
 * Deterministic screening answer. Yes/no questions, questions with a number, threshold or duration ("5+ years of
 * React?", "How many years ...?") and confirmations are never answered from facts that merely mention a skill: only
 * the user's own questionnaire answer to that exact question, or (total experience only) the verified years of
 * experience, answer them. Open questions ("Describe your experience with ...") are drafted from verified facts.
 */
export function fallbackScreeningAnswer(question: string, ctx: GenerationContext): { answer: string; canConfirm: boolean; claims: { text: string; sourceFactIds: string[] }[] } {
  const trimmed = question.trim();
  const q = trimmed.toLowerCase();
  const closed = YES_NO_QUESTION.test(trimmed) || NUMERIC_OR_CONFIRMATION.test(trimmed);
  // The user's own questionnaire answer: to this exact question, or (open questions only) to one it starts like.
  const direct = ctx.answers.find(
    (a) => a.factId && (a.questionText.trim().toLowerCase() === q || (!closed && a.freeText && q.includes(a.questionText.toLowerCase().slice(0, 30)))),
  );
  const directText = direct ? questionnaireText(direct.value, direct.freeText) : null;
  if (direct?.factId && directText) return { answer: directText, canConfirm: true, claims: [{ text: directText, sourceFactIds: [direct.factId] }] };

  // "How many years of (total) experience do you have?" - the verified years of experience, never a skill's years.
  const yoeId = yoeFactId(ctx);
  if (
    classifyQuestion(trimmed).canonicalKey === "total_experience_years" &&
    !YES_NO_QUESTION.test(trimmed) &&
    !/\d/.test(trimmed) &&
    ctx.candidate.yoe != null &&
    yoeId
  ) {
    const text = `I have ${ctx.candidate.yoe} years of professional experience.`;
    return { answer: text, canConfirm: true, claims: [{ text, sourceFactIds: [yoeId] }] };
  }
  if (closed) return cannotConfirm();

  const qSkills = extractSkillsFromText(trimmed);
  const matches = ctx.facts
    .filter((f) => f.kind !== "CONTACT")
    .map((f) => ({ f, s: extractSkillsFromText(f.text).filter((x) => qSkills.includes(x)).length }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 2);
  if (matches.length) {
    // The facts themselves, without a leading "Yes.": they describe the work, they do not confirm a requirement.
    const text = matches.map((m) => `${stripPeriod(m.f.text)}.`).join(" ");
    return { answer: text, canConfirm: true, claims: [{ text, sourceFactIds: matches.map((m) => m.f.id) }] };
  }
  return cannotConfirm();
}

function signature(ctx: GenerationContext): string {
  const contact = [ctx.candidate.phone, ctx.candidate.email].filter(Boolean).join(" | ");
  return [ctx.candidate.fullName ?? "", contact].filter(Boolean).join("\n");
}

function topBullets(ctx: GenerationContext, n: number): SourceFact[] {
  const skills = jobSkillSet(ctx);
  const rank = (kinds: SourceFact["kind"][]) =>
    ctx.facts
      .filter((f) => kinds.includes(f.kind))
      .map((f) => ({ f, r: relevance(f, skills) }))
      .filter((x) => x.r > 0)
      .sort((a, b) => b.r - a.r)
      .map((x) => x.f);
  // Experience bullets read best in prose; projects only fill remaining slots.
  return [...rank(["EXPERIENCE_BULLET"]), ...rank(["PROJECT"])].slice(0, n);
}

const VERB_START = /^(built|designed|developed|implemented|led|created|improved|wrote|shipped|owned|migrated|optimi[sz]ed|architected|integrated|maintained|delivered|launched|reduced|increased|contributed|worked)\b/i;

/** A clause that can follow "I ..." without changing the fact's meaning. */
function firstPersonClause(fact: SourceFact): string {
  const t = stripPeriod(fact.text);
  if (fact.kind === "PROJECT") return `worked on a project: ${t}`;
  return VERB_START.test(t) ? lcFirst(t) : `worked on the following: ${lcFirst(t)}`;
}

export function fallbackApplicationEmail(
  ctx: GenerationContext,
  opts: { hasCoverLetter: boolean },
): { subject: string; body: string; claims: { text: string; sourceFactIds: string[] }[] } {
  const name = ctx.candidate.fullName ?? "Candidate";
  const subject = `Application for ${ctx.job.title} - ${name}`;
  const claims: { text: string; sourceFactIds: string[] }[] = [];
  const intro = fallbackSummary(ctx);
  const bullets = topBullets(ctx, 3);

  const build = (bulletCount: number, padding: number): string => {
    const paras: string[] = [];
    paras.push(`Dear Hiring Team at ${ctx.job.company},`);
    const opener = `I am writing to apply for the ${ctx.job.title} position${ctx.job.location.length ? ` (${ctx.job.location.join(" / ")})` : ""}. ${intro.text}`;
    paras.push(opener);
    const exp = bullets.slice(0, bulletCount).map((b, i) => (i === 0 ? `In my recent work, I ${firstPersonClause(b)}.` : `I also ${firstPersonClause(b)}.`));
    if (exp.length) paras.push(exp.join(" "));
    const close: string[] = [
      `I have attached my resume tailored to this role${opts.hasCoverLetter ? ", along with a short cover letter" : ""}.`,
      `I would welcome the opportunity to discuss how my experience could support the team at ${ctx.job.company}.`,
    ];
    if (ctx.candidate.noticePeriod) close.push(`My current notice period is ${ctx.candidate.noticePeriod}.`);
    close.push(...CLAIM_FREE_PADDING.slice(0, padding));
    paras.push(close.join(" "));
    paras.push("Thank you for your time and consideration.");
    paras.push(`Best regards,\n${signature(ctx)}`);
    return paras.join("\n\n");
  };

  let body = "";
  let chosenBullets = 0;
  // Find a combination inside the 120-180 word window (signature included, as the user sees it).
  outer: for (const bc of [2, 3, 1, 0]) {
    for (let pad = 0; pad <= 3; pad++) {
      const candidate = build(Math.min(bc, bullets.length), pad);
      const words = countWords(candidate);
      if (words >= 120 && words <= 180) {
        body = candidate;
        chosenBullets = Math.min(bc, bullets.length);
        break outer;
      }
      if (words > 180) break;
    }
  }
  if (!body) {
    body = build(Math.min(1, bullets.length), 3);
    chosenBullets = Math.min(1, bullets.length);
  }
  claims.push(intro);
  for (const b of bullets.slice(0, chosenBullets)) claims.push({ text: b.text, sourceFactIds: [b.id] });
  return { subject, body, claims };
}

/** Neutral closing sentences: no facts, numbers, skills or employers. */
export const CLAIM_FREE_PADDING = [
  "I would be glad to share more details about my work or walk you through relevant projects.",
  "Please let me know if you need any additional information from my side.",
  "I am happy to make time for a conversation at your convenience.",
];

/**
 * If an email body is slightly under `min` words, insert claim-free sentences before the
 * sign-off. Bodies that are far too short (or already long enough) are returned unchanged.
 */
export function padToMinimumWords(body: string, min: number, maxShortfall = 40): string {
  const words = countWords(body);
  if (words >= min || min - words > maxShortfall) return body;
  const paragraphs = body.split(/\n{2,}/);
  const signOff = paragraphs.findIndex((p) =>
    /^(thank you|thanks|many thanks|best regards|best|regards|sincerely|yours sincerely|yours faithfully|yours truly|warm regards|kind regards|with (best|kind|warm) regards|cheers)\b/i.test(p.trim()),
  );
  // Without a recognisable sign-off we cannot insert safely (it could land in the signature).
  if (signOff === -1) return body;
  const insertAt = signOff;
  const extra: string[] = [];
  let total = words;
  for (const sentence of CLAIM_FREE_PADDING) {
    if (total >= min || body.includes(sentence)) continue;
    extra.push(sentence);
    total += countWords(sentence);
  }
  if (!extra.length) return body;
  paragraphs.splice(insertAt, 0, extra.join(" "));
  return paragraphs.join("\n\n");
}

export function fallbackCoverLetter(ctx: GenerationContext): { body: string; claims: { text: string; sourceFactIds: string[] }[] } {
  const intro = fallbackSummary(ctx);
  const bullets = topBullets(ctx, 3);
  const matched = ctx.matchReport.exactMatches.filter((m) => m.required).map((m) => m.requirement).slice(0, 4);
  const paras = [
    `Dear Hiring Manager,`,
    `I am applying for the ${ctx.job.title} role at ${ctx.job.company}. ${intro.text}`,
  ];
  if (bullets.length) {
    paras.push(
      `Some of the work most relevant to this role: ${bullets.map((b) => `${lcFirst(stripPeriod(b.text))}`).join("; ")}.`,
    );
  }
  if (matched.length) paras.push(`Your posting asks for ${joinList(matched)}, which I have used in the work described above.`);
  const missing = ctx.matchReport.missingMandatoryRequirements.map((m) => m.requirement);
  if (missing.length) {
    paras.push(`I do not want to overstate my background: I have not yet worked professionally with ${joinList(missing)}, but I am keen to learn it quickly.`);
  }
  paras.push(
    `I would appreciate the chance to discuss how I could contribute to ${ctx.job.company}. My resume is attached for your review.`,
    `Thank you for your consideration.`,
    `Sincerely,\n${ctx.candidate.fullName ?? ""}`,
  );
  return {
    body: paras.join("\n\n"),
    claims: [intro, ...bullets.map((b) => ({ text: b.text, sourceFactIds: [b.id] }))],
  };
}
