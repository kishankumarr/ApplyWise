import { describe, expect, it } from "vitest";
import {
  areRelatedSkills,
  extractSkillsFromText,
  getRelatedSkills,
  normalizeSkill,
  registerSkillAliases,
} from "../src/taxonomy";

describe("skill normalisation and synonyms", () => {
  it.each([
    ["React.js", "React"],
    ["ReactJS", "React"],
    ["reactjs", "React"],
    ["TypeScript", "TypeScript"],
    ["typescript", "TypeScript"],
    ["JS", "JavaScript"],
    ["Node", "Node.js"],
    ["NodeJS", "Node.js"],
    ["RESTful APIs", "REST API"],
    ["AWS S3", "Amazon S3"],
    ["React 18", "React"],
    ["Next.js", "Next.js"],
    ["Golang", "Go"],
  ])("normalises %s -> %s", (input, expected) => {
    expect(normalizeSkill(input)).toBe(expected);
  });

  it("keeps unknown skills as trimmed text", () => {
    expect(normalizeSkill("  Obscure Framework  ")).toBe("Obscure Framework");
  });

  it("treats related technology as related, not equal", () => {
    expect(areRelatedSkills("React", "Next.js")).toBe(true);
    expect(areRelatedSkills("React", "React")).toBe(false);
    expect(normalizeSkill("Next.js")).not.toBe(normalizeSkill("React"));
    expect(getRelatedSkills("Redux")).toContain("State management");
  });

  it("extracts skills from prose without substring false positives", () => {
    const skills = extractSkillsFromText(
      "Built a multi-track video timeline editor in React.js and TypeScript with HTML5 Canvas; resumable chunked uploads to AWS S3 via Node.js.",
    );
    expect(skills).toEqual(
      expect.arrayContaining(["React", "TypeScript", "Canvas API", "Video editing timelines", "Chunked uploads", "Amazon S3", "Node.js"]),
    );
    // "js" inside "node.js"/"react.js" must not produce JavaScript.
    expect(skills).not.toContain("JavaScript");
  });

  it("prefers the longest alias (React Native over React)", () => {
    const skills = extractSkillsFromText("Shipped apps with React Native.");
    expect(skills).toContain("React Native");
    expect(skills).not.toContain("React");
  });

  it("supports admin-extensible aliases", () => {
    expect(normalizeSkill("RN")).toBe("RN");
    registerSkillAliases([{ alias: "RN", canonical: "React Native" }]);
    expect(normalizeSkill("rn")).toBe("React Native");
    registerSkillAliases([{ alias: "tanstack query", canonical: "TanStack Query", related: ["React"] }]);
    expect(extractSkillsFromText("We use TanStack Query for caching")).toContain("TanStack Query");
    expect(areRelatedSkills("TanStack Query", "React")).toBe(true);
  });
});
