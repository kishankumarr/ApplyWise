import "server-only";
import type { NextRequest } from "next/server";
import { prisma, type AnswerSource, type ApplicationMode, type ApplicationStatus, type ManualActionReason, type Prisma, type ScreeningAnswerDraft } from "@applywise/database";
import { MANUAL_ACTION_REASON_LABELS } from "@applywise/types";
import { env } from "@/env";
import { audit } from "../audit";
import { randomToken, sha256Hex, signToken, verifyToken } from "../crypto";
import { Errors } from "../errors";

/**
 * Browser-extension integration.
 * - The extension authenticates with a revocable personal token (stored hashed).
 * - Manual handoffs: the extension lists the applications the user has to apply to themselves
 *   (automation stopped, failed, or the user applies manually) - job title, company, apply URL and
 *   the reason only; never secrets, CV text, answers or cover letters.
 * - Prefill uses a short-lived (10 min) signed code for ONE application the user applies to
 *   themselves (approved, handed off, failed or apply page opened) - never while the automation will still
 *   submit it (queued, or an automatic retry scheduled; checked when the code is issued and when it is
 *   resolved). The code is created in the web app (session), resolved by the extension (bearer token), and
 *   bound to the owner.
 * - The payload contains profile values, verified/reviewed screening answers and the cover letter;
 *   the extension shows them before filling, fills only fields the user selects, and never submits.
 */

const TOKEN_PREFIX = "awx_";
const TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export const PREFILL_TTL_MS = 10 * 60 * 1000;

/**
 * Statuses in which the user applies on the official page themselves, so extension prefill is allowed:
 * approved (manual flow), apply page opened, manual handoff, and failed automation.
 */
export const PREFILL_STATUSES: readonly ApplicationStatus[] = ["APPROVED", "OPENED_APPLY_PAGE", "MANUAL_ACTION_REQUIRED", "FAILED"];

/** Maximum number of manual handoffs returned to the extension. */
export const HANDOFF_LIMIT = 20;

/**
 * Applications that need a manual application: handed off or failed automation, the apply page the user
 * already opened, and approved applications the user applies to themselves (mode MANUAL or no automation
 * mode). Excluded because an executor will still submit them: APPROVED applications in REVIEW/AUTO mode, and
 * FAILED ones in REVIEW/AUTO mode with an automatic retry scheduled (nextActionAt set).
 */
const HANDOFF_WHERE = (userId: string): Prisma.ApplicationWhereInput => ({
  userId,
  OR: [
    { status: "OPENED_APPLY_PAGE" },
    { status: { in: ["FAILED", "MANUAL_ACTION_REQUIRED"] }, OR: [{ nextActionAt: null }, { mode: null }, { mode: "MANUAL" }] },
    { status: "APPROVED", OR: [{ mode: null }, { mode: "MANUAL" }] },
  ],
});

/**
 * Why the user must not apply by hand right now although the status allows a prefill: the automation will still
 * submit it (queued, or an automatic retry is scheduled), so applying by hand as well could send it twice. Checked
 * when a prefill code is issued AND when it is resolved (the application may have changed in between).
 */
export function prefillBlockedReason(a: { status: ApplicationStatus; mode: ApplicationMode | null; nextActionAt: Date | null }): string | null {
  const automated = a.mode === "REVIEW" || a.mode === "AUTO";
  if (!automated) return null;
  if (a.status === "APPROVED") {
    return "This application is queued for automatic submission. If you prefer to apply yourself, decline it here and apply manually, or wait for the handoff.";
  }
  if ((a.status === "FAILED" || a.status === "MANUAL_ACTION_REQUIRED") && a.nextActionAt) {
    return "An automatic retry is scheduled for this application. Wait for it to finish (or decline the application) before applying yourself.";
  }
  return null;
}

/** One manual handoff as the extension sees it (no secrets, CV text, answers or cover letters). */
export interface ExtensionHandoffItem {
  applicationId: string;
  status: ApplicationStatus;
  job: { title: string; company: string; applyUrl: string | null };
  reason: ManualActionReason | null;
  reasonLabel: string;
  reasonDetail: string | null;
  updatedAt: string;
}

