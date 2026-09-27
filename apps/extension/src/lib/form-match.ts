import { adapterFor, type SiteAdapter } from "./adapters";
import type { FieldDescriptor, FieldMapping, PrefillAnswer, PrefillField, PrefillPayload } from "./types";

/**
 * Generic label / placeholder / name matching fallback. Produces a PROPOSED mapping that the
 * user reviews; nothing is filled until the user selects fields and clicks "Fill selected".
 */

const SYNONYMS: Record<string, string[]> = {
  firstName: ["first name", "given name", "fname", "first_name", "firstname"],
  lastName: ["last name", "surname", "family name", "lname", "last_name", "lastname"],
  fullName: ["full name", "your name", "name", "candidate name"],
  email: ["email", "e-mail", "email address"],
  phone: ["phone", "mobile", "contact number", "telephone", "phone number", "mobile number"],
  location: ["current location", "location", "city", "current city"],
  linkedin: ["linkedin"],
  github: ["github"],
  portfolio: ["portfolio", "website", "personal site", "github or portfolio"],
  currentCompany: ["current company", "current employer", "employer", "organization", "organisation", "company"],
  currentTitle: ["current title", "job title", "designation", "current role"],
  yoe: ["years of experience", "total experience", "experience years", "total years of experience", "experience_years"],
  noticePeriod: ["notice period", "notice_period", "availability to join"],
  coverLetter: ["cover letter", "cover_letter", "additional information", "message to the hiring team"],
};

