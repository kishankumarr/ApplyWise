import type { FactSource, Prisma, PrismaClient, TruthStatus } from "@prisma/client";
import { extractSkillsFromText, normalizeSkill } from "@applywise/job-engine";
import type { ParsedCv } from "@applywise/resume-engine";

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Persist a parsed CV into the structured profile. Every item is stored as
 * PARSED_UNVERIFIED (unless the caller seeds demo data) so the user confirms each fact.
 * Previously verified or edited facts are preserved; stale unverified parse output is replaced.
 */
export async function applyParsedCv(
  db: Db,
  input: { userId: string; profileId: string; resumeId: string | null; parsed: ParsedCv; status?: TruthStatus; source?: FactSource },
): Promise<{ facts: number; experiences: number; skills: number }> {
  const { userId, profileId, resumeId, parsed } = input;
  const status: TruthStatus = input.status ?? "PARSED_UNVERIFIED";
  const source: FactSource = input.source ?? "CV_PARSE";

  // Replace previous unverified parse output (user decisions are kept).
  await db.truthBankItem.deleteMany({ where: { userId, source: "CV_PARSE", status: "PARSED_UNVERIFIED" } });
  await db.experience.deleteMany({ where: { userId, status: "PARSED_UNVERIFIED", bullets: { none: { status: { not: "PARSED_UNVERIFIED" } } } } });
  await db.project.deleteMany({ where: { userId, status: "PARSED_UNVERIFIED" } });
  await db.education.deleteMany({ where: { userId, status: "PARSED_UNVERIFIED" } });
  await db.candidateSkill.deleteMany({ where: { userId, status: "PARSED_UNVERIFIED", source: { in: ["SKILLS_SECTION", "EXPERIENCE", "PROJECT"] } } });

  let facts = 0;
  const fact = async (data: Omit<Prisma.TruthBankItemUncheckedCreateInput, "userId" | "profileId" | "status" | "source" | "resumeId">) => {
    facts++;
    return db.truthBankItem.create({
      data: { ...data, userId, profileId, resumeId, status, source, originalText: data.text, verifiedAt: status === "PARSED_UNVERIFIED" ? null : new Date() },
    });
  };

  if (parsed.summary) await fact({ kind: "SUMMARY", text: parsed.summary, section: "summary" });

  for (const [i, e] of parsed.experience.entries()) {
    const exp = await db.experience.create({
      data: {
        userId,
        profileId,
        title: e.title || "Untitled role",
        company: e.company || "Unknown company",
        location: e.location,
        startDate: e.startDate,
        endDate: e.endDate,
        isCurrent: e.isCurrent,
        status,
        sortOrder: i,
      },
    });
    for (const [j, b] of e.bullets.entries()) {
      await fact({ kind: "EXPERIENCE_BULLET", text: b, section: "experience", experienceId: exp.id, sortOrder: j });
    }
  }

  for (const [i, p] of parsed.projects.entries()) {
    const project = await db.project.create({
      data: { userId, profileId, name: p.name, description: p.description, url: p.url, technologies: p.technologies, status, sortOrder: i },
    });
    await fact({
      kind: "PROJECT",
      text: `${p.name}${p.description ? `: ${p.description}` : ""}${p.technologies.length ? ` (${p.technologies.join(", ")})` : ""}`,
      section: "projects",
      projectId: project.id,
      sortOrder: i,
    });
  }

  for (const [i, ed] of parsed.education.entries()) {
    const education = await db.education.create({
      data: { userId, profileId, institution: ed.institution, degree: ed.degree, field: ed.field, startYear: ed.startYear, endYear: ed.endYear, status, sortOrder: i },
    });
    await fact({
      kind: "EDUCATION",
      text: [ed.degree, ed.field, ed.institution, ed.endYear].filter(Boolean).join(", "),
      section: "education",
      educationId: education.id,
      sortOrder: i,
    });
  }

  for (const c of parsed.certifications) await fact({ kind: "CERTIFICATION", text: c, section: "certifications" });
  for (const a of parsed.achievements) await fact({ kind: "ACHIEVEMENT", text: a, section: "achievements" });

  // Skills: listed skills plus those evidenced in experience/project text.
  const existing = new Set((await db.candidateSkill.findMany({ where: { profileId }, select: { canonicalName: true } })).map((s) => s.canonicalName));
  let skills = 0;
  const addSkill = async (name: string, skillSource: "SKILLS_SECTION" | "EXPERIENCE" | "PROJECT") => {
    const canonicalName = normalizeSkill(name);
    if (!canonicalName || existing.has(canonicalName)) return;
    existing.add(canonicalName);
    skills++;
    await db.candidateSkill.create({ data: { userId, profileId, name: name.trim(), canonicalName, source: skillSource, status } });
  };
  for (const s of parsed.skills) await addSkill(s, "SKILLS_SECTION");
  for (const e of parsed.experience) for (const s of extractSkillsFromText(e.bullets.join("\n"))) await addSkill(s, "EXPERIENCE");
  for (const p of parsed.projects) for (const s of p.technologies) await addSkill(s, "PROJECT");

  return { facts, experiences: parsed.experience.length, skills };
}
