import { describe, expect, it } from "vitest";
import {
  countWords,
  emailGuard,
  fallbackApplicationEmail,
  fallbackScreeningAnswer,
  fallbackTailoredPlan,
  generateApplicationEmail,
  generateQuestionnaire,
  getAiConfig,
  isAiConfigured,
  parseCv,
  questionnaireGuard,
  sanitizeTailoredPlan,
  validateClaims,
  withFallback,
} from "../src";
import type { JobQuestion } from "@applywise/types";
import { makeContext } from "./helpers";

const offline = getAiConfig({ AI_DISABLED: "true" });

describe("AI configuration", () => {
  it("uses a configurable model id and requires a key", () => {
    expect(getAiConfig({}).model).toBe("claude-opus-5");
    expect(getAiConfig({ ANTHROPIC_MODEL: "claude-sonnet-5" }).model).toBe("claude-sonnet-5");
    expect(isAiConfigured(getAiConfig({}))).toBe(false);
    expect(isAiConfigured(getAiConfig({ ANTHROPIC_API_KEY: "k" }))).toBe(true);
    expect(isAiConfigured(getAiConfig({ ANTHROPIC_API_KEY: "k", AI_DISABLED: "true" }))).toBe(false);
  });
});

describe("withFallback", () => {
  it("uses the deterministic fallback when Claude is unavailable", async () => {
    const r = await withFallback({
      workflow: "x",
      promptVersion: "x-v1",
      fallbackVersion: "fb-v1",
      config: getAiConfig({ ANTHROPIC_API_KEY: "k" }),
      run: async () => {
        throw new Error("boom");
      },
      fallback: () => 42,
    });
    expect(r.data).toBe(42);
    expect(r.meta).toMatchObject({ provider: "fallback", promptVersion: "fb-v1", fallbackReason: "api_error" });
  });

  it("falls back when the guard rejects Claude output", async () => {
    const r = await withFallback({
      workflow: "x",
      promptVersion: "x-v1",
      fallbackVersion: "fb-v1",
      config: getAiConfig({ ANTHROPIC_API_KEY: "k" }),
      run: async () => ({ data: "hallucinated", meta: { workflow: "x", provider: "claude" as const, modelId: "m", promptVersion: "x-v1", attempts: 1, durationMs: 1 } }),
      guard: (d) => (d === "hallucinated" ? "unsupported" : null),
      fallback: () => "safe",
    });
    expect(r.data).toBe("safe");
    expect(r.meta.fallbackReason).toMatch(/guard_rejected/);
  });

  it("parses CVs offline with the rule-based parser", async () => {
    const r = await parseCv("Priya Rao\npriya@example.test\n\nSkills\nReact, TypeScript", { config: offline });
    expect(r.meta.provider).toBe("fallback");
    expect(r.data.email).toBe("priya@example.test");
    expect(r.data.skills).toEqual(["React", "TypeScript"]);
  });
});

describe("questionnaire generation validation", () => {
  it("produces a valid 3-8 question fallback", async () => {
    const ctx = makeContext();
    const r = await generateQuestionnaire(ctx, { config: offline });
    expect(questionnaireGuard(ctx.job, r.data)).toBeNull();
    expect(r.data.find((q) => q.id === "skill_kubernetes")).toBeTruthy();
  });

  it("rejects questionnaires that are too short, lack 'No' options or ask irrelevant salary questions", () => {
    const ctx = makeContext();
    const q = (over: Partial<JobQuestion>): JobQuestion => ({
      id: "q1",
      type: "OPEN_TEXT",
      text: "What interests you here?",
      whyAsked: "Because it helps.",
      requiredForJob: false,
      relatedRequirement: null,
      options: null,
      allowFreeText: true,
      showWhen: null,
      ...over,
    });
    expect(questionnaireGuard(ctx.job, [q({})])).toMatch(/at least 3/);
    const noNo = [
      q({ id: "a", type: "SKILL_CONFIRMATION", options: [{ value: "yes", label: "Yes" }, { value: "maybe", label: "Maybe" }] }),
      q({ id: "b" }),
      q({ id: "c" }),
    ];
    expect(questionnaireGuard(ctx.job, noNo)).toMatch(/No/);
    const salary = [q({ id: "a", text: "What is your expected salary?" }), q({ id: "b" }), q({ id: "c" })];
    expect(questionnaireGuard(ctx.job, salary)).toMatch(/salary/);
    const dangling = [q({ id: "a", showWhen: { questionId: "zzz", equalsAny: ["yes"] } }), q({ id: "b" }), q({ id: "c" })];
    expect(questionnaireGuard(ctx.job, dangling)).toMatch(/unknown question/);
  });
});