/** Keys that must never be guessed from a weak single-word match. */
const STRICT_KEYS = new Set(["fullName"]);

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[*:]/g, " ")
    .replace(/[_\-[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function scoreField(field: FieldDescriptor, key: string): number {
  const synonyms = SYNONYMS[key] ?? [];
  const label = normalize(field.label || field.ariaLabel);
  const others = [field.name, field.id, field.placeholder, field.autocomplete].map(normalize).join(" | ");
  let best = 0;
  for (const syn of synonyms.map(normalize)) {
    if (label === syn) best = Math.max(best, 1);
    else if (label.includes(syn)) best = Math.max(best, STRICT_KEYS.has(key) ? 0.4 : 0.8);
    else if (others.split(" | ").some((o) => o === syn)) best = Math.max(best, 0.75);
    else if (others.includes(syn)) best = Math.max(best, STRICT_KEYS.has(key) ? 0.3 : 0.6);
  }
  // Type hints
  if (key === "email" && field.type === "email") best = Math.max(best, 0.9);
  if (key === "phone" && field.type === "tel") best = Math.max(best, 0.9);
  if (field.autocomplete === "given-name" && key === "firstName") best = 1;
  if (field.autocomplete === "family-name" && key === "lastName") best = 1;
  return best;
}

/** Fields we never fill, regardless of matching. */
export function isFillable(field: FieldDescriptor): boolean {
  return !["file", "submit", "button", "reset", "image", "hidden", "password", "checkbox", "radio"].includes(field.type);
}

export function matchFields(fields: FieldDescriptor[], prefill: PrefillField[], pageUrl: string, adapter: SiteAdapter = adapterFor(pageUrl)): FieldMapping[] {
  const fillable = fields.filter(isFillable);
  const usedFields = new Set<number>();
  const mappings: FieldMapping[] = [];

  // 1. Adapter-specific exact matches.
  for (const p of prefill) {
    const pred = adapter.fields[p.key];
    if (!pred) continue;
    const f = fillable.find((x) => !usedFields.has(x.index) && pred(x));
    if (f) {
      usedFields.add(f.index);
      mappings.push({ fieldIndex: f.index, fieldLabel: f.label || f.name || f.placeholder, key: p.key, keyLabel: p.label, value: p.value, confidence: "adapter" });
    }
  }
  const mappedKeys = new Set(mappings.map((m) => m.key));

  // 2. Generic scoring; each field and each key is used at most once.
  const candidates: { f: FieldDescriptor; p: PrefillField; s: number }[] = [];
  for (const p of prefill) {
    if (mappedKeys.has(p.key)) continue;
    for (const f of fillable) {
      if (usedFields.has(f.index)) continue;
      if (p.key === "coverLetter" && f.tag !== "textarea") continue;
      const s = scoreField(f, p.key);
      if (s >= 0.6) candidates.push({ f, p, s });
    }
  }
  candidates.sort((a, b) => b.s - a.s);
  for (const c of candidates) {
    if (usedFields.has(c.f.index) || mappedKeys.has(c.p.key)) continue;
    // Don't fill full name into a form that has separate first/last fields.
    if (c.p.key === "fullName" && mappedKeys.has("firstName")) continue;
    usedFields.add(c.f.index);
    mappedKeys.add(c.p.key);
    mappings.push({ fieldIndex: c.f.index, fieldLabel: c.f.label || c.f.name || c.f.placeholder, key: c.p.key, keyLabel: c.p.label, value: c.p.value, confidence: c.s >= 0.85 ? "high" : "medium" });
  }
  return mappings.sort((a, b) => a.fieldIndex - b.fieldIndex);
}

// ------------------------------------------------------------------ screening answers (manual handoff)

/** Words that carry no meaning when comparing a field label with a screening question. */
const QUESTION_STOP_WORDS = new Set([
  "a", "an", "the", "you", "your", "yours", "do", "does", "did", "are", "is", "am", "be", "been", "of", "to", "in", "on", "at", "for",
  "and", "or", "what", "which", "how", "have", "has", "please", "with", "this", "that", "we", "our", "us", "any", "if", "it", "can",
  "will", "would", "i", "me", "my",
]);

const cleanText = (s: string) => normalize(s).replace(/[^\p{L}\p{N} ]+/gu, " ").replace(/\s+/g, " ").trim();

function questionTokens(s: string): Set<string> {
  return new Set(cleanText(s).split(" ").filter((t) => t.length > 1 && !QUESTION_STOP_WORDS.has(t)));
}

/** Minimum similarity for proposing a screening answer, and the similarity treated as a confident match. */
export const ANSWER_MATCH_MIN = 0.6;
export const ANSWER_MATCH_HIGH = 0.9;

/**
 * Similarity (0..1) between a form field's visible label and a screening question: 1 for the same text,
 * otherwise the Dice overlap of their meaningful words. Fields without a label never match.
 */
export function scoreQuestion(field: FieldDescriptor, question: string): number {
  const label = field.label || field.ariaLabel || field.placeholder;
  if (!label.trim() || !question.trim()) return 0;
  if (cleanText(label) === cleanText(question)) return 1;
  const a = questionTokens(label);
  const b = questionTokens(question);
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return (2 * shared) / (a.size + b.size);
}

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * Propose screening answers for labelled fields that are still free. Each field and each answer is used at most
 * once; weak matches are "medium" and answers not reviewed in ApplyWise are flagged `needsReview`, so both start
 * unselected. Nothing is filled until the user selects fields and clicks "Fill selected".
 */
export function matchAnswers(fields: FieldDescriptor[], answers: PrefillAnswer[], usedFields: ReadonlySet<number> = new Set()): FieldMapping[] {
  const candidates: { f: FieldDescriptor; i: number; s: number }[] = [];
  answers.forEach((a, i) => {
    if (!a.answer.trim()) return;
    for (const f of fields) {
      if (!isFillable(f) || usedFields.has(f.index)) continue;
      const s = scoreQuestion(f, a.question);
      if (s >= ANSWER_MATCH_MIN) candidates.push({ f, i, s });
    }
  });
  candidates.sort((x, y) => y.s - x.s || x.f.index - y.f.index);
  const takenFields = new Set(usedFields);
  const takenAnswers = new Set<number>();
  const out: FieldMapping[] = [];
  for (const c of candidates) {
    if (takenFields.has(c.f.index) || takenAnswers.has(c.i)) continue;
    takenFields.add(c.f.index);
    takenAnswers.add(c.i);
    const a = answers[c.i]!;
    out.push({
      fieldIndex: c.f.index,
      fieldLabel: c.f.label || c.f.ariaLabel || c.f.name || c.f.placeholder,
      key: `answer:${c.i}`,
      keyLabel: `Answer: ${truncate(a.question, 60)}`,
      value: a.answer,
      confidence: c.s >= ANSWER_MATCH_HIGH ? "high" : "medium",
      ...(a.reviewed === false ? { needsReview: true } : {}),
    });
  }
  return out.sort((a, b) => a.fieldIndex - b.fieldIndex);
}

/**
 * Full proposal for a prefill payload: profile fields (ATS adapters + generic matching) first, then screening
 * answers on the remaining labelled fields. A cover letter not reviewed in ApplyWise is flagged `needsReview`.
 */
export function proposeMappings(
  fields: FieldDescriptor[],
  payload: Pick<PrefillPayload, "fields" | "screeningAnswers" | "coverLetterReviewed">,
  pageUrl: string,
  adapter: SiteAdapter = adapterFor(pageUrl),
): FieldMapping[] {
  const base = matchFields(fields, payload.fields, pageUrl, adapter).map((m) => (m.key === "coverLetter" && payload.coverLetterReviewed === false ? { ...m, needsReview: true } : m));
  const answers = matchAnswers(fields, payload.screeningAnswers ?? [], new Set(base.map((m) => m.fieldIndex)));
  return [...base, ...answers].sort((a, b) => a.fieldIndex - b.fieldIndex);
}

/** Initial checkbox state: confident matches of reviewed values only. The user can change every checkbox. */
export function defaultSelected(m: FieldMapping): boolean {
  return m.confidence !== "medium" && !m.needsReview;
}
