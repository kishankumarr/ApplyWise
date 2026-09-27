import { NextRequest } from "next/server";
import { beforeAll, describe, expect, it } from "vitest";
import { prisma, type ApplicationMode, type ApplicationStatus, type ManualActionReason, type Prisma } from "@applywise/database";
import { MANUAL_ACTION_REASON_LABELS } from "@applywise/types";
import { GET as handoffsGET } from "@/app/api/extension/handoffs/route";
import { GET as prefillGET } from "@/app/api/extension/prefill/route";
import { signToken } from "@/server/crypto";
import { authService } from "@/server/services/auth.service";
import { extensionService, HANDOFF_LIMIT, PREFILL_TTL_MS, isOfferableAnswer, isReviewedAnswer, prefillBlockedReason } from "@/server/services/extension.service";

/**
 * Browser-extension manual handoffs: GET /api/extension/handoffs (bearer token, owner only, no secrets) and the
 * prefill code flow for applications the user applies to themselves (incl. MANUAL_ACTION_REQUIRED / FAILED).
 */

const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const COVER = `Dear hiring team, cover letter body ${stamp}.`;
const VERIFIED_ANSWER = `Notice period answer ${stamp}`;
const PLACEHOLDER = "I cannot confirm this from my verified profile yet. [Please answer this question yourself before submitting.]";
const PHONE = "+91 90000 12345";

let a: string;
let b: string;
let c: string;
let tokenA: string;
let tokenB: string;
let revokedToken: string;
let jobSeq = 0;
const ids: Record<string, string> = {};

async function makeUser(label: string): Promise<string> {
  const email = `handoff-${label}-${stamp}@example.test`;
  return (await authService.signUp({ name: `Handoff ${label}`, email, password: "Password123", acceptTerms: true })).userId;
}

async function makeApplication(
  userId: string,
  status: ApplicationStatus,
  extra: { mode?: ApplicationMode | null; reason?: ManualActionReason; detail?: string; failureReason?: string; updatedAt?: Date; applyUrl?: string | null; data?: Partial<Prisma.ApplicationUncheckedCreateInput> } = {},
): Promise<string> {
  jobSeq++;
  const job = await prisma.job.create({
    data: {
      ownerUserId: userId,
      platform: "GREENHOUSE",
      title: `Handoff Engineer ${jobSeq}`,
      company: `Handoff Co ${jobSeq}`,
      description: "Private job for the extension handoff tests.",
      importMethod: "MANUAL_ENTRY",
      dedupeKey: `handoff-${stamp}-${jobSeq}`,
      applyUrl: extra.applyUrl === undefined ? `https://boards.greenhouse.io/handoff/jobs/${jobSeq}` : extra.applyUrl,
    },
  });
  const app = await prisma.application.create({
    data: {
      userId,
      jobId: job.id,
      status,
      applyMethod: "CAREER_PAGE",
      mode: extra.mode ?? null,
      manualActionReason: extra.reason ?? null,
      manualActionDetail: extra.detail ?? null,
      failureReason: extra.failureReason ?? null,
      ...(extra.updatedAt ? { updatedAt: extra.updatedAt } : {}),
      ...extra.data,
    },
  });
  return app.id;
}

function request(path: string, init: { token?: string; origin?: string } = {}): NextRequest {
  const headers: Record<string, string> = {};
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  if (init.origin) headers.origin = init.origin;
  return new NextRequest(`http://localhost:3000${path}`, { headers });
}

const ctx = { params: Promise.resolve({}) };

async function callHandoffs(init: { token?: string; origin?: string } = {}) {
  const res = await handoffsGET(request("/api/extension/handoffs", init), ctx as never);
  return { res, json: (await res.json()) as { success: boolean; data?: { items: Record<string, unknown>[]; total: number }; error?: { code: string } } };
}

