/**
 * Dev script - DEMO CONTENT ONLY. No database access.
 *
 * Scores every job of the automation demo provider (packages/job-engine/src/demo/automation-jobs.ts) against the
 * seeded demo candidate with the REAL matching engine and prints the score histogram, the band counts and each
 * high match with its scripted scenario.
 *
 *   cd packages/database && npx tsx scripts/demo-score-distribution.ts [--all]
 *
 * The candidate is built in memory exactly like prisma/seed.ts builds it in the database: parseCvText on the demo
 * CV, applyParsedCv semantics (every parsed fact USER_VERIFIED, skills from the skills section, experience bullets
 * and project technologies, deduplicated by canonical name), then the seed's overrides (Docker, Figma and the
 * achievements stay PARSED_UNVERIFIED), the seeded preferences, and toMatchCandidate. Scores are computed twice:
 * with the base taxonomy and with the seed's extra skill aliases registered (as the web app does on start-up);
 * the script fails when a job lands in a different band or when a band target is missed.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEMO_AUTOMATION_JOB_COUNT,
  computeMatchReport,
  demoAutomationJobTier,
  extractSkillsFromText,
  generateDemoAutomationJobs,
  normalizeRawJob,
  normalizeSkill,
  registerSkillAliases,
  type MatchCandidate,
  type MatchFact,
  type MatchSkill,
} from "@applywise/job-engine";
import { checkResumeFormat, parseCvText, type ParsedCv } from "@applywise/resume-engine";
import type { NormalizedJob, SkillSource, TruthStatus } from "@applywise/types";
import { jobMatchKey } from "../src/jobs";

const here = dirname(fileURLToPath(import.meta.url));
const HIGH_THRESHOLD = 90;
const MEDIUM_THRESHOLD = 70;
const TARGETS = { high: 18, medium: 25, low: 55 } as const;
const SEED_UNVERIFIED_SKILLS = new Set(["Docker", "Figma"]);

type Band = "high" | "medium" | "low";

const out = (line = "") => process.stdout.write(`${line}\n`);

/** Mirrors applyParsedCv (packages/database/src/profile-import.ts) + the overrides in prisma/seed.ts. */
function buildDemoCandidate(): MatchCandidate {
  const cvText = readFileSync(join(here, "..", "..", "resume-engine", "fixtures", "demo-cv.txt"), "utf8");
  const parsed: ParsedCv = parseCvText(cvText);
  const verified: TruthStatus = "USER_VERIFIED";
  const facts: MatchFact[] = [];
  let n = 0;
  const fact = (kind: MatchFact["kind"], text: string, status: TruthStatus = verified) => facts.push({ id: `fact_${++n}`, kind, text, status });

  if (parsed.summary) fact("SUMMARY", parsed.summary);
  for (const e of parsed.experience) for (const b of e.bullets) fact("EXPERIENCE_BULLET", b);
  for (const p of parsed.projects) {
    fact("PROJECT", `${p.name}${p.description ? `: ${p.description}` : ""}${p.technologies.length ? ` (${p.technologies.join(", ")})` : ""}`);
  }
  for (const ed of parsed.education) fact("EDUCATION", [ed.degree, ed.field, ed.institution, ed.endYear].filter(Boolean).join(", "));
  for (const c of parsed.certifications) fact("CERTIFICATION", c);
  // seed.ts leaves the achievements unverified.
  for (const a of parsed.achievements) fact("ACHIEVEMENT", a, "PARSED_UNVERIFIED");

  const skills: MatchSkill[] = [];
  const seen = new Set<string>();
  const addSkill = (name: string, source: SkillSource) => {
    const canonicalName = normalizeSkill(name);
    if (!canonicalName || seen.has(canonicalName)) return;
    seen.add(canonicalName);
    // seed.ts: Docker and Figma stay unverified so the verification flow is visible.
    skills.push({ id: `skill_${skills.length + 1}`, name: name.trim(), canonicalName, source, status: SEED_UNVERIFIED_SKILLS.has(canonicalName) ? "PARSED_UNVERIFIED" : verified });
  };
  for (const s of parsed.skills) addSkill(s, "SKILLS_SECTION");
  for (const e of parsed.experience) for (const s of extractSkillsFromText(e.bullets.join("\n"))) addSkill(s, "EXPERIENCE");
  for (const p of parsed.projects) for (const s of p.technologies) addSkill(s, "PROJECT");

  return {
    yoe: parsed.totalYearsExperience ?? 5,
    preferredLocations: ["Bengaluru", "Remote - India"],
    workModePreference: "any",
    openToRelocation: false,
    targetRoles: ["Frontend Engineer", "React Developer", "Full-Stack Developer"],
    currentTitle: parsed.experience[0]?.title ?? null,
    facts,
    skills,
    resumeFormatWarnings: checkResumeFormat(cvText, parsed),
  };
}

/** The skill aliases prisma/seed.ts stores, loaded into the matcher the way apps/web/src/instrumentation-node.ts does. */
function registerSeedAliases(): void {
  const rows = [
    { name: "React Native", aliases: ["rn"], related: ["React"] },
    { name: "TanStack Query", aliases: ["react query", "tanstack query"], related: ["React"] },
    { name: "RxJS", aliases: ["rxjs", "reactive extensions"], related: ["Angular"] },
    { name: "CRDTs", aliases: ["crdt", "crdts", "yjs", "automerge"], related: ["WebSockets"] },
  ];
  registerSkillAliases(rows.flatMap((s) => [{ alias: s.name, canonical: s.name, related: s.related }, ...s.aliases.map((alias) => ({ alias, canonical: s.name, related: s.related }))]));
}

const bandOf = (score: number): Band => (score >= HIGH_THRESHOLD ? "high" : score >= MEDIUM_THRESHOLD ? "medium" : "low");

