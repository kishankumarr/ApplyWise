import "server-only";
import { applyParsedCv, prisma, type CandidateRecord, type Prisma } from "@applywise/database";
import { parseCv } from "@applywise/ai";
import {
  checkResumeFormat,
  DEFAULT_SECTION_ORDER,
  detectResumeFileKind,
  diffResumeText,
  extractTextFromResume,
  parseCvText,
  parsedCvToDocument,
  renderResumeDocx,
  renderResumeHtml,
  renderResumePdf,
  renderResumeText,
  resumeContentHash,
  UnsupportedResumeFileError,
  type ResumeDocument,
} from "@applywise/resume-engine";
import { isVerifiedTruthStatus } from "@applywise/types";
import { env } from "@/env";
import { audit } from "../audit";
import { decryptText, encryptText, sha256Hex } from "../crypto";
import { Errors } from "../errors";
import { logger } from "../logger";
import { getMalwareScanner } from "../malware";
import { enqueue } from "../queue";
import { profileRepo } from "../repositories/profile.repo";
import { getStorage, newResumeKey } from "../storage";
import { consentService } from "./consent.service";

const verified = (s: { status: Parameters<typeof isVerifiedTruthStatus>[0] }) => isVerifiedTruthStatus(s.status);

/** Build an ATS-readable resume document from VERIFIED profile facts only. */
export function documentFromProfile(c: CandidateRecord): ResumeDocument {
  return {
    contact: {
      fullName: c.fullName ?? "Your Name",
      email: c.email,
      phone: c.phone,
      location: c.preference?.preferredLocations.find((l) => !/remote/i.test(l)) ?? null,
      links: [c.linkedinUrl, c.githubUrl, c.portfolioUrl].filter((l): l is string => !!l),
    },
    headline: c.currentTitle,
    summary: c.summary && c.truthBankItems.some((f) => f.kind === "SUMMARY" && verified(f)) ? c.truthBankItems.find((f) => f.kind === "SUMMARY" && verified(f))!.text : c.summary,
    experience: c.experiences
      .filter((e) => e.status !== "USER_REJECTED")
      .map((e) => ({
        title: e.title,
        company: e.company,
        location: e.location,
        startDate: e.startDate,
        endDate: e.isCurrent ? null : e.endDate,
        bullets: e.bullets.filter(verified).map((b) => b.text),
      })),
    projects: c.projects.filter(verified).map((p) => ({ name: p.name, description: p.description, technologies: p.technologies, url: p.url })),
    skills: c.skills.filter(verified).map((s) => s.name),
    education: c.educations.filter(verified).map((e) => ({ institution: e.institution, degree: e.degree, field: e.field, startYear: e.startYear, endYear: e.endYear })),
    achievements: c.truthBankItems.filter((f) => (f.kind === "ACHIEVEMENT" || f.kind === "CERTIFICATION") && verified(f)).map((f) => f.text),
    sectionOrder: DEFAULT_SECTION_ORDER,
  };
}