const REASON_DETAIL_MAX = 300;

function handoffReasonLabel(status: ApplicationStatus, reason: ManualActionReason | null): string {
  if (reason) return MANUAL_ACTION_REASON_LABELS[reason];
  switch (status) {
    case "FAILED":
      return "Automation could not finish this application - apply on the employer's page";
    case "OPENED_APPLY_PAGE":
      return "Apply page opened - complete and submit the form yourself";
    case "APPROVED":
      return "Approved - apply on the employer's page yourself";
    default:
      return "Automation needs you to finish this application";
  }
}

/** Answer sources that are verified data or user-authored answers (see the answer resolver). */
const VERIFIED_ANSWER_SOURCES: readonly AnswerSource[] = ["PROFILE", "PREFERENCE", "TRUTH_BANK", "PREVIOUS_ANSWER", "CANDIDATE_ANSWER"];

type DraftForPrefill = Pick<ScreeningAnswerDraft, "answer" | "originalAnswer" | "status" | "resolved" | "answerSource" | "canConfirm">;

const isEditedDraft = (d: DraftForPrefill) => d.status === "EDITED" || d.answer !== d.originalAnswer;

/**
 * Whether a screening-answer draft may be offered for prefill (truth model): it must be resolved and non-empty,
 * and either the user wrote/edited it, it came from verified data or the user's own answers, or it is a generated
 * draft that cites verified facts (canConfirm). Unresolved questions and the "cannot confirm" placeholder are
 * never offered - the extension lists them as questions the user answers themselves.
 */
export function isOfferableAnswer(d: DraftForPrefill): boolean {
  if (!d.resolved || !d.answer.trim()) return false;
  if (isEditedDraft(d) || VERIFIED_ANSWER_SOURCES.includes(d.answerSource)) return true;
  return d.answerSource === "GENERATED" && d.canConfirm;
}

/**
 * Whether an offered answer was already reviewed: written/edited by the user, taken from verified data, approved
 * by the user, or approved by the AUTO policy (after truth validation). Unreviewed answers start unselected in the
 * extension.
 */
export function isReviewedAnswer(d: DraftForPrefill, approvalSource: string | null): boolean {
  return isEditedDraft(d) || VERIFIED_ANSWER_SOURCES.includes(d.answerSource) || d.status === "APPROVED" || approvalSource === "policy";
}

/** Required questions recorded on the application that have no verified answer: [{ key, question, required }]. */
function pendingQuestionTexts(value: Prisma.JsonValue): { question: string; required: boolean }[] {
  if (!Array.isArray(value)) return [];
  const out: { question: string; required: boolean }[] = [];
  for (const q of value) {
    if (q && typeof q === "object" && !Array.isArray(q) && typeof q.question === "string" && q.question.trim()) {
      out.push({ question: q.question.trim().slice(0, 500), required: q.required === true });
    }
  }
  return out;
}

function allowedOrigin(origin: string | null): string | null {
  if (!origin) return null;
  const list = env().EXTENSION_ORIGINS;
  if (list.includes(origin)) return origin;
  // Development convenience: unpacked extensions get random ids.
  if (env().NODE_ENV !== "production" && /^(chrome|moz)-extension:\/\//.test(origin)) return origin;
  return null;
}

export function extensionCorsHeaders(req: NextRequest): Record<string, string> {
  const origin = allowedOrigin(req.headers.get("origin"));
  if (!origin) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-max-age": "600",
    vary: "Origin",
  };
}

export async function authenticateExtensionRequest(req: NextRequest): Promise<{ userId: string | null; corsHeaders: Record<string, string> }> {
  const corsHeaders = extensionCorsHeaders(req);
  const origin = req.headers.get("origin");
  // Cross-origin calls must come from an allowed extension origin.
  if (origin && !Object.keys(corsHeaders).length && new URL(req.url).origin !== origin) throw Errors.forbidden("Origin not allowed.");
  const header = req.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return { userId: null, corsHeaders };
  const token = header.slice(7).trim();
  if (!token.startsWith(TOKEN_PREFIX)) throw Errors.unauthenticated();
  const row = await prisma.extensionToken.findUnique({ where: { tokenHash: sha256Hex(token) } });
  if (!row || row.revokedAt || row.expiresAt < new Date()) throw Errors.unauthenticated();
  await prisma.extensionToken.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } });
  return { userId: row.userId, corsHeaders };
}