describe("tailored resume planning", () => {
  it("fallback plan only contains cited, verified claims and never adds missing skills", () => {
    const ctx = makeContext();
    const plan = fallbackTailoredPlan(ctx);
    const allClaims = [plan.summary, ...plan.bulletChanges.map((b) => ({ text: b.proposed, sourceFactIds: b.sourceFactIds }))];
    const v = validateClaims(allClaims, ctx.facts);
    expect(v.mayShow).toBe(true);
    expect(plan.selectedSkills.map((s) => s.name)).not.toContain("Kubernetes");
    expect(plan.warnings.join(" ")).toMatch(/Kubernetes/);
    expect(plan.bulletChanges[0]!.originalFactId).toBe("b1");
  });

  it("strips unsupported AI suggestions", () => {
    const ctx = makeContext();
    const plan = fallbackTailoredPlan(ctx);
    const tampered = {
      ...plan,
      summary: { text: "Kubernetes expert with 9 years of experience.", sourceFactIds: ["profile:yoe"] },
      bulletChanges: [
        ...plan.bulletChanges,
        { experienceId: "e1", originalFactId: "b4", original: null, proposed: "Reduced load time by 90%", sourceFactIds: ["b4"], rationale: "", confidence: "high" as const },
      ],
    };
    const clean = sanitizeTailoredPlan(tampered, ctx)!;
    expect(clean.summary.text).not.toMatch(/Kubernetes|9 years/);
    expect(clean.bulletChanges.some((b) => b.proposed.includes("90%"))).toBe(false);
    expect(clean.warnings.join(" ")).toMatch(/unsupported/);
  });

  it("keeps bullets under the role they belong to and drops cross-role or unknown rewrites", () => {
    const ctx = makeContext({
      facts: [...makeContext().facts, { id: "c1", kind: "EXPERIENCE_BULLET", text: "Built React dashboards for an analytics product" }],
      experiences: [
        { id: "e1", title: "Senior Frontend Engineer", company: "Clipverse Media", bulletFactIds: ["b1", "b2", "b3", "b4"] },
        { id: "e2", title: "Frontend Engineer", company: "Earlier Co", bulletFactIds: ["c1"] },
      ],
    });
    const plan = fallbackTailoredPlan(ctx);
    const change = (over: Record<string, unknown>) => ({ experienceId: "e1", originalFactId: null, original: null, proposed: "Built React dashboards for an analytics product", sourceFactIds: ["c1"], rationale: "", confidence: "high" as const, ...over });
    const clean = sanitizeTailoredPlan(
      {
        ...plan,
        bulletChanges: [
          change({ originalFactId: "c1" }), // placed under the wrong role
          change({ originalFactId: "zz9" }), // not an existing bullet
          change({ proposed: "Built React editors and dashboards", sourceFactIds: ["b1", "c1"] }), // mixes two roles
        ],
      },
      ctx,
    )!;
    expect(clean.bulletChanges).toHaveLength(1);
    expect(clean.bulletChanges[0]).toMatchObject({ experienceId: "e2", originalFactId: "c1" });
    expect(clean.warnings.join(" ")).toMatch(/single role/);
  });
});

