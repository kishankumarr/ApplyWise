/**
 * Smoke-evaluate every AI workflow against the configured provider (e.g. Ollama + Qwen).
 *
 *   AI_PROVIDER=ollama OLLAMA_MODEL=qwen2.5:7b pnpm --filter @applywise/ai eval
 *
 * Uses the fictional demo CV and a demo job. Prints, per workflow: whether the model output
 * was accepted or the deterministic fallback was used (and why), latency and token counts.
 * Never prints CV contents beyond short previews of generated text.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { computeMatchReport, CONNECTORS, DEMO_JOBS } from "@applywise/job-engine";
import type { SourceFact } from "@applywise/types";
import {
  checkLocalProvider,
  describeAiProvider,
  generateApplicationEmail,
  generateCoverLetter,
  generateQuestionnaire,
  generateScreeningAnswer,
  getAiConfig,
  parseCv,
  parseJob,
  planTailoredResume,
  validateClaims,
  type AiCallMeta,
  type AiLogger,
  type GenerationContext,
} from "../src";

const here = dirname(fileURLToPath(import.meta.url));
const config = getAiConfig();
const info = describeAiProvider(config);
const quiet: AiLogger = { info: () => {}, warn: () => {} };
const rows: { workflow: string; result: string; ms: number; tokens: string; note: string }[] = [];

function record(meta: AiCallMeta, note = "") {
  rows.push({
    workflow: meta.workflow,
    result: meta.provider === "fallback" ? `FALLBACK (${meta.fallbackReason})` : `model ok (${meta.attempts} attempt${meta.attempts > 1 ? "s" : ""}${meta.repairs ? `, ${meta.repairs} repair` : ""})`,
    ms: meta.durationMs,
    tokens: meta.inputTokens != null ? `${meta.inputTokens} in / ${meta.outputTokens} out` : "-",
    note,
  });
  process.stdout.write(`  ${meta.workflow.padEnd(20)} ${rows[rows.length - 1]!.result} in ${(meta.durationMs / 1000).toFixed(1)}s\n`);
}

async function main() {
  process.stdout.write(`Provider: ${info.label} (configured: ${info.configured})\n`);
  if (config.provider !== "anthropic") {
    const health = await checkLocalProvider(config);
    process.stdout.write(`Health: ${health.message}\n`);
    if (!health.ok) process.exit(1);
  }
  const opts = { config, logger: quiet };

  // A. CV parser
  const cvText = readFileSync(resolve(here, "../../resume-engine/fixtures/demo-cv.txt"), "utf8");
  const cv = await parseCv(cvText, opts);
  record(cv.meta, `${cv.data.experience.length} roles, ${cv.data.skills.length} skills, email=${cv.data.email ?? "null"}`);

  // B. Job parser (free text only, no hints) for the demo "Video Editor" job
  const raw = (await CONNECTORS.seeded.importJobs({ payload: { appUrl: "http://localhost:3000" } }))[0]!;
  const job = await parseJob(raw.text, { importMethod: "MANUAL_ENTRY" }, opts);
  record(job.meta, `${job.data.title} @ ${job.data.company}; required=${job.data.requiredSkills.map((s) => s.canonicalName).join(", ")}`);

  // Build a verified-facts context from the parsed CV (all facts treated as verified for the eval).
  const facts: SourceFact[] = [{ id: "profile:yoe", kind: "OTHER", text: "5 years of professional experience" }];
  const experiences = cv.data.experience.map((e, i) => {
    const ids = e.bullets.map((b, j) => {
      const id = `b${i}_${j}`;
      facts.push({ id, kind: "EXPERIENCE_BULLET", text: b });
      return id;
    });
    return { id: `e${i}`, title: e.title, company: e.company, bulletFactIds: ids };
  });
  cv.data.skills.forEach((s, i) => facts.push({ id: `s${i}`, kind: "SKILL", text: s }));
  const jobWithId = { ...(await CONNECTORS.seeded.normalize(raw)), id: `demo_${DEMO_JOBS[0]!.key}` };
  const matchReport = computeMatchReport(jobWithId, {
    yoe: 5,
    preferredLocations: ["Bengaluru"],
    workModePreference: "any",
    openToRelocation: false,
    targetRoles: ["Frontend Engineer"],
    currentTitle: cv.data.experience[0]?.title ?? null,
    facts: facts.map((f) => ({ ...f, status: "USER_VERIFIED" as const })),
    skills: [],
  });
  const ctx: GenerationContext = {
    job: jobWithId,
    candidate: {
      fullName: cv.data.fullName,
      email: cv.data.email,
      phone: cv.data.phone,
      yoe: 5,
      currentTitle: cv.data.experience[0]?.title ?? null,
      currentCompany: cv.data.experience[0]?.company ?? null,
      noticePeriod: "30 days",
      preferredLocations: ["Bengaluru"],
      openToRelocation: false,
      linkedinUrl: null,
      githubUrl: null,
      portfolioUrl: null,
    },
    facts,
    experiences,
    answers: [],
    matchReport,
  };

  // C-F + cover letter. EVAL_ONLY=questionnaire,tailored-resume,... runs a subset.
  const only = (process.env.EVAL_ONLY ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const want = (w: string) => only.length === 0 || only.includes(w);
  if (want("questionnaire")) {
    const q = await generateQuestionnaire(ctx, opts);
    record(q.meta, `${q.data.length} questions: ${q.data.map((x) => x.type).join(", ")}`);
  }
  let summary: string | null = null;
  if (want("tailored-resume")) {
    const plan = await planTailoredResume(ctx, opts);
    summary = plan.data.summary.text;
    const v = validateClaims([plan.data.summary, ...plan.data.bulletChanges.map((b) => ({ text: b.proposed, sourceFactIds: b.sourceFactIds }))], facts);
    const issues = v.unsupportedClaims.filter((u) => u.severity !== "low").map((u) => `[${u.severity}] ${u.reason} <- "${u.claim.text.slice(0, 70)}"`);
    record(plan.meta, `${plan.data.bulletChanges.length} bullets, validator mayShow=${v.mayShow}; summary: "${summary.slice(0, 90)}..."${issues.length ? `\n      ${issues.join("\n      ")}` : ""}`);
  }
  if (want("screening-answer")) {
    const sa = await generateScreeningAnswer(jobWithId.screeningQuestions[0] ?? "How many years of React experience do you have?", ctx, opts);
    record(sa.meta, `canConfirm=${sa.data.canConfirm}: "${sa.data.answer.slice(0, 90)}"`);
  }
  if (want("cover-letter")) {
    const cover = await generateCoverLetter(ctx, opts);
    record(cover.meta, `${cover.data.body.split(/\s+/).length} words`);
  }
  if (want("application-email")) {
    const email = await generateApplicationEmail(ctx, summary, { ...opts, hasCoverLetter: true });
    record(email.meta, `${email.data.body.split(/\s+/).filter(Boolean).length} words; subject: "${email.data.subject}"`);
  }

  const ok = rows.filter((r) => !r.result.startsWith("FALLBACK")).length;
  process.stdout.write(`\n${ok}/${rows.length} workflows accepted model output; the rest used deterministic fallbacks.\n\n`);
  for (const r of rows) process.stdout.write(`- ${r.workflow}: ${r.result}, ${(r.ms / 1000).toFixed(1)}s, ${r.tokens}\n    ${r.note}\n`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