interface Row {
  key: string;
  title: string;
  company: string;
  source: string;
  scenario: string;
  channel: string;
  score: number;
  band: Band;
  tier: string | null;
}

async function main() {
  const showAll = process.argv.includes("--all");
  const now = new Date();
  const raws = generateDemoAutomationJobs({ appUrl: "http://localhost:3000", now });
  const candidate = buildDemoCandidate();

  // Distinct jobs = first occurrence per jobMatchKey (the key the import merges duplicates on).
  const byMatchKey = new Map<string, { job: NormalizedJob; raw: (typeof raws)[number]; sources: Set<string> }>();
  let unmergeable = 0;
  for (const raw of raws) {
    const job = await normalizeRawJob(raw);
    const key = jobMatchKey(job);
    if (!key) {
      unmergeable++;
      continue;
    }
    const existing = byMatchKey.get(key);
    if (existing) existing.sources.add(String(raw.raw.demoSource));
    else byMatchKey.set(key, { job, raw, sources: new Set([String(raw.raw.demoSource)]) });
  }
  const distinct = [...byMatchKey.values()];
  const duplicates = raws.length - distinct.length - unmergeable;
  const crossProvider = distinct.filter((d) => d.sources.size > 1).length;

  const score = () =>
    distinct.map(({ job, raw }): Row => {
      const s = computeMatchReport(job, candidate).estimatedMatchScore;
      const key = String(raw.raw.key);
      return {
        key,
        title: job.title,
        company: job.company,
        source: String(raw.raw.demoSource),
        scenario: String(raw.raw.demoScenario),
        channel: String(raw.raw.demoChannel),
        score: s,
        band: bandOf(s),
        tier: demoAutomationJobTier(key),
      };
    });
  const base = score();
  registerSeedAliases();
  const withAliases = score();

  out(`DEMO CONTENT - automation demo provider score distribution (${now.toISOString().slice(0, 10)})`);
  out(`Candidate: yoe ${candidate.yoe}, ${candidate.skills.length} skills, ${candidate.facts.length} facts, ${candidate.resumeFormatWarnings?.length ?? 0} format warnings`);
  out(`Generated ${raws.length} raw jobs: ${distinct.length} distinct (catalogue ${DEMO_AUTOMATION_JOB_COUNT}), ${duplicates} cross-provider duplicates merged into ${crossProvider} jobs${unmergeable ? `, ${unmergeable} without a match key` : ""}`);
  out();
  out("Histogram (score bucket: jobs)");
  for (let lo = 0; lo <= 100; lo += 5) {
    const inBucket = withAliases.filter((r) => r.score >= lo && r.score < lo + 5 + (lo === 100 ? 1 : 0)).length;
    if (lo === 100 && inBucket === 0) continue;
    out(`  ${String(lo).padStart(3)}-${String(Math.min(lo + 4, 100)).padStart(3)}: ${String(inBucket).padStart(3)} ${"#".repeat(inBucket)}`);
  }
  const count = (rows: Row[], band: Band) => rows.filter((r) => r.band === band).length;
  out();
  out(`Bands: high (>= ${HIGH_THRESHOLD}) ${count(withAliases, "high")} [target >= ${TARGETS.high}], medium (${MEDIUM_THRESHOLD}-${HIGH_THRESHOLD - 1}) ${count(withAliases, "medium")} [target >= ${TARGETS.medium}], low (< ${MEDIUM_THRESHOLD}) ${count(withAliases, "low")} [target >= ${TARGETS.low}]`);

  out();
  out("High matches");
  for (const r of withAliases.filter((r) => r.band === "high").sort((a, b) => b.score - a.score)) {
    out(`  ${String(r.score).padStart(3)}  ${r.scenario.padEnd(17)} ${r.channel.padEnd(7)} ${r.source.padEnd(10)} ${r.title} @ ${r.company}`);
  }
  const scenarios = new Map<string, number>();
  for (const r of withAliases.filter((r) => r.band === "high")) scenarios.set(r.scenario, (scenarios.get(r.scenario) ?? 0) + 1);
  out(`  scenarios: ${[...scenarios.entries()].map(([s, c]) => `${s} ${c}`).join(", ")}`);

  if (showAll) {
    out();
    out("All jobs");
    for (const r of [...withAliases].sort((a, b) => b.score - a.score)) {
      out(`  ${String(r.score).padStart(3)} ${r.band.padEnd(6)} tier=${String(r.tier).padEnd(6)} ${r.scenario.padEnd(17)} ${r.source.padEnd(10)} ${r.key}`);
    }
  }

  const problems: string[] = [];
  if (count(withAliases, "high") < TARGETS.high) problems.push(`only ${count(withAliases, "high")} high matches`);
  if (count(withAliases, "medium") < TARGETS.medium) problems.push(`only ${count(withAliases, "medium")} medium matches`);
  if (count(withAliases, "low") < TARGETS.low) problems.push(`only ${count(withAliases, "low")} low matches`);
  for (const [i, r] of withAliases.entries()) {
    if (r.tier && r.tier !== r.band) problems.push(`${r.key} is tagged ${r.tier} but scores ${r.score} (${r.band})`);
    const b = base[i]!;
    if (b.band !== r.band) problems.push(`${r.key} scores ${b.score} without the seed's skill aliases and ${r.score} with them`);
  }
  if (duplicates < 12) problems.push(`only ${duplicates} cross-provider duplicates`);
  out();
  if (problems.length > 0) {
    out(`PROBLEMS (${problems.length}):`);
    for (const p of problems) out(`  - ${p}`);
    process.exitCode = 1;
  } else {
    out("OK: every band target holds and every job scores in its tagged band.");
  }
}

main().catch((e) => {
  console.error("[demo-score-distribution] failed", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