describe("screening answers", () => {
  it("says the candidate cannot confirm when there is no evidence", () => {
    const r = fallbackScreeningAnswer("Do you have experience with Kubernetes in production?", makeContext());
    expect(r.canConfirm).toBe(false);
    expect(r.answer).toMatch(/cannot confirm/);
  });

  it("drafts open questions from verified evidence (the facts themselves, no leading 'Yes')", () => {
    const r = fallbackScreeningAnswer("Describe your experience building canvas-based editors.", makeContext());
    expect(r.canConfirm).toBe(true);
    expect(r.claims[0]!.sourceFactIds).toContain("b2");
    expect(r.answer).not.toMatch(/^Yes\b/);
    expect(r.answer).toContain("HTML5 Canvas API");
  });

  it("never answers yes/no, numeric or threshold questions from facts that merely mention a skill", () => {
    const ctx = makeContext();
    const noYoe = makeContext({ candidate: { ...ctx.candidate, yoe: null } });
    for (const [question, c] of [
      ["Have you worked with React for 5+ years? (required)", ctx],
      ["Do you have 8+ years of experience with React?", noYoe],
      ["Do you have 8+ years of experience with React?", ctx],
      ["Have you built canvas-based editors?", ctx],
      ["Are you comfortable working with TypeScript every day?", ctx],
      ["How many years of React experience do you have?", ctx],
      ["How many years of experience do you have in sales?", ctx],
      ["React experience (minimum 3 years)", ctx],
      ["Please confirm you have shipped production React code", ctx],
    ] as const) {
      const r = fallbackScreeningAnswer(question, c);
      expect(r.canConfirm, question).toBe(false);
      expect(r.answer, question).toMatch(/cannot confirm/);
      expect(r.answer, question).not.toMatch(/^Yes\b/);
      expect(r.claims, question).toEqual([]);
    }
  });

  it("answers total experience only from the verified years, and exact questionnaire answers as the user gave them", () => {
    const ctx = makeContext();
    const total = fallbackScreeningAnswer("How many years of experience do you have?", ctx);
    expect(total).toMatchObject({ canConfirm: true, answer: "I have 5 years of professional experience." });
    expect(total.claims[0]!.sourceFactIds).toEqual(["profile:yoe"]);
    const answered = makeContext({
      answers: [
        { questionId: "q1", questionText: "Are you comfortable with on-call rotations?", value: "yes", freeText: null, factId: "qa1" },
        { questionId: "q2", questionText: "Do you have experience with Kubernetes?", value: "not_sure", freeText: null, factId: "qa2" },
      ],
    });
    expect(fallbackScreeningAnswer("Are you comfortable with on-call rotations?", answered)).toMatchObject({ canConfirm: true, answer: "Yes" });
    expect(fallbackScreeningAnswer("Do you have experience with Kubernetes?", answered).canConfirm).toBe(false);
  });
});

describe("application email", () => {
  it("fallback email is 120-180 words, uses real title/company, mentions the attachment and passes the guard", async () => {
    const ctx = makeContext();
    const draft = fallbackApplicationEmail(ctx, { hasCoverLetter: true });
    const words = countWords(draft.body);
    expect(words).toBeGreaterThanOrEqual(120);
    expect(words).toBeLessThanOrEqual(180);
    expect(draft.subject).toContain("Senior Frontend Engineer");
    expect(draft.body).toContain("Framecraft Labs");
    expect(draft.body).toMatch(/attached/);
    expect(draft.body).toMatch(/In my recent work, I [a-z]/);
    expect(draft.body).not.toMatch(/\bi (built|also)\b/);
    expect(emailGuard(draft, ctx)).toBeNull();
    const r = await generateApplicationEmail(ctx, null, { config: offline });
    expect(r.meta.provider).toBe("fallback");
  });

  it("guard rejects exaggerated or fabricated emails", () => {
    const ctx = makeContext();
    const draft = fallbackApplicationEmail(ctx, { hasCoverLetter: false });
    expect(emailGuard({ ...draft, body: draft.body.replaceAll("Framecraft Labs", "Acme") }, ctx)).toMatch(/company/);
    expect(emailGuard({ ...draft, body: `${draft.body} I improved revenue by 300%.` }, ctx)).toMatch(/300/);
    expect(emailGuard({ ...draft, body: "Too short. Senior Frontend Engineer Framecraft Labs attached." }, ctx)).toMatch(/words/);
  });
});

describe("email length padding", () => {
  it("tops up a slightly short model email with claim-free sentences before the sign-off", async () => {
    const { padToMinimumWords, CLAIM_FREE_PADDING } = await import("../src");
    const ctx = makeContext();
    const base = fallbackApplicationEmail(ctx, { hasCoverLetter: false });
    // Remove the padding the fallback added and shorten it to ~110 words.
    let short = base.body;
    for (const p of CLAIM_FREE_PADDING) short = short.replace(` ${p}`, "");
    const words = short.split(/\s+/);
    const signOffIdx = short.indexOf("Thank you");
    expect(signOffIdx).toBeGreaterThan(0);
    const padded = padToMinimumWords(short, countWords(short) + 10);
    expect(countWords(padded)).toBeGreaterThanOrEqual(countWords(short) + 10);
    expect(padded.indexOf(CLAIM_FREE_PADDING[0]!)).toBeLessThan(padded.indexOf("Thank you"));
    // Far too short bodies are left alone (the guard/fallback handles them).
    expect(padToMinimumWords("Too short.", 120)).toBe("Too short.");
    expect(words.length).toBeGreaterThan(0);
  });
});

