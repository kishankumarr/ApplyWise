import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractTextFromResume, parseCvText, parsedCvToDocument, renderResumeDocx, renderResumePdf } from "../src";

const here = dirname(fileURLToPath(import.meta.url));
const parsed = parseCvText(readFileSync(join(here, "..", "fixtures", "demo-cv.txt"), "utf8"), new Date("2026-09-01"));
const doc = parsedCvToDocument(parsed);

describe("uploaded file round-trip (render -> extract -> parse)", () => {
  it.each([
    ["docx", renderResumeDocx],
    ["pdf", renderResumePdf],
  ] as const)("keeps structure for %s", async (kind, render) => {
    const bytes = await render(doc);
    const text = await extractTextFromResume(kind, new Uint8Array(bytes));
    const again = parseCvText(text, new Date("2026-09-01"));
    expect(again.email).toBe("aarav.mehta@example.test");
    expect(again.experience.map((e) => e.company)).toEqual(["Clipverse Media", "Tasklane Software"]);
    expect(again.experience[0]!.bullets.length).toBe(5);
    expect(again.skills).toEqual(expect.arrayContaining(["React", "TypeScript"]));
  }, 20000);
});
