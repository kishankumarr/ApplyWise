import {
  emailApplicationRequested,
  extractSkillsFromText,
  generateRuleBasedQuestionnaire,
  slug,
  isKnownSkill,
  normalizeLocation,
  normalizeSkill,
  parseJobDescription,
  QUESTIONNAIRE_RULES_VERSION,
  type JobParseHints,
} from "@applywise/job-engine";
import { parseCvText, RULE_CV_PARSER_VERSION, type ParsedCv } from "@applywise/resume-engine";
import type { JobMatchReport, JobQuestion, JobSkill, NormalizedJob, SourceFact, SourcedClaim, TailoredResumePlan } from "@applywise/types";
import { questionListSchema, tailoredResumePlanSchema } from "@applywise/validation";
import { callStructured, withFallback, type AiCallMeta, type AiLogger } from "./client";
import type { AiConfig } from "./config";
import { factsBlock, jobBlock, relevantFacts, type GenerationContext } from "./context";
import {
  FALLBACK_VERSION,
  fallbackApplicationEmail,
  fallbackCoverLetter,
  fallbackScreeningAnswer,
  fallbackSummary,
  fallbackTailoredPlan,
  padToMinimumWords,
} from "./fallbacks";
import { countWords, findUnsupportedNumbers, findUnsupportedSkills, normalizeFactId, validateClaims } from "./guards/claim-validator";
import { PROMPTS, tag } from "./prompts";
import {
  aiCoverLetterSchema,
  aiEmailSchema,
  aiParsedCvSchema,
  aiParsedJobSchema,
  aiQuestionnaireSchema,
  aiScreeningAnswerSchema,
  aiTailoredPlanSchema,
} from "./schemas";

export interface WorkflowOptions {
  logger?: AiLogger;
  config?: AiConfig;
}

export interface WorkflowResult<T> {
  data: T;
  meta: AiCallMeta;
}

// ------------------------------------------------------------------ A. CV parser

export async function parseCv(rawText: string, opts: WorkflowOptions = {}): Promise<WorkflowResult<ParsedCv>> {
  const p = PROMPTS.cvParser;
  return withFallback<ParsedCv>({
    workflow: p.id,
    promptVersion: p.version,
    fallbackVersion: RULE_CV_PARSER_VERSION,
    ...opts,
    run: (feedback) =>
      callStructured({
        feedback,
        workflow: p.id,
        promptVersion: p.version,
        system: p.system,
        user: `Extract the candidate profile from this CV.\n\n${tag("cv", rawText.slice(0, 60_000))}`,
        schema: aiParsedCvSchema,
        ...opts,
      }),
    // Reject extracted contact details that do not literally appear in the CV (hallucination guard).
    guard: (cv) => {
      const lower = rawText.toLowerCase();
      if (cv.email && !lower.includes(cv.email.toLowerCase())) return "email not present in CV";
      for (const e of cv.experience) {
        if (e.company && !lower.includes(e.company.toLowerCase().slice(0, 12))) return `company "${e.company}" not present in CV`;
      }
      return null;
    },
    fallback: () => parseCvText(rawText),
  });
}

// --------------------------------------------------------- B. Job description parser

/**
 * Small models often return whole requirement sentences as "skills" ("strong hands-on
 * experience with React", "4-7 years of experience"). Reduce each entry to canonical skills
 * and drop experience statements, so matching keeps working.
 */
export function cleanAiSkills(items: { name: string; mandatory: boolean }[]): JobSkill[] {
  const out = new Map<string, JobSkill>();
  for (const item of items) {
    const name = item.name.trim().replace(/[.;:,]+$/, "");
    if (!name || /\b(years?|yrs)\b/i.test(name)) continue;
    const known = isKnownSkill(name) ? [normalizeSkill(name)] : extractSkillsFromText(name);
    // Unknown short names (e.g. "RxJS") are kept as-is; unknown sentences are dropped.
    const skills = known.length ? known : name.split(/\s+/).length <= 3 && name.length <= 40 ? [normalizeSkill(name)] : [];
    for (const canonical of skills) {
      const existing = out.get(canonical);
      if (existing) existing.mandatory ||= item.mandatory;
      else out.set(canonical, { name: known.length ? canonical : name, canonicalName: canonical, mandatory: item.mandatory });
    }
  }
  return [...out.values()];
}

