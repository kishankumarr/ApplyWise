import type {
  ApplicationMessageCategory,
  ApplicationStatus,
  StatusEmailApplicationRef,
  StatusEmailAssociation,
  StatusEmailClassification,
  StatusEmailInput,
} from "@applywise/types";
import { ALERT_SENDERS, senderAddress } from "../feeds/alerts/senders";
import { nameParts } from "../feeds/boards/slugs";
import { htmlToText, stripDiacritics } from "../feeds/util";

/**
 * Application-status email classification.
 *
 * Deterministic keyword/phrase rules over subject + body: application confirmation, recruiter response,
 * assessment, interview, rejection, offer. Association with an application needs sufficient confidence (company
 * name / sender domain + title). Nothing here ever replies to an email, fetches a link or stores content: the
 * caller keeps only the category, a sender domain and a truncated subject.
 *
 * Scoring: every phrase rule has a weight (strong 0.6, medium 0.4, weak 0.25). A hit in the subject counts 1.5x;
 * a hit only inside a conditional sentence ("if you are shortlisted, we will schedule an interview") counts 0.35x.
 * A category's score is the sum of its distinct rule hits. Conflicts are resolved in a fixed order: a clear
 * rejection beats everything (a rejection often mentions the interview it follows), then a clear offer, then the
 * highest-scoring specific category; a recruiter response is chosen only when no specific category has a clear
 * signal. Confidence is the winning score (capped at 0.97), reduced when a competing category is close.
 */

export const STATUS_EMAIL_CLASSIFIER_VERSION = "status-email-v1";
/** Minimum classification and association confidence before a message may change an application's status. */
export const STATUS_EMAIL_MIN_CONFIDENCE = 0.7;

/** Only the start of a long email is classified (signatures and legal footers add noise, not signal). */
const MAX_BODY_CHARS = 12_000;
const STRONG = 0.6;
const MEDIUM = 0.4;
const WEAK = 0.25;
const SUBJECT_FACTOR = 1.5;
const HEDGED_FACTOR = 0.35;
const MAX_CONFIDENCE = 0.97;
/** A rejection / offer with at least this score wins over any other category in the same email. */
const OVERRIDE_SCORE = 0.6;
/** Two applications whose association scores are closer than this are ambiguous. */
const AMBIGUITY_MARGIN = 0.1;
/** An email received this long before an application was sent cannot be about it. */
const SENT_SLACK_MS = 24 * 60 * 60_000;

type SignalCategory = Exclude<ApplicationMessageCategory, "OTHER">;

interface PhraseRule {
  label: string;
  re: RegExp;
  weight: number;
}

