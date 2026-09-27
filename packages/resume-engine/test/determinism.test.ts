import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { renderResumePdf, type ResumeDocument } from "../src";

const doc: ResumeDocument = {
  contact: { fullName: "A B", email: null, phone: null, location: null, links: [] },
  headline: null,
  summary: "S",
  experience: [],
  projects: [],
  skills: ["React"],
  education: [],
  achievements: [],
  sectionOrder: ["summary", "skills"],
};

describe("pdf determinism", () => {
  it("produces identical bytes for a fixed creation date (needed for email send confirmation digests)", async () => {
    const d = new Date("2026-01-01T00:00:00Z");
    const h = async () => createHash("sha256").update(await renderResumePdf(doc, { creationDate: d })).digest("hex");
    expect(await h()).toBe(await h());
  }, 20000);
});