/** Union of two skill lists by canonical name (mandatory if either says so). */
export function mergeSkills(primary: JobSkill[], secondary: JobSkill[]): JobSkill[] {
  const out = new Map(primary.map((s) => [s.canonicalName, { ...s }]));
  for (const s of secondary) {
    const e = out.get(s.canonicalName);
    if (e) e.mandatory ||= s.mandatory;
    else out.set(s.canonicalName, { ...s });
  }
  return [...out.values()];
}


export async function parseJob(rawText: string, hints: JobParseHints, opts: WorkflowOptions = {}): Promise<WorkflowResult<NormalizedJob>> {
  const p = PROMPTS.jobParser;
  const deterministic = parseJobDescription(rawText, hints);
  return withFallback<NormalizedJob>({
    workflow: p.id,
    promptVersion: p.version,
    fallbackVersion: "jd-rules-v1",
    ...opts,
    run: async (feedback) => {
      const { data, meta } = await callStructured({
        feedback,
        workflow: p.id,
        promptVersion: p.version,
        system: p.system,
        user: `Normalise this job description.\n\n${tag("job", rawText.slice(0, 40_000))}`,
        schema: aiParsedJobSchema,
        ...opts,
      });
      const lower = rawText.toLowerCase();
      // Explicit hints always win; AI values that do not appear in the text are dropped.
      const literal = (v: string | null) => (v && lower.includes(v.toLowerCase()) ? v : null);
      const applicationEmail = (v: string | null) =>
        v && emailApplicationRequested(rawText, deterministic.applicationInstructions, v) ? v.trim().toLowerCase() : null;
      const required = mergeSkills(cleanAiSkills(data.requiredSkills), deterministic.requiredSkills);
      const requiredSet = new Set(required.map((s) => s.canonicalName));
      const job: NormalizedJob = {
        ...deterministic,
        title: hints.title ?? data.title ?? deterministic.title,
        company: hints.company ?? literal(data.company) ?? deterministic.company,
        location: deterministic.location.length ? deterministic.location : data.locations.map(normalizeLocation),
        workMode: hints.workMode ?? (data.workMode !== "unknown" ? data.workMode : deterministic.workMode),
        employmentType: data.employmentType !== "unknown" ? data.employmentType : deterministic.employmentType,
        requiredSkills: hints.requiredSkills?.length ? deterministic.requiredSkills : required,
        preferredSkills: hints.preferredSkills?.length
          ? deterministic.preferredSkills
          : mergeSkills(cleanAiSkills(data.preferredSkills.map((name) => ({ name, mandatory: false }))), deterministic.preferredSkills)
              .map((s) => ({ ...s, mandatory: false }))
              .filter((s) => !requiredSet.has(s.canonicalName)),
        otherRequirements: data.otherRequirements.slice(0, 20),
        responsibilities: data.responsibilities.slice(0, 40),
        experienceMinYears: hints.experienceMinYears ?? data.experienceMinYears ?? deterministic.experienceMinYears,
        experienceMaxYears: hints.experienceMaxYears ?? data.experienceMaxYears ?? deterministic.experienceMaxYears,
        // Salary only if the deterministic parser also found an explicit figure.
        salaryMin: hints.salaryMin ?? (deterministic.salaryMin != null ? data.salaryMinInr ?? deterministic.salaryMin : null),
        salaryMax: hints.salaryMax ?? (deterministic.salaryMax != null ? data.salaryMaxInr ?? deterministic.salaryMax : null),
        applyUrl: hints.applyUrl ?? literal(data.applyUrl) ?? deterministic.applyUrl,
        // An address the model picked counts only when the posting asks for applications to be emailed to it.
        hrEmail: hints.hrEmail ?? applicationEmail(data.hrEmail) ?? deterministic.hrEmail,
        screeningQuestions: dedupeQuestions([
          ...deterministic.screeningQuestions,
          // Only questions that are actually in the posting (models sometimes invent or paraphrase).
          ...data.screeningQuestions.filter((q) => normText(rawText).includes(normText(q).slice(0, 40))),
        ]).slice(0, 10),
        applicationInstructions: hints.applicationInstructions ?? data.applicationInstructions ?? deterministic.applicationInstructions,
      };
      return { data: job, meta };
    },
    fallback: () => deterministic,
  });
}