describe("questionnaire guard (strict)", () => {
  const base = {
    whyAsked: "Because it matters.",
    requiredForJob: false,
    allowFreeText: false,
    showWhen: null,
  };
  const skillQ = (id: string, skill: string) => ({
    ...base,
    id,
    type: "SKILL_CONFIRMATION" as const,
    text: `Have you worked with ${skill}?`,
    relatedRequirement: skill,
    options: [{ value: "yes_professional", label: "Yes" }, { value: "no", label: "No" }, { value: "not_sure", label: "Not sure" }],
  });

  it("always requires the employer's screening questions, even with 8 questions", () => {
    const ctx = makeContext();
    const job = { ...ctx.job, screeningQuestions: ["Are you comfortable working onsite in Bengaluru?"] };
    const eight = Array.from({ length: 8 }, (_, i) => skillQ(`q${i}`, ["Kubernetes", "Go", "Rust", "Kafka", "Java", "Python", "AWS", "Docker"][i]!));
    expect(questionnaireGuard(job, eight, ctx.matchReport)).toMatch(/screening question missing/);
  });

  it("rejects confirming skills that verified experience already proves", () => {
    const ctx = makeContext();
    const qs = [skillQ("a", "React"), skillQ("b", "Kubernetes"), skillQ("c", "WebGL")];
    expect(questionnaireGuard(ctx.job, qs, ctx.matchReport)).toMatch(/already shows/);
    expect(questionnaireGuard(ctx.job, [skillQ("b", "Kubernetes"), skillQ("c", "WebGL"), skillQ("d", "Rust")], ctx.matchReport)).toBeNull();
  });

  it("the rule-based questionnaire passes the strict guard for every demo job", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const { CONNECTORS, computeMatchReport, generateRuleBasedQuestionnaire } = await import("@applywise/job-engine");
    const { parseCvText } = await import("@applywise/resume-engine");
    const cv = parseCvText(readFileSync(resolve(__dirname, "../../resume-engine/fixtures/demo-cv.txt"), "utf8"));
    const facts = cv.experience.flatMap((e, i) => e.bullets.map((b, j) => ({ id: `b${i}_${j}`, kind: "EXPERIENCE_BULLET" as const, text: b, status: "USER_VERIFIED" as const })));
    const raws = await CONNECTORS.seeded.importJobs({ payload: { appUrl: "http://localhost:3000" } });
    for (const raw of raws) {
      const job = await CONNECTORS.seeded.normalize(raw);
      const report = computeMatchReport(job, { yoe: 5, preferredLocations: ["Bengaluru"], workModePreference: "any", openToRelocation: false, targetRoles: ["Frontend Engineer"], currentTitle: null, facts, skills: [] });
      const qs = generateRuleBasedQuestionnaire(job, report, { noticePeriod: null, expectedSalaryMin: null, expectedSalaryMax: null, preferredLocations: ["Bengaluru"], openToRelocation: false, topExperienceBullets: [] });
      expect(questionnaireGuard(job, qs, report), job.title).toBeNull();
    }
  });
});