export const resumeService = {
  async upload(userId: string, file: File, requestId?: string) {
    await consentService.require(userId, "cvProcessing");
    const maxBytes = env().MAX_UPLOAD_MB * 1024 * 1024;
    if (file.size === 0) throw Errors.validation("The file is empty.");
    if (file.size > maxBytes) throw Errors.validation(`Files must be ${env().MAX_UPLOAD_MB} MB or smaller.`);
    const bytes = Buffer.from(await file.arrayBuffer());
    let kind: "pdf" | "docx";
    try {
      kind = detectResumeFileKind(file.name, file.type, new Uint8Array(bytes));
    } catch (e) {
      if (e instanceof UnsupportedResumeFileError) throw Errors.unsupportedFile(e.message);
      throw e;
    }
    const scan = await getMalwareScanner().scan(bytes);
    if (!scan.clean) throw Errors.unsupportedFile("This file was blocked by the security scanner.");

    const profile = await profileRepo.ensure(userId);
    const storageKey = newResumeKey(userId);
    const mimeType = kind === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    await getStorage().put(storageKey, bytes, mimeType);
    await prisma.resume.updateMany({ where: { userId }, data: { isPrimary: false } });
    const safeName = file.name.replace(/[^\w.\- ]+/g, "_").slice(0, 120);
    const resume = await prisma.resume.create({
      data: { userId, originalFileName: safeName, mimeType, sizeBytes: bytes.length, storageKey, sha256: sha256Hex(bytes), isPrimary: true },
      select: { id: true, originalFileName: true, status: true, sizeBytes: true, createdAt: true },
    });
    await profileRepo.bumpFactsVersion(userId);
    if (profile.onboardingStep < 2) await prisma.candidateProfile.update({ where: { userId }, data: { onboardingStep: 2 } });
    await audit(userId, "resume.uploaded", { requestId, entityType: "Resume", entityId: resume.id, metadata: { kind, sizeBytes: bytes.length, scanner: scan.scanner } });
    return resume;
  },

  async requestParse(userId: string, resumeId: string, requestId?: string) {
    await consentService.require(userId, "cvProcessing");
    const resume = await prisma.resume.findFirst({ where: { id: resumeId, userId }, select: { id: true, status: true } });
    if (!resume) throw Errors.notFound("Resume");
    if (resume.status === "PARSING") return { resumeId, status: "PARSING" as const };
    await prisma.resume.update({ where: { id: resumeId }, data: { status: "PARSING", parseError: null } });
    const { taskId } = await enqueue("cv.parse", { resumeId, requestId }, { userId });
    return { resumeId, status: "PARSING" as const, taskId };
  },

  /** Background task: extract, parse (AI model only with AI consent), persist unverified facts. */
  async runParse(userId: string, resumeId: string, requestId?: string) {
    const resume = await prisma.resume.findFirst({ where: { id: resumeId, userId } });
    if (!resume) throw Errors.notFound("Resume");
    try {
      const bytes = await getStorage().get(resume.storageKey);
      const kind = resume.mimeType === "application/pdf" ? "pdf" : "docx";
      const text = await extractTextFromResume(kind, new Uint8Array(bytes));
      if (text.trim().length < 30) throw new Error("Could not extract text from this file (is it a scanned image?).");
      const consents = await consentService.get(userId);
      // Without AI consent no AI model sees the CV: rule-based parser only.
      const result = consents.aiProcessing
        ? await parseCv(text, { logger })
        : { data: parseCvText(text), meta: { provider: "fallback" as const, promptVersion: "cv-rules-v1", modelId: null } };
      const parsed = result.data;
      const profile = await profileRepo.ensure(userId);

      await prisma.$transaction(
        async (tx) => {
          await applyParsedCv(tx, { userId, profileId: profile.id, resumeId, parsed });
          await tx.resumeParsedSection.deleteMany({ where: { resumeId } });
          const sections: [string, string][] = [
            ["summary", parsed.summary ?? ""],
            ["experience", parsed.experience.map((e) => `${e.title} | ${e.company}\n${e.bullets.join("\n")}`).join("\n\n")],
            ["projects", parsed.projects.map((p) => `${p.name}: ${p.description}`).join("\n")],
            ["skills", parsed.skills.join(", ")],
            ["education", parsed.education.map((e) => `${e.degree ?? ""} ${e.institution}`).join("\n")],
          ];
          await tx.resumeParsedSection.createMany({
            data: sections.filter(([, c]) => c.trim()).map(([section, content], i) => ({ userId, resumeId, section, contentEnc: encryptText(content), sortOrder: i })),
          });
          // Fill empty profile fields from the CV; user-entered values are never overwritten.
          await tx.candidateProfile.update({
            where: { userId },
            data: {
              fullName: profile.fullName ?? parsed.fullName,
              email: profile.email ?? parsed.email,
              phone: profile.phone ?? parsed.phone,
              yoe: profile.yoe ?? parsed.totalYearsExperience,
              currentTitle: profile.currentTitle ?? parsed.experience[0]?.title ?? parsed.headline,
              currentCompany: profile.currentCompany ?? parsed.experience[0]?.company ?? null,
              summary: profile.summary ?? parsed.summary,
              githubUrl: profile.githubUrl ?? parsed.links.github,
              linkedinUrl: profile.linkedinUrl ?? parsed.links.linkedin,
              portfolioUrl: profile.portfolioUrl ?? parsed.links.portfolio,
              resumeFormatWarnings: checkResumeFormat(text, parsed),
              onboardingStep: Math.max(profile.onboardingStep, 3),
              factsVersion: { increment: 1 },
            },
          });
          const doc = parsedCvToDocument(parsed);
          await tx.resumeVersion.create({
            data: { userId, resumeId, kind: "ORIGINAL", label: `Original: ${resume.originalFileName}`, content: doc as unknown as Prisma.InputJsonValue, contentHash: resumeContentHash(doc) },
          });
          await tx.resume.update({
            where: { id: resumeId },
            data: {
              status: "PARSED",
              extractedTextEnc: encryptText(text),
              parserProvider: result.meta.provider,
              parserVersion: result.meta.promptVersion,
              modelId: result.meta.modelId,
            },
          });
        },
        { timeout: 60_000 },
      );
      await audit(userId, "resume.parsed", { requestId, entityType: "Resume", entityId: resumeId, metadata: { provider: result.meta.provider, promptVersion: result.meta.promptVersion } });
      await enqueue("job.match", { userId }, { userId });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Parsing failed";
      await prisma.resume.update({ where: { id: resumeId }, data: { status: "FAILED", parseError: message.slice(0, 300) } });
      throw err;
    }
  },

  async download(userId: string, resumeId: string, requestId?: string) {
    const resume = await prisma.resume.findFirst({ where: { id: resumeId, userId } });
    if (!resume) {
      // Resume versions have no original file - render a PDF instead.
      const version = await prisma.resumeVersion.findFirst({ where: { id: resumeId, userId } });
      if (!version) throw Errors.notFound("Resume");
      const doc = version.content as unknown as ResumeDocument;
      await audit(userId, "resume.downloaded", { requestId, entityType: "ResumeVersion", entityId: resumeId });
      return { bytes: await renderResumePdf(doc), fileName: `${slug(doc.contact.fullName)}-resume.pdf`, mimeType: "application/pdf" };
    }
    const bytes = await getStorage().get(resume.storageKey);
    await audit(userId, "resume.downloaded", { requestId, entityType: "Resume", entityId: resumeId });
    return { bytes, fileName: resume.originalFileName, mimeType: resume.mimeType };
  },

  async listVersions(userId: string) {
    const versions = await prisma.resumeVersion.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      select: { id: true, kind: true, label: true, createdAt: true, approvedAt: true, applicationId: true, parentVersionId: true, resumeId: true, contentHash: true },
    });
    return versions;
  },

  async getVersion(userId: string, versionId: string) {
    const v = await prisma.resumeVersion.findFirst({ where: { id: versionId, userId } });
    if (!v) throw Errors.notFound("Resume version");
    const doc = v.content as unknown as ResumeDocument;
    return { ...v, content: doc, html: renderResumeHtml(doc), text: renderResumeText(doc) };
  },

  /** Resolve a Resume id or ResumeVersion id to a renderable document. */
  async resolveDocument(userId: string, id: string): Promise<{ doc: ResumeDocument; versionId: string | null }> {
    const version = await prisma.resumeVersion.findFirst({ where: { id, userId } });
    if (version) return { doc: version.content as unknown as ResumeDocument, versionId: version.id };
    const resume = await prisma.resume.findFirst({ where: { id, userId }, select: { id: true } });
    if (!resume) throw Errors.notFound("Resume");
    const latest = await prisma.resumeVersion.findFirst({ where: { userId, resumeId: resume.id }, orderBy: { createdAt: "desc" } });
    if (!latest) throw Errors.invalidState("This resume has not been parsed yet.");
    return { doc: latest.content as unknown as ResumeDocument, versionId: latest.id };
  },

  async export(userId: string, id: string, format: "pdf" | "docx" | "txt" | "html", requestId?: string) {
    const { doc, versionId } = await this.resolveDocument(userId, id);
    const base = `${slug(doc.contact.fullName)}-resume`;
    await audit(userId, "resume.exported", { requestId, entityType: "ResumeVersion", entityId: versionId ?? id, metadata: { format } });
    switch (format) {
      case "pdf":
        return { bytes: await renderResumePdf(doc), fileName: `${base}.pdf`, mimeType: "application/pdf" };
      case "docx":
        return { bytes: await renderResumeDocx(doc), fileName: `${base}.docx`, mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
      case "txt":
        return { bytes: Buffer.from(renderResumeText(doc), "utf8"), fileName: `${base}.txt`, mimeType: "text/plain; charset=utf-8" };
      case "html":
        return { bytes: Buffer.from(renderResumeHtml(doc, { standalone: true }), "utf8"), fileName: `${base}.html`, mimeType: "text/html; charset=utf-8" };
    }
  },

  /** Snapshot the verified profile as a new EDITED version (structured editor "Save as version"). */
  async snapshotProfile(userId: string, label: string, requestId?: string) {
    const profile = await profileRepo.ensure(userId);
    const doc = documentFromProfile(profile);
    const hash = resumeContentHash(doc);
    const parent = await prisma.resumeVersion.findFirst({ where: { userId, applicationId: null }, orderBy: { createdAt: "desc" } });
    if (parent?.contentHash === hash) return { id: parent.id, unchanged: true };
    const v = await prisma.resumeVersion.create({
      data: { userId, kind: "EDITED", label, content: doc as unknown as Prisma.InputJsonValue, contentHash: hash, parentVersionId: parent?.id, approvedAt: new Date() },
    });
    await audit(userId, "resume.version_created", { requestId, entityType: "ResumeVersion", entityId: v.id });
    return { id: v.id, unchanged: false };
  },

  async diff(userId: string, fromId: string, toId: string) {
    const [a, b] = await Promise.all([this.getVersion(userId, fromId), this.getVersion(userId, toId)]);
    return diffResumeText(a.text, b.text);
  },

  /** Name a resume variant ("Backend resume") and the roles it targets, used by automatic resume selection. */
  async updateVariant(userId: string, id: string, input: { label?: string | null; targetRoles?: string[] }) {
    const resume = await prisma.resume.findFirst({ where: { id, userId }, select: { id: true } });
    if (resume) {
      return prisma.resume.update({
        where: { id },
        data: { ...(input.label !== undefined ? { label: input.label || null } : {}), ...(input.targetRoles ? { targetRoles: input.targetRoles } : {}) },
        select: { id: true, label: true, targetRoles: true },
      });
    }
    // Variants without an uploaded file are resume versions (the label is what selection shows).
    const version = await prisma.resumeVersion.findFirst({ where: { id, userId, applicationId: null }, select: { id: true } });
    if (!version) throw Errors.notFound("Resume");
    if (input.label) await prisma.resumeVersion.update({ where: { id }, data: { label: input.label } });
    return { id, label: input.label ?? null, targetRoles: [] as string[] };
  },

  async getExtractedText(userId: string, resumeId: string): Promise<string | null> {
    const r = await prisma.resume.findFirst({ where: { id: resumeId, userId }, select: { extractedTextEnc: true } });
    return r?.extractedTextEnc ? decryptText(r.extractedTextEnc) : null;
  },
};

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "resume";
}