// ------------------------------------------------------ C. Questionnaire generator

/** Lower-case alphanumeric text for tolerant comparisons. */
export function normText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function dedupeQuestions(questions: string[]): string[] {
  const seen = new Set<string>();
  return questions.filter((q) => {
    const k = normText(q);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Does a question's text ask the given employer screening question? */
function asksScreening(questionText: string, screening: string): boolean {
  const q = normText(questionText);
  const sq = normText(screening);
  return q === sq || q.includes(sq.slice(0, 60)) || (q.length >= 20 && sq.includes(q));
}

export function questionnaireGuard(job: NormalizedJob, questions: JobQuestion[], report: JobMatchReport | null = null): string | null {
  const parsed = questionListSchema.safeParse(questions);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return issue ? `${issue.path.length ? `questions.${issue.path.join(".")}: ` : ""}${issue.message}` : "invalid questionnaire";
  }
  const text = job.description.toLowerCase();
  for (const q of questions) {
    const t = q.text.toLowerCase();
    if (/salary|ctc|compensation/.test(t) && !/salary|ctc|compensation|lpa/.test(text)) return "asks about salary without JD relevance";
    if (/authori[sz]|visa|sponsor/.test(t) && !/authori[sz]|visa|sponsor|right to work/.test(text)) return "asks about work authorisation without JD relevance";
  }
  // Every employer screening question (first three) must be asked, whatever the question count.
  const screeningAsked = questions.filter((q) => q.type === "SCREENING").map((q) => q.text);
  const missingScreening = dedupeQuestions(job.screeningQuestions).slice(0, 3).filter((sq) => !screeningAsked.some((t) => asksScreening(t, sq)));
  if (missingScreening.length > 0) return `employer screening question missing: "${missingScreening[0]!.slice(0, 100)}" (ask it as a SCREENING question)`;
  // Do not waste the user's time confirming skills their verified experience already proves.
  if (report) {
    const proven = new Set(report.exactMatches.filter((m) => m.evidenceLevel === "experience" || m.evidenceLevel === "project").map((m) => m.canonicalName));
    for (const q of questions) {
      if (q.type !== "SKILL_CONFIRMATION") continue;
      const skills = q.relatedRequirement ? [normalizeSkill(q.relatedRequirement), ...extractSkillsFromText(q.relatedRequirement)] : extractSkillsFromText(q.text);
      const already = skills.find((s) => proven.has(s));
      if (already) return `asks to confirm "${already}", which the candidate's verified experience already shows - ask only about gaps, unverified claims or screening questions`;
    }
  }
  return null;
}

/** Skills that verified experience or projects already evidence (no need to ask about them). */
function provenSkills(report: JobMatchReport): Set<string> {
  return new Set(report.exactMatches.filter((m) => m.evidenceLevel === "experience" || m.evidenceLevel === "project").map((m) => m.canonicalName));
}

const SKILL_OPTIONS_CANONICAL = [
  { value: "yes_professional", label: "Yes, in a professional role" },
  { value: "yes_project", label: "Yes, in a personal/side project" },
  { value: "no", label: "No" },
  { value: "not_sure", label: "Not sure" },
];

/**
 * Deterministically repair a model-proposed questionnaire so small models' near-misses do not
 * cost a whole regeneration: drop confirmations of already-proven skills and JD-irrelevant
 * salary/authorisation questions, add missing employer screening questions, guarantee "No" /
 * "Not sure" options, drop dangling follow-ups and duplicate ids, and cap the count at 8.
 * Returns the questions plus notes on what was changed. The strict guard still runs afterwards.
 */
export function sanitizeQuestionnaire(
  questions: JobQuestion[],
  job: NormalizedJob,
  report: JobMatchReport,
  pad: JobQuestion[] = [],
): { questions: JobQuestion[]; notes: string[] } {
  const notes: string[] = [];
  const proven = provenSkills(report);
  const jd = job.description.toLowerCase();
  const seen = new Set<string>();
  let out: JobQuestion[] = [];
  const skillParents = new Set<string>();
  for (const raw of questions) {
    const q: JobQuestion = {
      ...raw,
      id: slug(raw.id) || `q_${out.length + 1}`,
      showWhen: raw.showWhen ? { ...raw.showWhen, questionId: slug(raw.showWhen.questionId) } : null,
    };
    if (seen.has(q.id)) continue;
    const t = q.text.toLowerCase();
    if (/salary|ctc|compensation/.test(t) && !/salary|ctc|compensation|lpa/.test(jd)) {
      notes.push(`dropped irrelevant salary question`);
      continue;
    }
    if (/authori[sz]|visa|sponsor/.test(t) && !/authori[sz]|visa|sponsor|right to work/.test(jd)) {
      notes.push(`dropped irrelevant work-authorisation question`);
      continue;
    }
    if (q.type === "SKILL_CONFIRMATION") {
      const requirement = q.relatedRequirement?.trim().slice(0, 80) || null;
      if (!requirement) {
        notes.push("dropped skill question without a related requirement");
        continue;
      }
      const skills = [normalizeSkill(requirement), ...extractSkillsFromText(requirement)];
      const already = skills.find((sk) => proven.has(sk));
      if (already) {
        notes.push(`dropped confirmation of proven skill ${already}`);
        continue;
      }
      // A "yes" here becomes a verified "Has used <requirement>" fact, so the question and its
      // options are made canonical: the user answers exactly what will be recorded.
      q.relatedRequirement = requirement;
      if (!normText(q.text).includes(normText(requirement))) q.text = `Have you worked with ${requirement}?`;
      q.options = SKILL_OPTIONS_CANONICAL.map((o) => ({ ...o }));
      q.allowFreeText = false;
      skillParents.add(q.id);
    }
    seen.add(q.id);
    out.push(q);
  }
  // Follow-ups of skill questions: map model "yes..." values onto the canonical ones.
  for (const q of out) {
    if (q.showWhen && skillParents.has(q.showWhen.questionId)) {
      const values = new Set<string>();
      for (const v of q.showWhen.equalsAny) {
        if (v.toLowerCase().startsWith("yes")) ["yes_professional", "yes_project"].forEach((x) => values.add(x));
        else if (SKILL_OPTIONS_CANONICAL.some((o) => o.value === v)) values.add(v);
      }
      q.showWhen = values.size ? { questionId: q.showWhen.questionId, equalsAny: [...values] } : null;
    }
  }
  // Follow-ups must point at a kept question.
  const before = out.length;
  out = out.filter((q) => !q.showWhen || out.some((x) => x.id === q.showWhen!.questionId));
  if (out.length < before) notes.push(`dropped ${before - out.length} dangling follow-up(s)`);

  // Employer screening questions first, verbatim.
  const screening: JobQuestion[] = [];
  dedupeQuestions(job.screeningQuestions).slice(0, 3).forEach((sq, i) => {
    // One-to-one: a model question can satisfy only one employer question.
    const existing = out.find((q) => !screening.includes(q) && q.type === "SCREENING" && asksScreening(q.text, sq));
    if (existing) {
      screening.push(existing);
      return;
    }
    notes.push(`added employer screening question ${i + 1}`);
    screening.push({
      id: seen.has(`screening_${i + 1}`) ? `screening_${i + 1}_employer` : `screening_${i + 1}`,
      type: "SCREENING",
      text: sq.slice(0, 300),
      whyAsked: "The employer asks this in the job posting; your answer is used to draft a truthful response.",
      requiredForJob: true,
      relatedRequirement: null,
      options: null,
      allowFreeText: true,
      showWhen: null,
    });
  });
  const rest = out.filter((q) => !screening.includes(q));
  let result = [...screening, ...rest];
  if (result.length > 8) {
    notes.push(`trimmed ${result.length - 8} question(s) to the maximum of 8`);
    const kept = result.slice(0, 8);
    // Never keep a follow-up whose parent was trimmed.
    result = kept.filter((q) => !q.showWhen || kept.some((x) => x.id === q.showWhen!.questionId));
  }
  // Pad to the minimum of 3 from the rule-based questions (never duplicates).
  for (const extra of pad) {
    if (result.length >= 3) break;
    // Employer screening questions were handled above; never add them twice.
    if (result.some((q) => q.id === extra.id) || extra.showWhen || extra.type === "SCREENING") continue;
    notes.push(`added rule-based question ${extra.id}`);
    result.push(extra);
  }
  return { questions: result, notes };
}

export async function generateQuestionnaire(ctx: GenerationContext, opts: WorkflowOptions = {}): Promise<WorkflowResult<JobQuestion[]>> {
  const p = PROMPTS.questionnaire;
  const bullets = ctx.facts.filter((f) => f.kind === "EXPERIENCE_BULLET").slice(0, 3);
  const fallback = () =>
    generateRuleBasedQuestionnaire(ctx.job, ctx.matchReport, {
      noticePeriod: ctx.candidate.noticePeriod,
      expectedSalaryMin: null,
      expectedSalaryMax: null,
      preferredLocations: ctx.candidate.preferredLocations,
      openToRelocation: ctx.candidate.openToRelocation,
      topExperienceBullets: bullets.map((b) => ({ id: b.id, text: b.text })),
    });
  const proven = [...provenSkills(ctx.matchReport)];
  // Keep the prompt small: facts that relate to the job's skills, plus a few top bullets.
  const jobSkills = new Set([...ctx.job.requiredSkills, ...ctx.job.preferredSkills].map((s) => s.canonicalName));
  const relevant = ctx.facts.filter((f) => f.id.startsWith("profile:") || extractSkillsFromText(f.text).some((sk) => jobSkills.has(sk)));
  const facts = [...relevant, ...bullets.filter((b) => !relevant.includes(b))].slice(0, 20);
  return withFallback<JobQuestion[]>({
    workflow: p.id,
    promptVersion: p.version,
    fallbackVersion: QUESTIONNAIRE_RULES_VERSION,
    ...opts,
    run: async (feedback) => {
      const gaps = {
        alreadyProvenSkills_doNotAskAbout: proven,
        missingRequired: ctx.matchReport.missingMandatoryRequirements.map((m) => m.requirement),
        missingPreferred: ctx.matchReport.missingPreferredRequirements.map((m) => m.requirement).slice(0, 5),
        unverifiedClaims: ctx.matchReport.unverifiedMatches.map((m) => m.requirement),
        onlyRelatedEvidence: ctx.matchReport.relatedMatches.map((m) => `${m.requirement} (has ${m.relatedVia})`),
        employerScreeningQuestions: ctx.job.screeningQuestions.slice(0, 3),
        locationFit: ctx.matchReport.locationFit,
        yoeFit: ctx.matchReport.yoeFit,
      };
      const { data, meta } = await callStructured({
        workflow: p.id,
        promptVersion: p.version,
        system: p.system,
        user: [
          "Write the questionnaire for this job and candidate: 3 to 6 short questions (never more than 8). Keep whyAsked under 25 words.",
          "Do not ask about skills listed in alreadyProvenSkills_doNotAskAbout. Ask every employerScreeningQuestions item first, as type SCREENING.",
          tag("job", jobBlock(ctx.job)),
          tag("facts", factsBlock(facts)),
          `Gap analysis (from the deterministic matcher):\n${JSON.stringify(gaps, null, 2)}`,
        ].join("\n\n"),
        schema: aiQuestionnaireSchema,
        feedback,
        ...opts,
      });
      const clean = sanitizeQuestionnaire(data.questions, ctx.job, ctx.matchReport, fallback());
      if (clean.notes.length) opts.logger?.info("ai.questionnaire.sanitized", { changes: clean.notes.length });
      return { data: clean.questions, meta };
    },
    guard: (qs) => questionnaireGuard(ctx.job, qs, ctx.matchReport),
    fallback,
  });
}

// ----------------------------------------------------- D. Tailored resume planner

function allowedEntities(ctx: GenerationContext): string[] {
  return [ctx.job.company, ctx.job.title];
}

/** Strip unsupported parts of an AI plan; returns null if nothing trustworthy remains. */
export function sanitizeTailoredPlan(plan: TailoredResumePlan, ctx: GenerationContext): TailoredResumePlan | null {
  const facts = ctx.facts;
  const warnings = [...plan.warnings];
  const summaryCheck = validateClaims([plan.summary], facts);
  const summary = summaryCheck.mayShow && summaryCheck.validClaims.length ? plan.summary : fallbackSummary(ctx);
  if (summary !== plan.summary) warnings.push("The suggested summary contained unsupported claims and was replaced with a conservative version.");
  // Which experience owns each bullet fact.
  const ownerOf = new Map<string, string>();
  for (const e of ctx.experiences) for (const id of e.bulletFactIds) ownerOf.set(id, e.id);
  const factKind = new Map(facts.map((f) => [f.id, f.kind]));
  const seenOriginals = new Set<string>();
  const placed: TailoredResumePlan["bulletChanges"] = [];
  for (const b of plan.bulletChanges) {
    const originalId = b.originalFactId ? normalizeFactId(b.originalFactId) : null;
    let owner: string | undefined;
    if (originalId) {
      owner = ownerOf.get(originalId);
      if (!owner || seenOriginals.has(originalId)) {
        warnings.push("Removed a suggested bullet that did not match one of your existing bullets.");
        continue;
      }
      seenOriginals.add(originalId);
    } else {
      // New bullets must be grounded in the bullets of exactly one role.
      const owners = new Set(b.sourceFactIds.map(normalizeFactId).filter((id) => factKind.get(id) === "EXPERIENCE_BULLET").map((id) => ownerOf.get(id)).filter(Boolean));
      if (owners.size !== 1) {
        warnings.push("Removed a new bullet that could not be tied to a single role.");
        continue;
      }
      owner = [...owners][0];
    }
    placed.push({ ...b, experienceId: owner ?? null, originalFactId: originalId });
  }
  const bulletChanges = placed.filter((b) => {
    const v = validateClaims([{ text: b.proposed, sourceFactIds: b.sourceFactIds }], facts);
    if (!v.mayShow || v.validClaims.length === 0) {
      warnings.push(`Removed a suggested bullet with unsupported content: "${b.proposed.slice(0, 60)}..."`);
      return false;
    }
    return true;
  });
  const factIds = new Set(facts.map((f) => f.id));
  const selectedSkills = plan.selectedSkills.filter((s) => s.sourceFactIds.some((id) => factIds.has(id)) && findUnsupportedSkills(s.name, facts).length === 0);
  if (bulletChanges.length === 0 && plan.bulletChanges.length > 0) return null;
  return { ...plan, summary, bulletChanges, selectedSkills, warnings };
}

export async function planTailoredResume(ctx: GenerationContext, opts: WorkflowOptions = {}): Promise<WorkflowResult<TailoredResumePlan>> {
  const p = PROMPTS.tailoredResume;
  const factById = new Map(ctx.facts.map((f) => [f.id, f]));
  type Attempt = { plan: TailoredResumePlan; problem: string | null };
  const result = await withFallback<Attempt>({
    workflow: p.id,
    promptVersion: p.version,
    fallbackVersion: FALLBACK_VERSION,
    ...opts,
    run: async (feedback) => {
      const { data, meta } = await callStructured({
        feedback,
        workflow: p.id,
        promptVersion: p.version,
        system: p.system,
        user: [
          "Propose a tailored resume for this job.",
          tag("job", jobBlock(ctx.job)),
          tag("facts", factsBlock(ctx.facts)),
          tag("resume", ctx.experiences.map((e) => `Experience ${e.id}: ${e.title} at ${e.company}; bullet fact ids: ${e.bulletFactIds.join(", ")}`).join("\n")),
          tag("answers", ctx.answers.map((a) => `${a.questionText} -> ${a.value}${a.freeText ? `: ${a.freeText}` : ""}`).join("\n")),
          `Missing required skills (do NOT claim): ${ctx.matchReport.missingMandatoryRequirements.map((m) => m.requirement).join(", ") || "none"}`,
        ].join("\n\n"),
        schema: aiTailoredPlanSchema,
        ...opts,
      });
      const plan: TailoredResumePlan = {
        ...data,
        bulletChanges: data.bulletChanges.map((b) => ({
          ...b,
          original: b.originalFactId ? factById.get(normalizeFactId(b.originalFactId))?.text ?? null : null,
        })),
      };
      const strict = tailoredResumePlanSchema.safeParse(plan);
      if (!strict.success) {
        const issue = strict.error.issues[0];
        return { data: { plan, problem: `plan.${issue?.path.join(".") ?? ""}: ${issue?.message ?? "invalid"}` }, meta };
      }
      const sanitized = sanitizeTailoredPlan(plan, ctx);
      if (!sanitized) return { data: { plan, problem: "no proposed bullet was supported by the cited facts - cite the exact fact ids of the bullets you rewrite" }, meta };
      return { data: { plan: sanitized, problem: null }, meta };
    },
    guard: (a) => a.problem,
    fallback: () => ({ plan: fallbackTailoredPlan(ctx), problem: null }),
  });
  return { data: result.data.plan, meta: result.meta };
}

// ----------------------------------------------------- E. Screening answers

function draftingFacts(ctx: GenerationContext, extraText = ""): SourceFact[] {
  const skills = new Set([...ctx.job.requiredSkills, ...ctx.job.preferredSkills].map((s) => s.canonicalName));
  for (const s of extractSkillsFromText(extraText)) skills.add(s);
  return relevantFacts(ctx.facts, skills, extractSkillsFromText);
}

export interface ScreeningAnswerDraft {
  answer: string;
  canConfirm: boolean;
  claims: SourcedClaim[];
}

export async function generateScreeningAnswer(question: string, ctx: GenerationContext, opts: WorkflowOptions = {}): Promise<WorkflowResult<ScreeningAnswerDraft>> {
  const p = PROMPTS.screeningAnswer;
  return withFallback<ScreeningAnswerDraft>({
    workflow: p.id,
    promptVersion: p.version,
    fallbackVersion: FALLBACK_VERSION,
    ...opts,
    run: (feedback) =>
      callStructured({
        feedback,
        workflow: p.id,
        promptVersion: p.version,
        system: p.system,
        user: [
          tag("question", question),
          `Job: ${ctx.job.title} at ${ctx.job.company}`,
          tag("facts", factsBlock(draftingFacts(ctx, question))),
          tag("answers", ctx.answers.map((a) => `[${a.factId ?? "unverified"}] ${a.questionText} -> ${a.value}${a.freeText ? `: ${a.freeText}` : ""}`).join("\n")),
        ].join("\n\n"),
        schema: aiScreeningAnswerSchema,
        ...opts,
      }),
    guard: (d) => {
      if (!d.canConfirm) return null;
      const v = validateClaims(d.claims, ctx.facts, { allowedEntities: allowedEntities(ctx) });
      if (!v.mayShow) return v.requiredRevisions[0] ?? "unsupported claim";
      if (findUnsupportedNumbers(d.answer, ctx.facts).length) return "answer contains unsupported numbers";
      return null;
    },
    fallback: () => fallbackScreeningAnswer(question, ctx),
  });
}

// ----------------------------------------------------- F. Application email

export interface EmailDraft {
  subject: string;
  body: string;
  claims: SourcedClaim[];
}

export function emailGuard(d: EmailDraft, ctx: GenerationContext): string | null {
  const words = countWords(d.body);
  if (words < 120 || words > 180) return `body is ${words} words (must be 120-180)`;
  if (!d.body.includes(ctx.job.title)) return "body does not use the real job title";
  if (!d.body.includes(ctx.job.company)) return "body does not use the real company";
  if (!/attach/i.test(d.body)) return "body does not mention the attachment";
  const v = validateClaims(d.claims, ctx.facts, { allowedEntities: allowedEntities(ctx) });
  if (!v.mayShow) return v.requiredRevisions[0] ?? "unsupported claim";
  const extra = [ctx.candidate.phone ?? "", ctx.candidate.email ?? "", ctx.job.title, ctx.job.company, ctx.candidate.noticePeriod ?? "", ctx.job.location.join(" ")];
  const numbers = findUnsupportedNumbers(d.body, ctx.facts, extra);
  if (numbers.length) return `unsupported numbers: ${numbers.join(", ")}`;
  const skills = findUnsupportedSkills(d.body.replace(ctx.job.title, ""), ctx.facts);
  if (skills.length) return `mentions unverified skills: ${skills.join(", ")}`;
  return null;
}

export async function generateApplicationEmail(
  ctx: GenerationContext,
  tailoredSummary: string | null,
  opts: WorkflowOptions & { hasCoverLetter?: boolean } = {},
): Promise<WorkflowResult<EmailDraft>> {
  const p = PROMPTS.applicationEmail;
  return withFallback<EmailDraft>({
    workflow: p.id,
    promptVersion: p.version,
    fallbackVersion: FALLBACK_VERSION,
    ...opts,
    run: async (feedback) => {
      const result = await callStructured({
        feedback,
        workflow: p.id,
        promptVersion: p.version,
        system: p.system,
        user: [
          `Write the application email for: ${ctx.job.title} at ${ctx.job.company}.`,
          `Candidate name: ${ctx.candidate.fullName ?? "the candidate"}. Sign off with the name, phone and email if given: ${[ctx.candidate.phone, ctx.candidate.email].filter(Boolean).join(" | ")}`,
          opts.hasCoverLetter ? "A cover letter is also attached." : "Only the resume is attached.",
          tailoredSummary ? `Approved tailored summary: ${tailoredSummary}` : "",
          tag("job", jobBlock(ctx.job)),
          tag("facts", factsBlock(draftingFacts(ctx))),
        ].join("\n\n"),
        schema: aiEmailSchema,
        ...opts,
      });
      // Small models often land a few words short; top up with claim-free closing sentences.
      return { ...result, data: { ...result.data, body: padToMinimumWords(result.data.body, 120) } };
    },
    guard: (d) => emailGuard(d, ctx),
    fallback: () => fallbackApplicationEmail(ctx, { hasCoverLetter: !!opts.hasCoverLetter }),
  });
}

// ----------------------------------------------------- Cover letter

export async function generateCoverLetter(ctx: GenerationContext, opts: WorkflowOptions = {}): Promise<WorkflowResult<{ body: string; claims: SourcedClaim[] }>> {
  const p = PROMPTS.coverLetter;
  return withFallback({
    workflow: p.id,
    promptVersion: p.version,
    fallbackVersion: FALLBACK_VERSION,
    ...opts,
    run: (feedback) =>
      callStructured({
        feedback,
        workflow: p.id,
        promptVersion: p.version,
        system: p.system,
        user: [`Write the cover letter for ${ctx.job.title} at ${ctx.job.company}. Candidate: ${ctx.candidate.fullName ?? ""}.`, tag("job", jobBlock(ctx.job)), tag("facts", factsBlock(draftingFacts(ctx)))].join("\n\n"),
        schema: aiCoverLetterSchema,
        ...opts,
      }),
    guard: (d) => {
      const words = countWords(d.body);
      if (words < 120 || words > 400) return `cover letter is ${words} words`;
      const v = validateClaims(d.claims, ctx.facts, { allowedEntities: allowedEntities(ctx) });
      if (!v.mayShow) return v.requiredRevisions[0] ?? "unsupported claim";
      if (findUnsupportedNumbers(d.body, ctx.facts, [ctx.job.title, ctx.job.company]).length) return "unsupported numbers";
      return null;
    },
    fallback: () => fallbackCoverLetter(ctx),
  });
}

// ----------------------------------------------------- G. Claim validation (public)

export function validateGeneratedClaims(claims: SourcedClaim[], facts: SourceFact[], entities: string[] = []) {
  return validateClaims(claims, facts, { allowedEntities: entities });
}