beforeAll(async () => {
  a = await makeUser("a");
  b = await makeUser("b");
  c = await makeUser("c");
  await prisma.candidateProfile.upsert({
    where: { userId: a },
    create: { userId: a, fullName: "Handoff Tester", email: `profile-${stamp}@example.test`, phone: PHONE },
    update: { fullName: "Handoff Tester", email: `profile-${stamp}@example.test`, phone: PHONE },
  });
  tokenA = (await extensionService.createToken(a, "Test extension")).token;
  tokenB = (await extensionService.createToken(b, "Test extension")).token;
  const revoked = await extensionService.createToken(a, "Revoked");
  revokedToken = revoked.token;
  await extensionService.revokeToken(a, revoked.id);

  const base = Date.now() - 60 * 60 * 1000;
  const at = (minutes: number) => new Date(base + minutes * 60 * 1000);
  // Included (manual handoffs).
  ids.manual = await makeApplication(a, "MANUAL_ACTION_REQUIRED", { mode: "AUTO", reason: "CAPTCHA", detail: "The Greenhouse form shows a CAPTCHA.", updatedAt: at(10) });
  ids.failed = await makeApplication(a, "FAILED", { mode: "REVIEW", reason: "LOGIN_REQUIRED", failureReason: "The provider rejected the upload.", updatedAt: at(9) });
  ids.approvedManual = await makeApplication(a, "APPROVED", { mode: "MANUAL", updatedAt: at(8) });
  ids.approvedLegacy = await makeApplication(a, "APPROVED", { mode: null, updatedAt: at(7), applyUrl: null });
  ids.opened = await makeApplication(a, "OPENED_APPLY_PAGE", { mode: null, updatedAt: at(6) });
  // Excluded.
  ids.approvedAuto = await makeApplication(a, "APPROVED", { mode: "AUTO", updatedAt: at(20) });
  ids.approvedReview = await makeApplication(a, "APPROVED", { mode: "REVIEW", updatedAt: at(20) });
  // A failed attempt with an automatic retry scheduled: the automation still submits it, so it is not a handoff.
  ids.failedRetrying = await makeApplication(a, "FAILED", { mode: "AUTO", failureReason: "Timeout.", updatedAt: at(20), data: { nextActionAt: new Date(Date.now() + 60_000) } });
  for (const s of ["READY_FOR_REVIEW", "WAITING_APPROVAL", "NEEDS_INFORMATION", "APPLYING", "APPLIED", "SUBMITTED", "DISCOVERED", "WITHDRAWN"] as const) {
    ids[s] = await makeApplication(a, s, { mode: "AUTO", updatedAt: at(20) });
  }
  // Another user's handoff.
  ids.otherUser = await makeApplication(b, "MANUAL_ACTION_REQUIRED", { mode: "AUTO", reason: "MFA", updatedAt: at(30) });

  // Prepared content for the handed-off application (never part of the handoff list).
  await prisma.coverLetter.create({ data: { userId: a, applicationId: ids.manual, body: COVER, originalBody: COVER, provider: "fallback", promptVersion: "test" } });
  const draft = { userId: a, applicationId: ids.manual, provider: "fallback", promptVersion: "test" };
  await prisma.screeningAnswerDraft.createMany({
    data: [
      { ...draft, sortOrder: 0, question: "What is your notice period?", answer: VERIFIED_ANSWER, originalAnswer: VERIFIED_ANSWER, answerSource: "PREFERENCE", questionKey: "notice_period", resolved: true, required: true },
      { ...draft, sortOrder: 1, question: "Do you need visa sponsorship?", answer: "", originalAnswer: "", answerSource: "UNKNOWN", questionKey: "visa_sponsorship", resolved: false, required: true },
      { ...draft, sortOrder: 2, question: "Describe a project you are proud of", answer: PLACEHOLDER, originalAnswer: PLACEHOLDER, answerSource: "GENERATED", canConfirm: false, resolved: true },
      { ...draft, sortOrder: 3, question: "How many years of React experience do you have?", answer: "I have 5 years of professional experience.", originalAnswer: "I have 5 years of professional experience.", answerSource: "GENERATED", canConfirm: true, resolved: true },
      { ...draft, sortOrder: 4, question: "Why this company?", answer: "Because of the product - my own words.", originalAnswer: "Generated draft", answerSource: "GENERATED", status: "EDITED", resolved: true },
    ],
  });
});

