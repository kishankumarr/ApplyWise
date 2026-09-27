import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  checkResumeFormat,
  detectResumeFileKind,
  diffResumeText,
  extractTextFromResume,
  parseCvText,
  renderResumeDocx,
  renderResumeHtml,
  renderResumePdf,
  renderResumeText,
  UnsupportedResumeFileError,
  type ResumeDocument,
} from "../src";

const here = dirname(fileURLToPath(import.meta.url));
const cvText = readFileSync(join(here, "..", "fixtures", "demo-cv.txt"), "utf8");

describe("rule-based CV parser", () => {
  const parsed = parseCvText(cvText, new Date("2026-09-01"));

  it("extracts contact details", () => {
    expect(parsed.fullName).toBe("Aarav Mehta");
    expect(parsed.email).toBe("aarav.mehta@example.test");
    expect(parsed.phone).toContain("98765");
    expect(parsed.headline).toBe("Senior Frontend Engineer");
    expect(parsed.links.github).toBe("https://github.com/aarav-demo");
    expect(parsed.links.linkedin).toBe("https://linkedin.com/in/aarav-demo");
  });

  it("extracts experience with bullets and dates", () => {
    expect(parsed.experience).toHaveLength(2);
    const [first, second] = parsed.experience;
    expect(first).toMatchObject({ title: "Senior Frontend Engineer", company: "Clipverse Media", location: "Bengaluru", isCurrent: true, startDate: "Jan 2023" });
    expect(first!.bullets).toHaveLength(5);
    expect(second).toMatchObject({ title: "Frontend Developer", company: "Tasklane Software", endDate: "Dec 2022" });
    expect(parsed.totalYearsExperience).toBe(5);
  });

  it("extracts skills, projects and education without inventing", () => {
    expect(parsed.skills).toEqual(expect.arrayContaining(["React", "TypeScript", "Zustand", "PostgreSQL"]));
    expect(parsed.projects.map((p) => p.name)).toEqual(["ReelNotes", "Chunky"]);
    expect(parsed.projects[0]!.technologies).toEqual(expect.arrayContaining(["React", "Canvas API", "WebCodecs"]));
    expect(parsed.education[0]).toMatchObject({ degree: "B.Tech", startYear: 2014, endYear: 2018 });
    expect(parsed.certifications).toEqual([]);
  });

  it("merges overlapping roles before adding up total experience (concurrent roles are never counted twice)", () => {
    const cv = (roles: string[]) => parseCvText(["Asha Rao", "asha@example.test", "", "Experience", ...roles].join("\n"), new Date("2026-09-01"));
    // Full-time 2020-2024 plus a concurrent freelance role 2021-2024: 4 years, not 7.
    const concurrent = cv(["Software Engineer at Acme | Jan 2020 - Jan 2024", "- Built APIs", "Freelance Developer at Self | Jan 2021 - Jan 2024", "- Built sites"]);
    expect(concurrent.experience).toHaveLength(2);
    expect(concurrent.totalYearsExperience).toBe(4);
    // A role fully inside another adds nothing; back-to-back roles are contiguous.
    expect(cv(["Engineer at Acme | Jan 2018 - Jan 2024", "- a", "Consultant at Beta | Jun 2019 - Jun 2020", "- b"]).totalYearsExperience).toBe(6);
    expect(cv(["Engineer at Acme | Jan 2018 - Jan 2020", "- a", "Engineer at Beta | Jan 2020 - Jan 2022", "- b"]).totalYearsExperience).toBe(4);
    // Separate roles with a gap: the gap is not experience.
    expect(cv(["Engineer at Acme | Jan 2016 - Jan 2018", "- a", "Engineer at Beta | Jan 2020 - Jan 2021", "- b"]).totalYearsExperience).toBe(3);
    // A current role overlapping an earlier one ends now.
    expect(cv(["Engineer at Acme | Jan 2022 - Present", "- a", "Mentor at Beta | Jan 2023 - Jan 2024", "- b"]).totalYearsExperience).toBe(4.7);
  });

  it("leaves ambiguous data null", () => {
    const p = parseCvText("Some Person\nI like computers.");
    expect(p.email).toBeNull();
    expect(p.phone).toBeNull();
    expect(p.totalYearsExperience).toBeNull();
    expect(p.experience).toEqual([]);
  });

  it("reports ATS-readability warnings", () => {
    expect(checkResumeFormat(cvText, parsed)).toEqual([]);
    const warnings = checkResumeFormat("Name only", parseCvText("Name only"));
    expect(warnings.join(" ")).toMatch(/email/);
    expect(warnings.join(" ")).toMatch(/Experience/);
  });
});

