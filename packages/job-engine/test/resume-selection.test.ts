import { describe, expect, it } from "vitest";
import type { ResumeSelectionCandidate, ResumeSelectionJob } from "@applywise/types";
import { selectResume } from "../src/automation/resume-selection";

const aiJob: ResumeSelectionJob = {
  title: "Senior AI Engineer",
  requiredSkills: [
    { canonicalName: "Python", mandatory: true },
    { canonicalName: "Machine learning", mandatory: true },
    { canonicalName: "PyTorch", mandatory: true },
    { canonicalName: "LLM integration", mandatory: false },
    { canonicalName: "Docker", mandatory: false },
  ],
  preferredSkills: ["Kubernetes", "AWS"],
  domains: [],
};

/** The candidate's verified skills (USER_VERIFIED / USER_EDITED), canonical names. */
const verified = new Set(["Python", "Machine learning", "PyTorch", "LLM integration", "Docker", "AWS", "Node.js", "PostgreSQL", "System design", "Agile", "React"]);

function resume(overrides: Partial<ResumeSelectionCandidate> & Pick<ResumeSelectionCandidate, "resumeId" | "label">): ResumeSelectionCandidate {
  return {
    versionId: null,
    targetRoles: [],
    isPrimary: false,
    skills: [],
    titles: [],
    text: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const backend = resume({
  resumeId: "r-backend",
  label: "Backend Resume",
  targetRoles: ["Backend Engineer"],
  isPrimary: true,
  skills: ["Node.js", "PostgreSQL", "Docker", "Kubernetes", "AWS", "Python"],
  titles: ["Senior Backend Engineer"],
  text: "Built payment APIs in Node.js and PostgreSQL; containerised services with Docker.",
  createdAt: "2026-03-01T00:00:00.000Z",
});

const ai = resume({
  resumeId: "r-ai",
  label: "AI Resume",
  targetRoles: ["AI Engineer", "ML Engineer"],
  skills: ["Python", "Machine learning", "LLM integration", "Docker", "Kubernetes"],
  titles: ["Machine Learning Engineer"],
  text: "Fine-tuned transformer models in PyTorch and shipped LLM features on AWS.",
  createdAt: "2026-02-01T00:00:00.000Z",
});

const lead = resume({
  resumeId: "r-lead",
  label: "Technical Lead Resume",
  targetRoles: ["Technical Lead"],
  skills: ["System design", "Agile", "Node.js", "React", "Python"],
  titles: ["Technical Lead"],
  text: "Led a team of 8 engineers; owned system design reviews.",
  createdAt: "2026-04-01T00:00:00.000Z",
});

describe("selectResume", () => {
  it("returns null when there are no candidates", () => {
    expect(selectResume(aiJob, [], verified)).toBeNull();
  });

  it('picks the "AI Resume" for a "Senior AI Engineer" job among Backend / AI / Technical Lead resumes', () => {
    const result = selectResume(aiJob, [backend, ai, lead], verified)!;
    expect(result.resumeId).toBe("r-ai");
    expect(result.label).toBe("AI Resume");
    // Weights: Python 3, ML 3, PyTorch 3, LLM 2, Docker 2, Kubernetes 1, AWS 1 = 15.
    // AI covers everything but Kubernetes (not verified): 14/15 -> 79.3 + 15 (role) = 94.
    expect(result.score).toBe(94);
    expect(result.reason).toBe('AI Resume covers 6 of 7 job skills with verified evidence (Python, Machine learning, PyTorch, ...); matches the "Senior AI Engineer" role.');
    expect(result.ranking.map((r) => r.resumeId)).toEqual(["r-ai", "r-backend", "r-lead"]);
    const [aiScore, backendScore, leadScore] = result.ranking;
    expect(aiScore).toMatchObject({ matchedSkills: ["Python", "Machine learning", "PyTorch", "LLM integration", "Docker", "AWS"], missingSkills: ["Kubernetes"], roleAligned: true });
    // Backend: Python 3 + Docker 2 + AWS 1 = 6/15 -> 34; the role is not aligned.
    expect(backendScore).toMatchObject({ score: 34, roleAligned: false, matchedSkills: ["Python", "Docker", "AWS"] });
    // Lead: Python 3 = 3/15 -> 17.
    expect(leadScore).toMatchObject({ score: 17, roleAligned: false, matchedSkills: ["Python"] });
  });

  it("does not count skills the resume lists but the candidate has not verified", () => {
    const result = selectResume(aiJob, [ai], verified)!;
    expect(result.ranking[0]!.missingSkills).toContain("Kubernetes");
    const unverified = selectResume(aiJob, [ai], new Set(["Python"]))!;
    expect(unverified.ranking[0]!.matchedSkills).toEqual(["Python"]);
    // Python 3 of 15 -> 17 + 15 (role) = 32.
    expect(unverified.score).toBe(32);
  });

  it("does not count verified skills the resume never names", () => {
    const bare = resume({ resumeId: "r-bare", label: "AI Resume", targetRoles: ["AI Engineer"], skills: [], text: "" });
    const result = selectResume(aiJob, [bare], verified)!;
    expect(result.ranking[0]!.matchedSkills).toEqual([]);
    expect(result.score).toBe(15);
    expect(result.reason).toBe('AI Resume covers none of the 7 job skills with verified evidence; it matches the "Senior AI Engineer" role.');
  });

  it("finds skills in the resume text using taxonomy aliases", () => {
    const textOnly = resume({ resumeId: "r-text", label: "General", text: "Deployed k8s clusters and dockerised apps with Docker; wrote Python ETL." });
    const result = selectResume({ title: "Platform Engineer", requiredSkills: [{ canonicalName: "Kubernetes", mandatory: true }], preferredSkills: ["Python"], domains: [] }, [textOnly], new Set(["Kubernetes", "Python"]))!;
    expect(result.ranking[0]!.matchedSkills).toEqual(["Kubernetes", "Python"]);
  });

  it("aligns roles through role families and title words", () => {
    const job: ResumeSelectionJob = { title: "Backend Engineer", requiredSkills: [], preferredSkills: [], domains: [] };
    const devTitles = resume({ resumeId: "r-1", label: "General Resume", titles: ["Senior Node.js Developer"] });
    expect(selectResume(job, [devTitles], verified)!.ranking[0]!.roleAligned).toBe(true);
    const generic = resume({ resumeId: "r-2", label: "My Resume", targetRoles: ["Software Engineer"] });
    expect(selectResume(job, [generic], verified)!.ranking[0]!.roleAligned).toBe(false);
  });

  it("scores jobs without skills by role alignment only (70 / 40)", () => {
    const job: ResumeSelectionJob = { title: "Senior AI Engineer", requiredSkills: [], preferredSkills: [], domains: [] };
    const result = selectResume(job, [backend, ai], verified)!;
    expect(result.ranking.map((r) => [r.resumeId, r.score])).toEqual([
      ["r-ai", 70],
      ["r-backend", 40],
    ]);
    expect(result.reason).toBe('The job lists no skills; AI Resume matches the "Senior AI Engineer" role.');
  });

  it("breaks ties by primary resume, then newest", () => {
    const job: ResumeSelectionJob = { title: "Data Analyst", requiredSkills: [{ canonicalName: "SQL", mandatory: true }], preferredSkills: [], domains: [] };
    const base = { label: "Resume", skills: ["SQL"] };
    const older = resume({ ...base, resumeId: "r-old", createdAt: "2025-01-01T00:00:00.000Z" });
    const newer = resume({ ...base, resumeId: "r-new", createdAt: "2026-06-01T00:00:00.000Z" });
    const primary = resume({ ...base, resumeId: "r-primary", isPrimary: true, createdAt: "2024-01-01T00:00:00.000Z" });
    const sqlVerified = new Set(["SQL"]);

    const withPrimary = selectResume(job, [older, newer, primary], sqlVerified)!;
    expect(withPrimary.ranking.map((r) => r.resumeId)).toEqual(["r-primary", "r-new", "r-old"]);
    expect(withPrimary.reason).toContain("because it is your primary resume");

    const noPrimary = selectResume(job, [older, newer], sqlVerified)!;
    expect(noPrimary.resumeId).toBe("r-new");
    expect(noPrimary.reason).toContain("because it is the newest");

    // A higher score beats both tie-breakers.
    const better = resume({ resumeId: "r-better", label: "Data Resume", targetRoles: ["Data Analyst"], skills: ["SQL"], createdAt: "2020-01-01T00:00:00.000Z" });
    expect(selectResume(job, [primary, newer, better], sqlVerified)!.resumeId).toBe("r-better");
  });

  it("is deterministic regardless of input order", () => {
    const a = selectResume(aiJob, [backend, ai, lead], verified);
    const b = selectResume(aiJob, [lead, ai, backend], verified);
    const c = selectResume(aiJob, [ai, lead, backend], verified);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect(selectResume(aiJob, [backend, ai, lead], verified)).toEqual(a);
  });

  it("weights mandatory over required over preferred and de-duplicates job skills", () => {
    const job: ResumeSelectionJob = {
      title: "Engineer",
      requiredSkills: [
        { canonicalName: "React", mandatory: true },
        { canonicalName: "TypeScript", mandatory: false },
      ],
      preferredSkills: ["React", "GraphQL"],
      domains: [],
    };
    const skills = new Set(["React", "TypeScript", "GraphQL"]);
    // React counted once with weight 3: total = 3 + 2 + 1 = 6.
    const mandatoryOnly = selectResume(job, [resume({ resumeId: "m", label: "M", skills: ["React"] })], skills)!;
    expect(mandatoryOnly.score).toBe(Math.round((85 * 3) / 6));
    const requiredOnly = selectResume(job, [resume({ resumeId: "r", label: "R", skills: ["TypeScript"] })], skills)!;
    expect(requiredOnly.score).toBe(Math.round((85 * 2) / 6));
    const preferredOnly = selectResume(job, [resume({ resumeId: "p", label: "P", skills: ["GraphQL"] })], skills)!;
    expect(preferredOnly.score).toBe(Math.round(85 / 6));
    expect(mandatoryOnly.ranking[0]!.matchedSkills).toEqual(["React"]);
    expect(mandatoryOnly.ranking[0]!.missingSkills).toEqual(["TypeScript", "GraphQL"]);
  });
});

describe("variants with the same verified content", () => {
  // Same person, same verified facts, different emphasis: only the label says which role each variant is for.
  const shared = { skills: ["React", "Node.js", "PostgreSQL"], titles: ["Senior Frontend Engineer"], text: "React Node.js PostgreSQL" };
  const frontend = resume({ resumeId: "v-frontend", label: "Frontend Resume", createdAt: "2026-01-01T00:00:00.000Z", ...shared });
  const fullstack = resume({ resumeId: "v-fullstack", label: "Full-stack Resume", isPrimary: true, createdAt: "2026-02-01T00:00:00.000Z", ...shared });
  const job = (title: string): ResumeSelectionJob => ({ title, requiredSkills: [{ canonicalName: "React", mandatory: true }], preferredSkills: [], domains: [] });

  it("picks the variant written for the job's role, not the primary or newest one", () => {
    expect(selectResume(job("Frontend Engineer - Creator Tools"), [frontend, fullstack], verified)?.resumeId).toBe("v-frontend");
    expect(selectResume(job("Full-Stack Engineer (React + Node.js)"), [frontend, fullstack], verified)?.resumeId).toBe("v-fullstack");
  });
});