describe("questionnaire sanitiser", () => {
  const q = (over: Record<string, unknown>) => ({
    id: "q",
    type: "OPEN_TEXT" as const,
    text: "What would you like to highlight?",
    whyAsked: "Helps tailoring.",
    requiredForJob: false,
    relatedRequirement: null,
    options: null,
    allowFreeText: true,
    showWhen: null,
    ...over,
  });

  it("repairs the typical small-model mistakes deterministically", async () => {
    const { sanitizeQuestionnaire } = await import("../src");
    const ctx = makeContext();
    const job = { ...ctx.job, screeningQuestions: ["Are you comfortable working onsite in Bengaluru?"] };
    const input = [
      q({ id: "Confirm React!", type: "SKILL_CONFIRMATION", text: "Have you used React?", relatedRequirement: "React", options: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }] }),
      q({ id: "k8s", type: "SKILL_CONFIRMATION", text: "Have you used Kubernetes?", relatedRequirement: "Kubernetes", options: [{ value: "yes", label: "Yes" }, { value: "maybe", label: "Maybe" }] }),
      q({ id: "orphan", text: "Describe it in detail please.", showWhen: { questionId: "missing", equalsAny: ["yes"] } }),
      q({ id: "pay", text: "What is your expected salary?" }),
      ...Array.from({ length: 8 }, (_, i) => q({ id: `extra_${i}`, text: `Extra open question number ${i}?` })),
    ];
    const { questions, notes } = sanitizeQuestionnaire(input, job, ctx.matchReport);
    expect(questions.length).toBeLessThanOrEqual(8);
    expect(questions[0]).toMatchObject({ type: "SCREENING", text: "Are you comfortable working onsite in Bengaluru?" });
    expect(questions.some((x) => x.relatedRequirement === "React")).toBe(false); // proven by verified experience
    const k8s = questions.find((x) => x.id === "k8s")!;
    // Skill questions always use the canonical options: only these "yes" values are recorded as facts.
    expect(k8s.options!.map((o) => o.value)).toEqual(["yes_professional", "yes_project", "no", "not_sure"]);
    expect(k8s.text).toBe("Have you used Kubernetes?");
    // A skill question without any "yes" option gets truthful positive options added.
    const onlyNo = sanitizeQuestionnaire(
      [q({ id: "x", type: "SKILL_CONFIRMATION", text: "Have you used XState?", relatedRequirement: "XState", options: [{ value: "no", label: "No" }, { value: "not_sure", label: "Not sure" }] })],
      ctx.job,
      ctx.matchReport,
    );
    expect(onlyNo.questions[0]!.options!.map((o) => o.value)).toEqual(["yes_professional", "yes_project", "no", "not_sure"]);
    expect(questions.some((x) => x.id === "orphan" || x.id === "pay")).toBe(false);
    expect(notes.join(" ")).toMatch(/proven skill React/);
    expect(questionnaireGuard(job, questions, ctx.matchReport)).toBeNull();
  });

  it("matches employer screening questions one-to-one and never duplicates them", async () => {
    const { sanitizeQuestionnaire } = await import("../src");
    const ctx = makeContext();
    const job = {
      ...ctx.job,
      screeningQuestions: [
        "Are you comfortable working onsite in Bengaluru?",
        "Are you comfortable working night shifts (IST)?",
        "Are you comfortable working onsite in Bengaluru?",
      ],
    };
    const input = [q({ id: "onsite", type: "SCREENING", text: "Are you comfortable working onsite in Bengaluru?" })];
    const pad = [q({ id: "screening_1", type: "SCREENING", text: "Are you comfortable working onsite in Bengaluru?" }), q({ id: "notice", text: "What is your notice period?" })];
    const { questions } = sanitizeQuestionnaire(input, job, ctx.matchReport, pad);
    const screening = questions.filter((x) => x.type === "SCREENING").map((x) => x.text);
    expect(screening).toEqual(["Are you comfortable working onsite in Bengaluru?", "Are you comfortable working night shifts (IST)?"]);
    expect(questions.map((x) => x.id)).toContain("notice");
    expect(questionnaireGuard(job, questions, ctx.matchReport)).toBeNull();
  });

  it("slugs follow-up references, maps 'yes' follow-ups to canonical values and drops unanchored skill questions", async () => {
    const { sanitizeQuestionnaire } = await import("../src");
    const ctx = makeContext();
    const { questions } = sanitizeQuestionnaire(
      [
        q({ id: "Has K8s?", type: "SKILL_CONFIRMATION", text: "Do you know it?", relatedRequirement: "Kubernetes", options: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }], allowFreeText: false }),
        q({ id: "k8s detail", text: "Where did you use it?", showWhen: { questionId: "Has K8s?", equalsAny: ["yes"] } }),
        q({ id: "vague", type: "SKILL_CONFIRMATION", text: "Have you done similar work?", relatedRequirement: null, options: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }] }),
      ],
      ctx.job,
      ctx.matchReport,
    );
    const parent = questions.find((x) => x.relatedRequirement === "Kubernetes")!;
    // The text must name what a "yes" will record.
    expect(parent.text).toBe("Have you worked with Kubernetes?");
    const followUp = questions.find((x) => x.text === "Where did you use it?")!;
    expect(followUp.showWhen).toEqual({ questionId: parent.id, equalsAny: ["yes_professional", "yes_project"] });
    expect(questions.some((x) => x.text === "Have you done similar work?")).toBe(false);
  });
});

describe("email padding needs a sign-off", () => {
  it("does not pad bodies without a recognisable sign-off and recognises common ones", async () => {
    const { padToMinimumWords, CLAIM_FREE_PADDING } = await import("../src");
    const body = `${"I am applying for the Senior Frontend Engineer role at Framecraft Labs. ".repeat(10).trim()}\n\nAarav Mehta`;
    expect(padToMinimumWords(body, countWords(body) + 10)).toBe(body);
    for (const signOff of ["Yours sincerely,", "Best,", "Cheers,", "With best regards,"]) {
      const withSignOff = `${body.replace("\n\nAarav Mehta", "")}\n\n${signOff}\nAarav Mehta`;
      const padded = padToMinimumWords(withSignOff, countWords(withSignOff) + 10);
      expect(padded.indexOf(CLAIM_FREE_PADDING[0]!), signOff).toBeGreaterThan(0);
      expect(padded.indexOf(CLAIM_FREE_PADDING[0]!)).toBeLessThan(padded.indexOf(signOff));
    }
  });
});