export const extensionService = {
  async createToken(userId: string, name: string, requestId?: string) {
    const token = `${TOKEN_PREFIX}${randomToken(32)}`;
    const row = await prisma.extensionToken.create({
      data: { userId, name: name.slice(0, 60) || "Browser extension", tokenHash: sha256Hex(token), expiresAt: new Date(Date.now() + TOKEN_TTL_MS) },
      select: { id: true, name: true, expiresAt: true, createdAt: true },
    });
    await audit(userId, "extension.token_created", { requestId, entityType: "ExtensionToken", entityId: row.id });
    // The plaintext token is returned exactly once.
    return { ...row, token };
  },

  listTokens(userId: string) {
    return prisma.extensionToken.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      select: { id: true, name: true, createdAt: true, lastUsedAt: true, expiresAt: true, revokedAt: true },
    });
  },

  async revokeToken(userId: string, tokenId: string, requestId?: string) {
    const res = await prisma.extensionToken.updateMany({ where: { id: tokenId, userId, revokedAt: null }, data: { revokedAt: new Date() } });
    if (res.count === 0) throw Errors.notFound("Token");
    await audit(userId, "extension.token_revoked", { requestId, entityType: "ExtensionToken", entityId: tokenId });
    return { revoked: true };
  },

  /**
   * Manual handoffs for the extension popup: the owner's applications that need a manual application,
   * newest first, at most HANDOFF_LIMIT. Only job title/company/apply URL and the reason are returned.
   */
  async listHandoffs(userId: string): Promise<{ items: ExtensionHandoffItem[]; total: number }> {
    const where = HANDOFF_WHERE(userId);
    const [rows, total] = await Promise.all([
      prisma.application.findMany({
        where,
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        take: HANDOFF_LIMIT,
        select: {
          id: true,
          status: true,
          manualActionReason: true,
          manualActionDetail: true,
          failureReason: true,
          updatedAt: true,
          job: { select: { title: true, company: true, applyUrl: true } },
        },
      }),
      prisma.application.count({ where }),
    ]);
    const items = rows.map((a): ExtensionHandoffItem => {
      // A reason recorded by an earlier attempt is stale once a retry failed; FAILED reports its own detail.
      const reason = a.status === "MANUAL_ACTION_REQUIRED" || a.status === "OPENED_APPLY_PAGE" ? a.manualActionReason : null;
      const detail = a.status === "FAILED" ? a.failureReason : reason ? a.manualActionDetail : null;
      return {
        applicationId: a.id,
        status: a.status,
        job: { title: a.job.title, company: a.job.company, applyUrl: a.job.applyUrl },
        reason,
        reasonLabel: handoffReasonLabel(a.status, reason),
        reasonDetail: detail?.trim() ? detail.trim().slice(0, REASON_DETAIL_MAX) : null,
        updatedAt: a.updatedAt.toISOString(),
      };
    });
    return { items, total };
  },

  /** Issue a short-lived prefill code for an application the user applies to themselves (see PREFILL_STATUSES). */
  async issuePrefill(userId: string, applicationId: string, requestId?: string) {
    const app = await prisma.application.findFirst({ where: { id: applicationId, userId }, select: { id: true, status: true, mode: true, nextActionAt: true } });
    if (!app) throw Errors.notFound("Application");
    if (!PREFILL_STATUSES.includes(app.status)) {
      throw Errors.invalidState("Extension prefill is available once the application is approved or handed over to you for a manual application.");
    }
    // The automation will still submit it (queued, or a retry is scheduled): applying by hand as well could send it twice.
    const blocked = prefillBlockedReason(app);
    if (blocked) throw Errors.invalidState(blocked);
    const code = signToken("prefill", { userId, applicationId }, PREFILL_TTL_MS);
    await audit(userId, "extension.prefill_issued", { requestId, entityType: "Application", entityId: applicationId });
    return { code, expiresAt: new Date(Date.now() + PREFILL_TTL_MS).toISOString() };
  },

  /** Resolve a prefill code into the field list the user reviews in the extension (minimal data only). */
  async resolvePrefill(userId: string, code: string) {
    let payload: { userId: string; applicationId: string };
    try {
      payload = verifyToken<{ userId: string; applicationId: string }>("prefill", code);
    } catch {
      throw Errors.forbidden("This prefill code is invalid or has expired. Create a new one from the application page.");
    }
    if (payload.userId !== userId) throw Errors.forbidden("This prefill code belongs to another account.");
    const app = await prisma.application.findFirst({
      where: { id: payload.applicationId, userId },
      include: { job: { select: { title: true, company: true, applyUrl: true } }, coverLetter: true, screeningDrafts: { orderBy: { sortOrder: "asc" } } },
    });
    if (!app || !PREFILL_STATUSES.includes(app.status)) throw Errors.invalidState("This application is no longer waiting for you to apply. Check it in ApplyWise.");
    // Re-checked here: since the code was issued the application may have been queued for submission again.
    const blocked = prefillBlockedReason(app);
    if (blocked) throw Errors.invalidState(blocked);
    const profile = await prisma.candidateProfile.findUnique({ where: { userId }, include: { preference: true } });
    // The prepared cover letter (verified facts only); the user reviews it in the extension before filling.
    const coverLetter = app.coverLetter?.body.trim() ? app.coverLetter.body : null;
    const [firstName, ...rest] = (profile?.fullName ?? "").split(/\s+/);
    const fields: { key: string; label: string; value: string }[] = [
      { key: "fullName", label: "Full name", value: profile?.fullName ?? "" },
      { key: "firstName", label: "First name", value: firstName ?? "" },
      { key: "lastName", label: "Last name", value: rest.join(" ") },
      { key: "email", label: "Email", value: profile?.email ?? "" },
      { key: "phone", label: "Phone", value: profile?.phone ?? "" },
      { key: "location", label: "Current location", value: profile?.preference?.preferredLocations.find((l) => !/remote/i.test(l)) ?? "" },
      { key: "linkedin", label: "LinkedIn URL", value: profile?.linkedinUrl ?? "" },
      { key: "github", label: "GitHub URL", value: profile?.githubUrl ?? "" },
      { key: "portfolio", label: "Portfolio / website", value: profile?.portfolioUrl ?? "" },
      { key: "currentTitle", label: "Current title", value: profile?.currentTitle ?? "" },
      { key: "currentCompany", label: "Current company", value: profile?.currentCompany ?? "" },
      { key: "yoe", label: "Years of experience", value: profile?.yoe != null ? String(profile.yoe) : "" },
      { key: "noticePeriod", label: "Notice period", value: profile?.preference?.noticePeriod ?? "" },
      { key: "coverLetter", label: "Cover letter", value: coverLetter ?? "" },
    ].filter((f) => f.value);
    const offered = app.screeningDrafts.filter((d) => isOfferableAnswer(d));
    const answered = new Set(offered.map((d) => d.question.trim().toLowerCase()));
    const openQuestions: { question: string; required: boolean }[] = [];
    for (const q of [...app.screeningDrafts.filter((d) => !isOfferableAnswer(d)), ...pendingQuestionTexts(app.pendingQuestions)]) {
      const key = q.question.trim().toLowerCase();
      if (!key || answered.has(key)) continue;
      answered.add(key);
      openQuestions.push({ question: q.question.trim(), required: q.required });
    }
    return {
      applicationId: app.id,
      status: app.status,
      job: app.job,
      fields,
      screeningAnswers: offered.map((d) => ({
        question: d.question,
        answer: d.answer,
        key: d.questionKey,
        source: d.answerSource,
        reviewed: isReviewedAnswer(d, app.approvalSource),
      })),
      coverLetter,
      coverLetterReviewed: coverLetter !== null && (app.coverLetter?.status !== "PROPOSED" || app.approvalSource === "policy"),
      openQuestions,
      resumeDownloadPath: `/applications/${app.id}`,
      policy: "Review every field before filling. The extension never uploads files and never clicks Submit.",
    };
  },
};