describe("GET /api/extension/handoffs", () => {
  it("requires a valid, unrevoked extension token from an allowed origin", async () => {
    expect((await callHandoffs()).res.status).toBe(401);
    expect((await callHandoffs({ token: "awx_not-a-real-token" })).res.status).toBe(401);
    expect((await callHandoffs({ token: "not-an-extension-token" })).res.status).toBe(401);
    expect((await callHandoffs({ token: revokedToken })).res.status).toBe(401);
    const foreign = await callHandoffs({ token: tokenA, origin: "https://evil.example" });
    expect(foreign.res.status).toBe(403);
    expect(foreign.res.headers.get("access-control-allow-origin")).toBeNull();
    const ok = await callHandoffs({ token: tokenA, origin: "chrome-extension://abcdefghijklmnop" });
    expect(ok.res.status).toBe(200);
    expect(ok.res.headers.get("access-control-allow-origin")).toBe("chrome-extension://abcdefghijklmnop");
    expect(ok.res.headers.get("cache-control")).toBe("no-store");
  });

  it("lists only the owner's applications that need a manual application, newest first", async () => {
    const { res, json } = await callHandoffs({ token: tokenA });
    expect(res.status).toBe(200);
    const items = json.data!.items;
    expect(items.map((i) => i.applicationId)).toEqual([ids.manual, ids.failed, ids.approvedManual, ids.approvedLegacy, ids.opened]);
    expect(json.data!.total).toBe(5);
    for (const excluded of ["approvedAuto", "approvedReview", "failedRetrying", "READY_FOR_REVIEW", "WAITING_APPROVAL", "NEEDS_INFORMATION", "APPLYING", "APPLIED", "SUBMITTED", "DISCOVERED", "WITHDRAWN", "otherUser"]) {
      expect(items.some((i) => i.applicationId === ids[excluded]), excluded).toBe(false);
    }
    const byId = Object.fromEntries(items.map((i) => [i.applicationId as string, i]));
    expect(byId[ids.manual!]).toMatchObject({
      status: "MANUAL_ACTION_REQUIRED",
      reason: "CAPTCHA",
      reasonLabel: MANUAL_ACTION_REASON_LABELS.CAPTCHA,
      reasonDetail: "The Greenhouse form shows a CAPTCHA.",
      job: { title: expect.stringMatching(/^Handoff Engineer/), company: expect.stringMatching(/^Handoff Co/), applyUrl: expect.stringMatching(/^https:\/\/boards\.greenhouse\.io\//) },
    });
    // A FAILED retry reports its own failure, not the stale reason of an earlier attempt.
    expect(byId[ids.failed!]).toMatchObject({ status: "FAILED", reason: null, reasonDetail: "The provider rejected the upload." });
    expect(byId[ids.failed!]!.reasonLabel).toMatch(/could not finish/);
    expect(byId[ids.approvedManual!]).toMatchObject({ status: "APPROVED", reason: null, reasonDetail: null });
    expect(byId[ids.approvedLegacy!]).toMatchObject({ job: expect.objectContaining({ applyUrl: null }) });
    expect(new Date(byId[ids.manual!]!.updatedAt as string).toISOString()).toBe(byId[ids.manual!]!.updatedAt);

    const other = await callHandoffs({ token: tokenB });
    expect(other.json.data!.items.map((i) => i.applicationId)).toEqual([ids.otherUser]);
  });

  it("returns only whitelisted fields - no secrets, CV text, answers or cover letters", async () => {
    const { json } = await callHandoffs({ token: tokenA });
    for (const item of json.data!.items) {
      expect(Object.keys(item).sort()).toEqual(["applicationId", "job", "reason", "reasonDetail", "reasonLabel", "status", "updatedAt"]);
      expect(Object.keys(item.job as object).sort()).toEqual(["applyUrl", "company", "title"]);
    }
    const raw = JSON.stringify(json);
    for (const secret of [tokenA, tokenB, COVER, VERIFIED_ANSWER, PHONE, `profile-${stamp}@example.test`, `handoff-a-${stamp}@example.test`]) {
      expect(raw).not.toContain(secret);
    }
    expect(raw).not.toMatch(/tokenHash|secretEnc|extractedText|coverLetter|screening/i);
  });

  it("returns at most 20 handoffs and reports the total", async () => {
    const tokenC = (await extensionService.createToken(c, "Test extension")).token;
    for (let i = 0; i < HANDOFF_LIMIT + 2; i++) await makeApplication(c, "MANUAL_ACTION_REQUIRED", { mode: "AUTO", reason: "AUTOMATION_NOT_SUPPORTED" });
    const { json } = await callHandoffs({ token: tokenC });
    expect(json.data!.items).toHaveLength(HANDOFF_LIMIT);
    expect(json.data!.total).toBe(HANDOFF_LIMIT + 2);
    const times = json.data!.items.map((i) => Date.parse(i.updatedAt as string));
    expect([...times].sort((x, y) => y - x)).toEqual(times);
  });
});

describe("extension prefill for manual handoffs", () => {
  it("issues prefill codes for handed-off, failed, opened and approved applications only", async () => {
    for (const key of ["manual", "failed", "approvedManual", "opened"]) {
      const issued = await extensionService.issuePrefill(a, ids[key]!);
      expect(issued.code.length).toBeGreaterThan(10);
      expect(Date.parse(issued.expiresAt) - Date.now()).toBeLessThanOrEqual(PREFILL_TTL_MS);
    }
    for (const key of ["READY_FOR_REVIEW", "WAITING_APPROVAL", "NEEDS_INFORMATION", "APPLYING", "APPLIED", "SUBMITTED", "approvedAuto", "approvedReview"]) {
      await expect(extensionService.issuePrefill(a, ids[key]!), key).rejects.toMatchObject({ code: "INVALID_STATE" });
    }
    // An automatic retry is scheduled: applying by hand as well could submit it twice.
    await expect(extensionService.issuePrefill(a, ids.failedRetrying!)).rejects.toMatchObject({ code: "INVALID_STATE", message: expect.stringMatching(/automatic retry/) });
    // Ownership: another user's application is not found.
    await expect(extensionService.issuePrefill(b, ids.manual!)).rejects.toMatchObject({ status: 404 });
  });

  it("resolves a MANUAL_ACTION_REQUIRED prefill with verified answers, open questions and the cover letter", async () => {
    const { code } = await extensionService.issuePrefill(a, ids.manual!);
    const p = await extensionService.resolvePrefill(a, code);
    expect(p.applicationId).toBe(ids.manual);
    expect(p.status).toBe("MANUAL_ACTION_REQUIRED");
    expect(p.fields.find((f) => f.key === "phone")?.value).toBe(PHONE);
    expect(p.fields.find((f) => f.key === "coverLetter")?.value).toBe(COVER);
    expect(p.coverLetter).toBe(COVER);
    // PROPOSED draft, application not approved by the user or policy -> the user reviews it in the extension.
    expect(p.coverLetterReviewed).toBe(false);
    expect(p.screeningAnswers).toEqual([
      { question: "What is your notice period?", answer: VERIFIED_ANSWER, key: "notice_period", source: "PREFERENCE", reviewed: true },
      { question: "How many years of React experience do you have?", answer: "I have 5 years of professional experience.", key: null, source: "GENERATED", reviewed: false },
      { question: "Why this company?", answer: "Because of the product - my own words.", key: null, source: "GENERATED", reviewed: true },
    ]);
    // Unknown answers and the "cannot confirm" placeholder are never offered as values.
    expect(JSON.stringify(p.screeningAnswers)).not.toContain("cannot confirm");
    expect(p.openQuestions).toEqual([
      { question: "Do you need visa sponsorship?", required: true },
      { question: "Describe a project you are proud of", required: false },
    ]);
    expect(p.policy).toMatch(/never clicks Submit/);
  });

  it("serves prefill through the bearer-token route to the owner only", async () => {
    const { code } = await extensionService.issuePrefill(a, ids.failed!);
    const path = `/api/extension/prefill?code=${encodeURIComponent(code)}`;
    const ok = await prefillGET(request(path, { token: tokenA }), ctx as never);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { data: { applicationId: string } }).data.applicationId).toBe(ids.failed);
    expect((await prefillGET(request(path, { token: tokenB }), ctx as never)).status).toBe(403);
    expect((await prefillGET(request(path), ctx as never)).status).toBe(401);
    // Expired and tampered codes are rejected.
    const expired = signToken("prefill", { userId: a, applicationId: ids.failed }, -1_000);
    expect((await prefillGET(request(`/api/extension/prefill?code=${encodeURIComponent(expired)}`, { token: tokenA }), ctx as never)).status).toBe(403);
    expect((await prefillGET(request(`${path}x`, { token: tokenA }), ctx as never)).status).toBe(403);
  });

  it("stops resolving once the automation will submit the application again", async () => {
    // Issued while handed off; meanwhile an automatic retry was scheduled / the user approved it for submission.
    for (const later of [
      { status: "FAILED" as const, nextActionAt: new Date(Date.now() + 60_000) },
      { status: "APPROVED" as const, nextActionAt: null },
    ]) {
      const id = await makeApplication(a, "MANUAL_ACTION_REQUIRED", { mode: "REVIEW", reason: "LOGIN_REQUIRED" });
      const { code } = await extensionService.issuePrefill(a, id);
      await prisma.application.update({ where: { id }, data: later });
      await expect(extensionService.resolvePrefill(a, code), later.status).rejects.toMatchObject({ code: "INVALID_STATE" });
    }
    // The manual flow is unaffected: a failed application without an automation mode can still be prefilled.
    const manual = await makeApplication(a, "FAILED", { mode: null, data: { nextActionAt: new Date(Date.now() + 60_000) } });
    const { code } = await extensionService.issuePrefill(a, manual);
    await expect(extensionService.resolvePrefill(a, code)).resolves.toMatchObject({ applicationId: manual, status: "FAILED" });
  });

  it("stops resolving once the application was submitted", async () => {
    const id = await makeApplication(a, "MANUAL_ACTION_REQUIRED", { mode: "AUTO", reason: "UNSUPPORTED_FLOW" });
    const { code } = await extensionService.issuePrefill(a, id);
    await prisma.application.update({ where: { id }, data: { status: "SUBMITTED" } });
    await expect(extensionService.resolvePrefill(a, code)).rejects.toMatchObject({ code: "INVALID_STATE" });
    await expect(extensionService.resolvePrefill(b, code)).rejects.toMatchObject({ status: 403 });
  });

  it("blocks a prefill exactly while the automation will still submit the application", () => {
    const soon = new Date(Date.now() + 60_000);
    expect(prefillBlockedReason({ status: "APPROVED", mode: "AUTO", nextActionAt: null })).toMatch(/queued/);
    expect(prefillBlockedReason({ status: "FAILED", mode: "REVIEW", nextActionAt: soon })).toMatch(/automatic retry/);
    expect(prefillBlockedReason({ status: "FAILED", mode: "REVIEW", nextActionAt: null })).toBeNull();
    expect(prefillBlockedReason({ status: "APPROVED", mode: "MANUAL", nextActionAt: null })).toBeNull();
    expect(prefillBlockedReason({ status: "APPROVED", mode: null, nextActionAt: soon })).toBeNull();
    expect(prefillBlockedReason({ status: "MANUAL_ACTION_REQUIRED", mode: "AUTO", nextActionAt: soon })).toMatch(/automatic retry/);
    expect(prefillBlockedReason({ status: "MANUAL_ACTION_REQUIRED", mode: "AUTO", nextActionAt: null })).toBeNull();
  });

  it("marks content approved by the user or the AUTO policy as reviewed", async () => {
    const base = { answer: "x", originalAnswer: "x", resolved: true, canConfirm: true } as const;
    expect(isOfferableAnswer({ ...base, status: "PROPOSED", answerSource: "GENERATED" })).toBe(true);
    expect(isReviewedAnswer({ ...base, status: "PROPOSED", answerSource: "GENERATED" }, null)).toBe(false);
    expect(isReviewedAnswer({ ...base, status: "PROPOSED", answerSource: "GENERATED" }, "policy")).toBe(true);
    expect(isReviewedAnswer({ ...base, status: "APPROVED", answerSource: "GENERATED" }, "user")).toBe(true);
    expect(isOfferableAnswer({ ...base, status: "APPROVED", answerSource: "UNKNOWN" })).toBe(false);
    expect(isOfferableAnswer({ ...base, status: "APPROVED", answerSource: "TRUTH_BANK", resolved: false })).toBe(false);
    expect(isOfferableAnswer({ ...base, status: "APPROVED", answerSource: "GENERATED", canConfirm: false })).toBe(false);

    const id = await makeApplication(a, "MANUAL_ACTION_REQUIRED", { mode: "AUTO", reason: "CAPTCHA", data: { approvalSource: "policy" } });
    await prisma.coverLetter.create({ data: { userId: a, applicationId: id, body: COVER, originalBody: COVER, provider: "fallback", promptVersion: "test" } });
    const { code } = await extensionService.issuePrefill(a, id);
    expect((await extensionService.resolvePrefill(a, code)).coverLetterReviewed).toBe(true);
  });
});
