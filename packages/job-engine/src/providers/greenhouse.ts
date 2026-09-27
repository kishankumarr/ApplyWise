import { cleanSlug } from "../feeds/boards/shared";
import { FeedProviderError, type FeedContext } from "../feeds/types";
import { asArray, asString, httpJson, stripTags } from "../feeds/util";
import type { ApplicationRequirements, ProviderJobRef, ProviderQuestion, ProviderRuntime } from "./types";

/**
 * Greenhouse application questions from the official public Job Board API:
 * GET https://boards-api.greenhouse.io/v1/boards/{board_token}/jobs/{job_id}?questions=true
 * (no authentication; docs: https://developers.greenhouse.io/job-board.html#retrieve-a-job).
 * Only the documented JSON API is called - never a job page - with the shared feed timeout and User-Agent.
 */

const API = "https://boards-api.greenhouse.io/v1/boards";
const LABEL = "Greenhouse";
const BOARD_HOST_RE = /^(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io$/;
const JOB_ID_RE = /^\d{1,20}$/;

export interface GreenhousePostingRef {
  boardToken: string;
  jobId: string;
}

interface GreenhouseFieldValue {
  label?: unknown;
  value?: unknown;
}

interface GreenhouseField {
  name?: unknown;
  type?: unknown;
  values?: GreenhouseFieldValue[] | null;
}

interface GreenhouseQuestion {
  required?: unknown;
  label?: unknown;
  description?: unknown;
  fields?: GreenhouseField[] | null;
}

/** The subset of the Job Board API "job" payload used here. */
export interface GreenhousePosting {
  id?: unknown;
  title?: unknown;
  questions?: GreenhouseQuestion[] | null;
  location_questions?: GreenhouseQuestion[] | null;
  compliance?: { type?: unknown; description?: unknown; questions?: GreenhouseQuestion[] | null }[] | null;
}

function ref(token: string | null | undefined, id: string | null | undefined): GreenhousePostingRef | null {
  const boardToken = cleanSlug(token ?? null);
  const jobId = (id ?? "").trim();
  return boardToken && JOB_ID_RE.test(jobId) ? { boardToken, jobId } : null;
}

/**
 * Board token + job id from a Greenhouse job link: boards.greenhouse.io/{token}/jobs/{id},
 * job-boards(.eu).greenhouse.io/{token}/jobs/{id}, the embed form (/embed/job_app?for={token}&token={id}) or the
 * API URL itself. Returns null for anything else (company sites embedding Greenhouse included).
 */
export function parseGreenhousePostingUrl(input: string | null | undefined): GreenhousePostingRef | null {
  if (!input || typeof input !== "string") return null;
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase();
  const segs = url.pathname.split("/").filter(Boolean);
  if (BOARD_HOST_RE.test(host)) {
    if (segs[0] === "embed") return ref(url.searchParams.get("for"), url.searchParams.get("token"));
    return segs[1] === "jobs" ? ref(segs[0], segs[2]) : null;
  }
  if (host === "boards-api.greenhouse.io" && segs[0] === "v1" && segs[1] === "boards" && segs[3] === "jobs") return ref(segs[2], segs[4]);
  return null;
}

/** "greenhouse:{token}:{id}" as written by the Greenhouse board adapter (JobSource.externalId). */
export function parseGreenhouseExternalId(externalId: string | null | undefined): GreenhousePostingRef | null {
  const m = /^greenhouse:([^:]+):(\d{1,20})$/.exec(externalId ?? "");
  return m ? ref(m[1], m[2]) : null;
}

/** Custom link questions are named question_<id>, so the label is checked too ("LinkedIn Profile", "Website"). */
const URL_FIELD_RE = /\b(?:linkedin|website|portfolio|github|url|blog)\b/i;

function inputTypeFor(field: GreenhouseField, label: string): ProviderQuestion["inputType"] {
  const type = asString(field.type) ?? "";
  const name = asString(field.name) ?? "";
  switch (type) {
    case "input_file":
      return "file";
    case "textarea":
      return "textarea";
    case "multi_value_single_select":
    case "multi_value_multi_select":
      return "select";
    default:
      if (/^email$/i.test(name)) return "email";
      if (URL_FIELD_RE.test(name.replace(/_/g, " ")) || URL_FIELD_RE.test(label)) return "url";
      return "text";
  }
}

function toQuestion(q: GreenhouseQuestion): ProviderQuestion | null {
  const label = stripTags(asString(q?.label) ?? "");
  // A question may offer several inputs (e.g. resume upload or resume text): the first visible one is used.
  const field = asArray(q?.fields).find((f) => f && typeof f === "object" && asString(f.type) !== "input_hidden");
  if (!label || !field) return null;
  const inputType = inputTypeFor(field, label);
  const options =
    inputType === "select"
      ? asArray(field.values)
          .map((v) => stripTags(asString(v?.label) ?? ""))
          .filter(Boolean)
      : [];
  return {
    question: label.slice(0, 500),
    required: q.required === true,
    inputType,
    options: options.length > 0 ? options : null,
    providerKey: asString(field.name) ?? null,
  };
}

/**
 * Application questions of a Job Board API posting: the form questions and location questions, plus
 * compliance questions only when the employer marked them required (voluntary self-identification questions
 * are never answered automatically). Deduplicated by field name.
 */
export function greenhouseQuestionsFromPosting(posting: GreenhousePosting): ProviderQuestion[] {
  const raw = [
    ...asArray(posting?.questions),
    ...asArray(posting?.location_questions),
    ...asArray(posting?.compliance).flatMap((c) => asArray(c?.questions).filter((q) => q?.required === true)),
  ];
  const out: ProviderQuestion[] = [];
  const seen = new Set<string>();
  for (const q of raw) {
    const question = toQuestion(q);
    if (!question) continue;
    const key = question.providerKey ?? `label:${question.question.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(question);
  }
  return out;
}

/** The posting behind a job: its apply URL, else its source URL, else the board adapter's external id. */
export function greenhousePostingForJob(job: Pick<ProviderJobRef, "applyUrl" | "sourceUrl" | "sourceExternalId">): GreenhousePostingRef | null {
  return parseGreenhousePostingUrl(job.applyUrl) ?? parseGreenhousePostingUrl(job.sourceUrl) ?? parseGreenhouseExternalId(job.sourceExternalId);
}

/** Requirements derived from a posting's questions (standard Greenhouse field names: resume, cover_letter). */
export function greenhouseRequirementsFromPosting(posting: GreenhousePosting): ApplicationRequirements {
  const questions = greenhouseQuestionsFromPosting(posting);
  const skippedVoluntary = asArray(posting?.compliance).some((c) => asArray(c?.questions).some((q) => q?.required !== true));
  const notes = ["Questions from Greenhouse's official public Job Board API."];
  if (skippedVoluntary) notes.push("Voluntary self-identification questions were left out: they are never answered automatically.");
  return {
    questions,
    requiresLogin: false,
    requiresResume: questions.some((q) => q.providerKey === "resume" && q.required),
    acceptsCoverLetter: questions.some((q) => q.providerKey === "cover_letter"),
    notes,
  };
}

/**
 * Fetch a job's application questions from the Job Board API. Throws FeedProviderError: non-retryable when the
 * job's links do not identify a Greenhouse posting or the posting is gone; retryable for timeouts, 429 and 5xx.
 */
export async function fetchGreenhouseApplicationRequirements(
  job: Pick<ProviderJobRef, "applyUrl" | "sourceUrl" | "sourceExternalId">,
  runtime: ProviderRuntime,
): Promise<ApplicationRequirements> {
  const posting = greenhousePostingForJob(job);
  if (!posting) throw new FeedProviderError("This job's links do not identify a Greenhouse job posting.", false);
  const ctx: FeedContext = { fetch: runtime.fetch, env: runtime.env, now: runtime.now, signal: runtime.signal };
  const url = `${API}/${encodeURIComponent(posting.boardToken)}/jobs/${encodeURIComponent(posting.jobId)}?questions=true`;
  const data = await httpJson<GreenhousePosting>(url, ctx, { label: LABEL, allowNotFound: true });
  if (!data || typeof data !== "object") throw new FeedProviderError("The Greenhouse job posting was not found. It may have closed.", false, 404);
  return greenhouseRequirementsFromPosting(data);
}