/** Rules run on normalised lowercase text (straight apostrophes, single spaces). */
const RULES: Record<SignalCategory, PhraseRule[]> = {
  APPLICATION_CONFIRMATION: [
    {
      label: "thank you for applying",
      re: /\bthank(?:s| you) for (?:applying|your (?:recent |online |job )?application|submitting your (?:application|resume|cv|profile))\b/,
      weight: STRONG,
    },
    {
      label: "we received your application",
      re: /\bwe(?:'ve| have)? (?:successfully |just )?received your (?:job |online )?(?:application|resume|cv|profile)\b|\b(?:confirm|acknowledge) (?:the )?receipt of your (?:application|resume|cv)\b/,
      weight: STRONG,
    },
    { label: "application received", re: /\bapplication (?:has been |was |is )?(?:successfully )?(?:received|submitted|registered)\b/, weight: STRONG },
    { label: "application confirmation", re: /\bapplication (?:confirmation|acknowledge?ment)\b|\byou(?:'ve| have)? (?:successfully )?applied (?:for|to)\b/, weight: MEDIUM },
    { label: "application under review", re: /\b(?:will|shall) (?:now )?(?:carefully )?review your (?:application|profile|resume|cv)\b|\bapplication is (?:now )?(?:under|being) review/, weight: WEAK },
  ],
  ASSESSMENT: [
    { label: "assessment", re: /\bassessments?\b/, weight: MEDIUM },
    { label: "coding test", re: /\bcoding (?:test|challenge|assessment|exercise|round|assignment|task)\b/, weight: STRONG },
    { label: "online test", re: /\bonline (?:test|assessment|exam|coding test)\b/, weight: STRONG },
    { label: "assessment platform", re: /\b(?:hacker ?rank|hacker ?earth|codility|codesignal|coderbyte|testgorilla|mettl|imocha|hirepro|amcat|devskiller|testdome)\b/, weight: STRONG },
    { label: "take-home", re: /\btake[- ]?home\b/, weight: STRONG },
    { label: "test or assignment", re: /\b(?:technical|written|aptitude|skills?|programming) (?:test|assignment|exercise|challenge)\b|\bassignment (?:link|deadline)\b/, weight: MEDIUM },
    { label: "shortlisted for a test", re: /\bshortlisted for (?:the |an? )?(?:online |written |coding |aptitude |technical )?(?:test|assessment)\b/, weight: STRONG },
  ],
  INTERVIEW: [
    { label: "interview", re: /\binterview(?:s|ed|ing)?\b/, weight: MEDIUM },
    {
      label: "schedule a call",
      re: /\b(?:schedule|set up|arrange|book|fix|line up) (?:a |an |the |your )?(?:quick |short |brief |phone |telephonic |video |virtual |introductory |intro |technical |initial |first |30[- ]minute |15[- ]minute )?(?:call|interview|chat|conversation|meeting|discussion)\b/,
      weight: STRONG,
    },
    { label: "meet the team", re: /\bmeet (?:with )?(?:the|our) (?:team|hiring manager|hiring team|founders?|engineering team|panel)\b/, weight: STRONG },
    {
      label: "availability for a call",
      re: /\bavailability (?:for|to have|to schedule) (?:a |an |the )?(?:quick |short |brief |phone |video |virtual )?(?:call|interview|chat|conversation|discussion|meeting)\b|\b(?:share|send|confirm|provide) (?:us |me )?your availability\b/,
      weight: STRONG,
    },
    { label: "available for a call", re: /\bavailable (?:for|to have) (?:a |an )?(?:quick |short |brief |phone |video )?(?:call|chat|interview|discussion)\b/, weight: MEDIUM },
    {
      label: "interview invitation",
      re: /\b(?:invite|inviting|invitation) (?:you )?(?:to|for) (?:an? |the |your )?(?:[a-z-]+ )?(?:interview|call|chat|conversation|discussion|round)\b|\binterview (?:invite|invitation)\b/,
      weight: STRONG,
    },
    {
      label: "shortlisted for an interview",
      re: /\bshortlisted for (?:the |an? )?(?:next round|(?:[a-z-]+ )?interview|(?:technical|hr|f2f|face[- ]to[- ]face|final|managerial|first|second|next) (?:round|discussion))\b/,
      weight: STRONG,
    },
    { label: "shortlisted", re: /\bshortlisted\b/, weight: WEAK },
    { label: "interview round", re: /\b(?:technical|hr|managerial|f2f|face[- ]to[- ]face|virtual|final|first|second|third|next|onsite|on-site) (?:round|discussion)\b/, weight: MEDIUM },
    { label: "meeting invite", re: /\b(?:google meet|zoom (?:link|call|meeting)|microsoft teams|ms teams|teams (?:link|meeting)|calendar invite|calendly)\b/, weight: MEDIUM },
    { label: "reschedule", re: /\breschedul(?:e|ed|ing)\b/, weight: MEDIUM },
  ],
  REJECTION: [
    {
      label: "not moving forward",
      re: /\b(?:not|won't) (?:be )?(?:moving|move|going|go) (?:forward|ahead)\b|\bdecided (?:not to|to not) (?:move|proceed|go|progress|continue|pursue)\b/,
      weight: STRONG,
    },
    {
      label: "chose other candidates",
      re: /\b(?:move|moving|go|going|proceed|proceeding|continue|continuing) (?:forward |ahead )?with (?:other|another|a different|more suitable) (?:candidates?|applicants?)\b/,
      weight: STRONG,
    },
    { label: "other candidates", re: /\b(?:other|another|different|more suitable|stronger|more qualified) (?:candidates?|applicants?)\b|\bcandidates? whose (?:experience|profiles?|skills|background|qualifications)\b/, weight: MEDIUM },
    { label: "unfortunately", re: /\bunfortunately\b/, weight: WEAK },
    { label: "not be proceeding", re: /\bnot (?:be )?(?:proceeding|progressing|pursuing)\b|\bwon't be (?:proceeding|progressing|pursuing)\b/, weight: STRONG },
    {
      label: "position has been filled",
      re: /\b(?:position|role|vacancy|opening|job|requisition|post) (?:has been|was|is now|is|has now been) (?:filled|closed|put on hold|cancelled|withdrawn)\b/,
      weight: STRONG,
    },
    { label: "regret to inform", re: /\bregret to (?:inform|let you know|advise|tell)\b|\bwe regret\b|\bregretfully\b/, weight: STRONG },
    { label: "not selected", re: /\bnot (?:been )?(?:shortlisted|selected|successful|chosen)\b|\bunsuccessful\b/, weight: STRONG },
    { label: "not a fit", re: /\bnot (?:an? |the right )?(?:good |strong |close |suitable )?(?:fit|match) (?:for|at this time|with)\b|\b(?:does|do) not (?:meet|match) (?:our|the) (?:current )?(?:requirements?|criteria|needs)\b/, weight: MEDIUM },
    {
      label: "resume kept on file",
      re: /\b(?:keep|retain|hold) your (?:resume|cv|profile|details|application) (?:on file|in our (?:database|records|system|talent pool)|for future)\b|\bfuture (?:opportunities|openings|roles|vacancies|positions)\b/,
      weight: WEAK,
    },
    {
      label: "unable to offer",
      re: /\b(?:unable to|not able to|cannot|can't|won't be able to) (?:offer you|extend (?:you )?an offer|make (?:you )?an offer)\b|\bnot (?:be )?(?:extending|making) (?:you )?an offer\b/,
      weight: STRONG,
    },
  ],
  OFFER: [
    { label: "offer letter", re: /\boffer letter\b/, weight: STRONG },
    {
      label: "pleased to offer",
      re: /\b(?:pleased|happy|delighted|excited|thrilled|glad) to (?:offer you|extend (?:to you )?(?:you )?)(?:the |this |a |an |our )?(?:formal |official |verbal |written )?(?:offer|position|role|job|post|employment|opportunity to join)\b/,
      weight: STRONG,
    },
    { label: "extend an offer", re: /\bextend(?:ing|ed)? (?:you )?(?:an?|the|this|our) (?:formal |official |verbal |written )?offer\b/, weight: STRONG },
    { label: "offer of employment", re: /\b(?:offer of employment|employment offer|job offer|formal offer|verbal offer|offer (?:details|package|acceptance))\b/, weight: STRONG },
    { label: "accept the offer", re: /\baccept(?:ing|ance of)? (?:the|this|our|your) offer\b/, weight: MEDIUM },
    { label: "joining details", re: /\b(?:ctc|compensation|salary) (?:break[- ]?up|breakdown|structure)\b|\b(?:date of joining|joining date|joining bonus|joining formalities)\b/, weight: MEDIUM },
    { label: "welcome aboard", re: /\bwelcome (?:aboard|to the team)\b/, weight: MEDIUM },
    { label: "congratulations", re: /\bcongratulations\b/, weight: WEAK },
  ],
  RECRUITER_RESPONSE: [
    { label: "your profile", re: /\byour (?:profile|resume|cv|background)\b/, weight: WEAK },
    {
      label: "would like to discuss",
      re: /\b(?:would|'d) (?:like|love) to (?:discuss|connect|talk|speak|chat|get in touch|have a (?:quick )?(?:chat|conversation|word))\b/,
      weight: STRONG,
    },
    {
      label: "are you open to",
      re: /\bare you (?:open|interested|available) (?:to|in|for)\b|\bwould you be (?:open|interested|available)\b|\binterested in (?:exploring|this (?:role|opportunity|position))\b/,
      weight: STRONG,
    },
    { label: "came across your profile", re: /\b(?:came across|found|saw|reviewed|went through|looked at) your (?:profile|resume|cv)\b/, weight: MEDIUM },
    { label: "share your resume", re: /\b(?:share|send|forward|mail) (?:me |us )?your (?:updated |latest |recent )?(?:resume|cv|profile)\b/, weight: MEDIUM },
    { label: "CTC / notice period", re: /\b(?:current|expected|present) ctc\b|\bnotice period\b/, weight: MEDIUM },
    { label: "please revert", re: /\b(?:kindly|please) (?:revert|respond|reply)\b|\blook(?:ing)? forward to (?:hearing|your (?:reply|response))\b/, weight: WEAK },
    { label: "recruiter", re: /\b(?:recruiter|talent acquisition|talent partner|hr (?:team|executive|manager|recruiter))\b/, weight: WEAK },
  ],
};

/** Categories that describe a concrete step, highest priority first (ties resolve in this order). */
const SPECIFIC: SignalCategory[] = ["REJECTION", "OFFER", "INTERVIEW", "ASSESSMENT", "APPLICATION_CONFIRMATION"];

/** A sentence is "conditional" when it only talks about what may happen ("if shortlisted, we will ..."). */
const HEDGE_RE =
  /\b(?:if|in case|in the event|unless|whether|should (?:you|your|we|there))\b|\b(?:may|might|could|can) (?:include|involve|consist)\b|\b(?:typically|usually|generally|normally)\b|\b(?:may|might) (?:reach out|contact|get in touch|be in touch|invite|schedule|ask)\b/;
/** Polite conditionals that do not weaken a statement ("please let us know if Tuesday works"). */
const HEDGE_EXEMPT_RE =
  /\b(?:let (?:us|me) know|please (?:confirm|advise|check|reply|revert)|kindly (?:confirm|revert|let (?:us|me) know)) (?:if|whether)\b|\bif you (?:have|need) any (?:questions?|queries|help|assistance)\b/g;

const SUBJECT_PREFIX_RE = /^(?:\s*(?:re|fwd?|aw|wg|tr)\s*:)+\s*/i;

const CATEGORY_STATUS: Partial<Record<ApplicationMessageCategory, ApplicationStatus>> = {
  ASSESSMENT: "ASSESSMENT",
  INTERVIEW: "INTERVIEW",
  REJECTION: "REJECTED",
  OFFER: "OFFER",
};

// ---------------------------------------------------------------- text helpers

/** Lowercase, straight quotes, single spaces (keeps punctuation for sentence splitting). */
function normalizeText(s: string): string {
  return stripDiacritics(s)
    .toLowerCase()
    .replace(/[\u2018\u2019\u02bc`]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u00a0\u2007\u202f]/g, " ");
}

/**
 * Drop quoted reply history: "> ..." lines and everything after "On <date>, <name> wrote:" or an Outlook reply
 * separator followed by a "From:" header (the candidate's own earlier message must not be classified).
 */
function stripQuoted(text: string): string {
  const cut = /^[ \t]*on [^\n]{4,200}wrote:[ \t]*$|^[ \t]*(?:_{10,}|-{3,} ?original message ?-{3,})[ \t]*\r?\n[ \t*]*from\s*:/im.exec(text);
  const own = cut ? text.slice(0, cut.index) : text;
  return own
    .split(/\r?\n/)
    .filter((l) => !/^\s*>/.test(l))
    .join("\n");
}

function sentences(text: string): string[] {
  return text
    .split(/\r?\n+|(?<=[.!?;])\s+/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function isHedged(sentence: string): boolean {
  return HEDGE_RE.test(sentence.replace(HEDGE_EXEMPT_RE, " "));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Plain text of an email for classification: the text part, else the HTML part converted to text. */
export function statusEmailPlainText(text: string | null | undefined, html: string | null | undefined): string {
  return text && text.trim() ? text : htmlToText(html);
}

/** Subject without "Re:" / "Fwd:" prefixes. */
export function cleanStatusEmailSubject(subject: string): string {
  return subject.replace(SUBJECT_PREFIX_RE, "").replace(/\s+/g, " ").trim();
}

/** Sender domain of a From value ("Acme Talent <talent@acme.com>" -> "acme.com"), or null. */
export function statusEmailSenderDomain(from: string): string | null {
  const address = senderAddress(from);
  return address ? address.slice(address.lastIndexOf("@") + 1) : null;
}

// ---------------------------------------------------------------- forwarded emails

const FORWARD_MARKER_RE = /^[ \t>]*(?:-{3,} ?forwarded message ?-{3,}|begin forwarded message:)[ \t]*$/im;
/** Outlook uses the same separator for replies and forwards: it only marks a forward under a "FW:" subject. */
const SEPARATOR_RE = /^[ \t>]*(?:-{3,} ?original message ?-{3,}|_{10,})[ \t]*$/im;
const FORWARD_SUBJECT_RE = /^\s*(?:fwd?|tr|wg)\s*:/i;
const HEADER_LINE_RE = /^[ \t>*]*(from|de|von|sent|date|to|cc|subject|objet|betreff)\s*:\**[ \t]*(.*)$/i;
const HEADER_ALIASES: Record<string, string> = { de: "from", von: "from", objet: "subject", betreff: "subject" };

/**
 * A hand-forwarded email ("Fwd: ...", sent to the forwarding address by the user) carries the employer's
 * message below a "Forwarded message" header block: returns that original sender, subject and body. Any other
 * email is returned unchanged (apart from a stripped "Fwd:" prefix).
 */
export function unwrapForwardedStatusEmail(input: StatusEmailInput): StatusEmailInput {
  const text = input.text ?? "";
  const forwardedSubject = FORWARD_SUBJECT_RE.test(input.subject);
  const marker = FORWARD_MARKER_RE.exec(text) ?? (forwardedSubject ? SEPARATOR_RE.exec(text) : null);
  if (!marker && !forwardedSubject) return input;
  const lines = (marker ? text.slice(marker.index + marker[0].length) : text).split(/\r?\n/);
  let start = 0;
  while (start < lines.length && !lines[start]!.trim()) start++;
  const headers: Record<string, string> = {};
  let end = start;
  for (; end < lines.length; end++) {
    const m = HEADER_LINE_RE.exec(lines[end]!);
    if (!m) break;
    const key = m[1]!.toLowerCase();
    headers[HEADER_ALIASES[key] ?? key] ??= m[2]!.replace(/\*+/g, "").trim();
  }
  if (!headers.from || !senderAddress(headers.from)) return forwardedSubject ? { ...input, subject: cleanStatusEmailSubject(input.subject) } : input;
  return {
    from: headers.from,
    subject: headers.subject ? cleanStatusEmailSubject(headers.subject) : cleanStatusEmailSubject(input.subject),
    text: lines.slice(end).join("\n").trim(),
    receivedAt: input.receivedAt,
  };
}

// ---------------------------------------------------------------- classification

interface CategoryScore {
  category: SignalCategory;
  score: number;
  signals: string[];
}

function scoreCategory(category: SignalCategory, subject: string, bodySentences: { text: string; hedged: boolean }[]): CategoryScore {
  let score = 0;
  const signals: string[] = [];
  for (const rule of RULES[category]) {
    let best = 0;
    let where = "";
    if (rule.re.test(subject)) {
      best = rule.weight * SUBJECT_FACTOR;
      where = " (subject)";
    } else {
      for (const s of bodySentences) {
        if (!rule.re.test(s.text)) continue;
        const w = s.hedged ? rule.weight * HEDGED_FACTOR : rule.weight;
        if (w > best) {
          best = w;
          where = s.hedged ? " (conditional)" : "";
        }
        if (!s.hedged) break;
      }
    }
    if (best > 0) {
      score += best;
      signals.push(`${rule.label}${where}`);
    }
  }
  return { category, score: round2(score), signals };
}

const NAME_START = "[A-Z][^,.!?|()\\n:;]{1,58}?";
const NAME_END = "(?=\\s*[-\u2013|:(]|[,.!?;]|\\s+(?:for|in|on|is|has|and|we|from|to|as|about)\\b|\\s*$)";
const COMPANY_HINT_RES = [
  new RegExp(`\\b(?:applying|application|interest|interview) (?:to|with|at|in) (?:joining )?(${NAME_START})${NAME_END}`, "m"),
  new RegExp(`\\bgreetings from (${NAME_START})${NAME_END}`, "im"),
  new RegExp(`\\bwelcome to (${NAME_START})${NAME_END}`, "m"),
  new RegExp(` at (${NAME_START})${NAME_END}`, "m"),
];
/** "application for <title>", "the <Title> role". */
const TITLE_HINT_RES = [
  /\b(?:application|applying|applied|candidacy|interview|assessment|offer|shortlisted) for (?:the )?(?:position of |role of |post of )?([A-Za-z0-9][^,.!?|()\n:;]{1,78}?)(?:\s+(?:role|position|opening|job|post|vacancy))?(?=\s+(?:at|with|@|in)\s|\s*[-\u2013|:(]|[,.!?;]|\s*$)/im,
  /\b(?:the|our) ([A-Z][\w/+#.-]*(?: [A-Z][\w/+#.-]*){0,5}) (?:role|position|opening)\b/m,
];
/** "<title> at <company>" - subject only (in a body it matches ordinary sentences). */
const SUBJECT_TITLE_AT_RE = /(?:^|:\s*)([A-Z][^,.!?|()\n:;]{1,78}?) at [A-Z]/;
const NOT_A_TITLE_RE = /^(?:your|our|my|an?|the|this|that)\b|\b(?:application|applying|interview|invitation|update|thank|congratulations|status|regarding|next steps?|confirmation)\b/i;
const NOT_A_COMPANY_RE = /^(?:the|this|that|your|our|a|an|we|you|least|most|any|all|this time)\b/i;

function tidyHint(s: string | undefined): string | null {
  const v = s?.replace(/\s+/g, " ").replace(/[\s'"-]+$/, "").trim();
  return v && v.length >= 2 && v.length <= 80 ? v : null;
}

function firstHint(res: RegExp[], src: string, reject: RegExp): string | null {
  for (const re of res) {
    const hint = tidyHint(re.exec(src)?.[1]);
    if (hint && !reject.test(hint)) return hint;
  }
  return null;
}

/** Company / job title mentioned in the subject (preferred) or the start of the body. Informational only. */
function extractHints(subject: string, body: string): { companyHint: string | null; titleHint: string | null } {
  const head = body.slice(0, 1500);
  const titleHint = firstHint([...TITLE_HINT_RES, SUBJECT_TITLE_AT_RE], subject, NOT_A_TITLE_RE) ?? firstHint(TITLE_HINT_RES, head, NOT_A_TITLE_RE);
  let companyHint = firstHint(COMPANY_HINT_RES, subject, NOT_A_COMPANY_RE) ?? firstHint(COMPANY_HINT_RES, head, NOT_A_COMPANY_RE);
  if (!companyHint) {
    // "Application received - Acme Corp" (unless that tail is the job title). Weakest: a tail is often a city.
    const tail = tidyHint(/\s[-\u2013|]\s*([A-Z][^-\u2013|\n]{1,58})$/.exec(subject)?.[1]);
    if (tail && !NOT_A_TITLE_RE.test(tail) && tail !== titleHint) companyHint = tail;
  }
  return { companyHint, titleHint };
}

/**
 * Classify an employer email (confirmation / recruiter response / assessment / interview / rejection / offer /
 * other). Pure and deterministic: the same input always gives the same result.
 */
export function classifyStatusEmail(input: StatusEmailInput): StatusEmailClassification {
  const rawSubject = cleanStatusEmailSubject(input.subject ?? "");
  const rawBody = stripQuoted((input.text ?? "").slice(0, MAX_BODY_CHARS));
  const subject = normalizeText(rawSubject).replace(/\s+/g, " ");
  const bodySentences = sentences(normalizeText(rawBody)).map((text) => ({ text, hedged: isHedged(text) }));
  const fromDomain = statusEmailSenderDomain(input.from ?? "");
  const { companyHint, titleHint } = extractHints(rawSubject, rawBody);

  const scores = {} as Record<SignalCategory, CategoryScore>;
  for (const c of [...SPECIFIC, "RECRUITER_RESPONSE"] as SignalCategory[]) scores[c] = scoreCategory(c, subject, bodySentences);

  const base = { companyHint, titleHint, fromDomain };
  const specific = SPECIFIC.map((c) => scores[c]).sort((a, b) => b.score - a.score || SPECIFIC.indexOf(a.category) - SPECIFIC.indexOf(b.category));
  const recruiter = scores.RECRUITER_RESPONSE;
  if (specific[0]!.score === 0 && recruiter.score === 0) return { category: "OTHER", confidence: 0, signals: [], ...base };

  // A clear rejection wins over everything it mentions (the interview it follows, "thank you for applying");
  // a clear offer wins over the interview / assessment it follows.
  for (const c of ["REJECTION", "OFFER"] as const) {
    if (scores[c].score >= OVERRIDE_SCORE) {
      const overridden = specific.filter((s) => s.category !== c && s.score > 0).map((s) => `overrides ${s.category.toLowerCase()}`);
      return { category: c, confidence: round2(Math.min(MAX_CONFIDENCE, scores[c].score)), signals: [...scores[c].signals, ...overridden], ...base };
    }
  }

  const best = specific[0]!;
  // A recruiter response is "none of the above": only when no specific step has a clear signal.
  const winner = best.score > 0 && (best.score >= OVERRIDE_SCORE || best.score >= recruiter.score) ? best : recruiter;
  const runnerUp = winner === recruiter ? best.score : Math.max(0, ...specific.filter((s) => s !== best).map((s) => s.score));
  const ambiguity = winner.score > 0 ? Math.min(1, runnerUp / winner.score) : 0;
  const confidence = round2(Math.min(MAX_CONFIDENCE, winner.score) * (1 - 0.3 * ambiguity));
  return { category: winner.category, confidence, signals: winner.signals, ...base };
}

// ---------------------------------------------------------------- association

/** Mail providers, job boards and ATS platforms send on behalf of many companies: their domain proves nothing. */
const SHARED_SENDER_DOMAINS = [
  ...ALERT_SENDERS.flatMap((s) => s.domains),
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "yahoo.com",
  "yahoo.co.in",
  "rediffmail.com",
  "icloud.com",
  "proton.me",
  "protonmail.com",
  "zoho.com",
  "zohomail.in",
  "greenhouse.io",
  "greenhouse-mail.io",
  "lever.co",
  "ashbyhq.com",
  "myworkday.com",
  "workday.com",
  "smartrecruiters.com",
  "workable.com",
  "workablemail.com",
  "recruitee.com",
  "icims.com",
  "taleo.net",
  "successfactors.com",
  "jobvite.com",
  "bamboohr.com",
  "freshteam.com",
  "zohorecruit.com",
  "keka.com",
  "darwinbox.in",
  "hackerrank.com",
  "hackerearth.com",
  "mettl.com",
  "calendly.com",
];

const TWO_LEVEL_SUFFIX_RE = /^(?:co|com|net|org|ac|gov|edu|ltd|plc|firm|gen|ind|res)\.[a-z]{2}$/;

function isSharedDomain(domain: string): boolean {
  return SHARED_SENDER_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`));
}

function registrableDomain(host: string): string {
  const labels = host.toLowerCase().replace(/^www\./, "").split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const last2 = labels.slice(-2).join(".");
  return TWO_LEVEL_SUFFIX_RE.test(last2) ? labels.slice(-3).join(".") : last2;
}

/** Domain labels without the public suffix: "careers.acme.co.in" -> ["careers", "acme"]. */
function domainNameLabels(domain: string): string[] {
  const labels = domain.split(".");
  const suffix = TWO_LEVEL_SUFFIX_RE.test(labels.slice(-2).join(".")) ? 2 : 1;
  return labels.slice(0, Math.max(0, labels.length - suffix));
}

function websiteHost(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(/^https?:\/\//i.test(url.trim()) ? url.trim() : `https://${url.trim()}`).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/** Words for phrase matching: lowercase, no diacritics/apostrophes, non-alphanumerics as single spaces. */
function matchWords(s: string): string {
  return stripDiacritics(s)
    .toLowerCase()
    .replace(/['\u2019]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function companyForms(company: string): { phrases: string[]; keys: string[] } {
  const p = nameParts(company);
  if (!p) return { phrases: [], keys: [] };
  const phrases = new Set([p.hyphen.replace(/-/g, " "), p.brandHyphen.replace(/-/g, " ")]);
  if (p.compact.length >= 4) phrases.add(p.compact);
  return { phrases: [...phrases].filter((s) => s.length >= 2), keys: [...new Set([p.compact, p.brand])].filter((k) => k.length >= 2) };
}

const TITLE_STOP_WORDS = new Set(["and", "the", "of", "for", "a", "an", "to", "in", "at", "with", "or"]);

interface ScoredRef {
  ref: StatusEmailApplicationRef;
  raw: number;
  by: string[];
}

/**
 * Link a classified email to one of the user's sent applications. Signals: sender domain = company website
 * domain, or the company name inside the sender domain (strong); the company name in the subject/body (medium);
 * the job title in the subject/body (medium). Returns the best application only when its confidence reaches
 * STATUS_EMAIL_MIN_CONFIDENCE and no other application scores within 0.1 of it; otherwise applicationId is null.
 */
export function associateStatusEmail(classification: StatusEmailClassification, input: StatusEmailInput, applications: StatusEmailApplicationRef[]): StatusEmailAssociation {
  const none: StatusEmailAssociation = { applicationId: null, confidence: 0, associatedBy: null };
  if (applications.length === 0) return none;
  const fromDomain = classification.fromDomain ?? statusEmailSenderDomain(input.from ?? "");
  const domainUsable = fromDomain !== null && !isSharedDomain(fromDomain);
  const subject = ` ${matchWords(cleanStatusEmailSubject(input.subject ?? ""))} `;
  const body = ` ${matchWords(stripQuoted((input.text ?? "").slice(0, MAX_BODY_CHARS)))} `;
  const bodyWords = new Set(body.trim().split(" "));
  const subjectWords = new Set(subject.trim().split(" "));
  // Sender display name + mailbox name ("Acme Recruiting <jobs@greenhouse.io>", "acme@myworkday.com"); the
  // domain is scored separately above.
  const address = senderAddress(input.from ?? "");
  const displayName = (input.from ?? "").replace(/<[^>]*>/g, " ").replace(/[^\s<>"'(),;:]+@[^\s<>"'(),;:]+/g, " ");
  const sender = ` ${matchWords(`${displayName} ${address ? address.slice(0, address.lastIndexOf("@")) : ""}`)} `;
  const received = Date.parse(input.receivedAt);

  const scored: ScoredRef[] = [];
  for (const ref of applications) {
    const sent = ref.sentAt ? Date.parse(ref.sentAt) : NaN;
    if (Number.isFinite(received) && Number.isFinite(sent) && received < sent - SENT_SLACK_MS) continue;
    let raw = 0;
    const by: string[] = [];

    // Sender domain (strong).
    if (domainUsable) {
      const site = websiteHost(ref.companyWebsite);
      const { keys } = companyForms(ref.company);
      if (site && !isSharedDomain(site) && registrableDomain(site) === registrableDomain(fromDomain)) {
        raw += 0.7;
        by.push("domain");
      } else {
        // The company name is a label of the domain ("globexsystems.com") or part of one ("acmetestcareers.com").
        const labels = domainNameLabels(fromDomain).map((l) => l.replace(/-/g, ""));
        if (labels.some((l) => keys.includes(l))) {
          raw += 0.7;
          by.push("domain");
        } else if (labels.some((l) => keys.some((k) => k.length >= 5 && l.includes(k)))) {
          raw += 0.6;
          by.push("domain~");
        }
      }
    }

    // Company name in the subject / body (medium); the sender's name or mailbox (e.g. acme@myworkday.com) as a fallback.
    const { phrases } = companyForms(ref.company);
    if (phrases.some((p) => subject.includes(` ${p} `))) {
      raw += 0.45;
      by.push("company");
    } else if (phrases.some((p) => body.includes(` ${p} `))) {
      raw += 0.4;
      by.push("company");
    } else if (phrases.some((p) => p.length >= 4 && sender.includes(` ${p} `))) {
      raw += 0.35;
      by.push("sender");
    }

    // Job title in the subject / body (medium).
    const title = matchWords(ref.title);
    const tokens = title.split(" ").filter((t) => t && !TITLE_STOP_WORDS.has(t));
    if (title && subject.includes(` ${title} `)) {
      raw += 0.4;
      by.push("title");
    } else if (title && body.includes(` ${title} `)) {
      raw += 0.35;
      by.push("title");
    } else if (tokens.length >= 2) {
      const hits = tokens.filter((t) => subjectWords.has(t) || bodyWords.has(t)).length;
      if (hits === tokens.length) {
        raw += 0.3;
        by.push("title");
      } else if (tokens.length >= 3 && hits >= 2 && hits * 3 >= tokens.length * 2) {
        raw += 0.2;
        by.push("title~");
      }
    }
    if (raw > 0) scored.push({ ref, raw: round2(raw), by });
  }
  if (scored.length === 0) return none;
  scored.sort((a, b) => b.raw - a.raw);
  const [best, second] = scored as [ScoredRef, ScoredRef | undefined];
  const confidence = round2(Math.min(0.99, best.raw));
  if (confidence < STATUS_EMAIL_MIN_CONFIDENCE) return { applicationId: null, confidence, associatedBy: null };
  // Compare raw sums (before the cap): two applications at the same company only differ by the title signal.
  if (second && best.raw - second.raw < AMBIGUITY_MARGIN) return { applicationId: null, confidence, associatedBy: null };
  return { applicationId: best.ref.applicationId, confidence, associatedBy: best.by.join("+") };
}

/** Application status a category moves an application to (null = informational only). */
export function statusForMessageCategory(category: ApplicationMessageCategory): ApplicationStatus | null {
  return CATEGORY_STATUS[category] ?? null;
}