describe("file validation", () => {
  const pdfBytes = new TextEncoder().encode("%PDF-1.7 ...");
  const zipBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0]);
  it("accepts matching extension, MIME and magic bytes", () => {
    expect(detectResumeFileKind("cv.pdf", "application/pdf", pdfBytes)).toBe("pdf");
    expect(detectResumeFileKind("cv.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", zipBytes)).toBe("docx");
  });
  it("rejects other types and spoofed content", () => {
    expect(() => detectResumeFileKind("cv.exe", "application/pdf", pdfBytes)).toThrow(UnsupportedResumeFileError);
    expect(() => detectResumeFileKind("cv.pdf", "image/png", pdfBytes)).toThrow(UnsupportedResumeFileError);
    expect(() => detectResumeFileKind("cv.pdf", "application/pdf", zipBytes)).toThrow(/valid PDF/);
    expect(() => detectResumeFileKind("cv.docx", "", pdfBytes)).toThrow(/valid DOCX/);
  });
});

const doc: ResumeDocument = {
  contact: { fullName: "Aarav Mehta", email: "a@example.test", phone: null, location: "Bengaluru", links: [] },
  headline: "Frontend Engineer",
  summary: "Frontend engineer <with> React.",
  experience: [{ title: "Engineer", company: "Clipverse", location: null, startDate: "Jan 2023", endDate: null, bullets: ["Built a timeline"] }],
  projects: [],
  skills: ["React", "TypeScript"],
  education: [],
  achievements: [],
  sectionOrder: ["summary", "experience", "skills"],
};

describe("renderers and exports", () => {
  it("renders ATS-readable HTML without tables and escapes content", () => {
    const html = renderResumeHtml(doc, { standalone: true });
    expect(html).not.toMatch(/<table|<img|<svg/i);
    expect(html).toContain("&lt;with&gt;");
    expect(html.indexOf("Profile Summary")).toBeLessThan(html.indexOf("Experience"));
  });

  it("renders plain text and diffs versions", () => {
    const a = renderResumeText(doc);
    const b = renderResumeText({ ...doc, skills: ["React", "TypeScript", "Canvas API"] });
    const diff = diffResumeText(a, b);
    expect(diff.filter((d) => d.type === "added").map((d) => d.text)).toEqual(["React, TypeScript, Canvas API"]);
    expect(diff.filter((d) => d.type === "removed").map((d) => d.text)).toEqual(["React, TypeScript"]);
  });

  it("exports a text-selectable PDF and a DOCX that round-trip", async () => {
    const pdf = await renderResumePdf(doc);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    const pdfText = await extractTextFromResume("pdf", new Uint8Array(pdf));
    expect(pdfText).toContain("Aarav Mehta");
    expect(pdfText).toContain("Built a timeline");

    const docx = await renderResumeDocx(doc);
    expect(detectResumeFileKind("x.docx", "", new Uint8Array(docx))).toBe("docx");
    const docxText = await extractTextFromResume("docx", new Uint8Array(docx));
    expect(docxText).toContain("Profile Summary");
    expect(docxText).toContain("Built a timeline");
  }, 20000);
});
