import { describe, expect, it } from "vitest";
import { validateClaims } from "../src/guards/claim-validator";
import { facts } from "./helpers";

describe("claim-source validation", () => {
  it("accepts claims fully supported by cited verified facts", () => {
    const r = validateClaims([{ text: "Built a video timeline editor with React and TypeScript.", sourceFactIds: ["b1"] }], facts);
    expect(r.mayShow).toBe(true);
    expect(r.validClaims).toHaveLength(1);
    expect(r.unsupportedClaims).toHaveLength(0);
  });

  it("rejects claims without sources or citing unknown facts", () => {
    const r = validateClaims(
      [
        { text: "Expert in React.", sourceFactIds: [] },
        { text: "Built React apps.", sourceFactIds: ["does-not-exist"] },
      ],
      facts,
    );
    expect(r.mayShow).toBe(false);
    expect(r.unsupportedClaims.filter((u) => u.severity === "high")).toHaveLength(2);
  });

  it("rejects fabricated metrics", () => {
    const r = validateClaims([{ text: "Reduced dashboard load time by 60% with list virtualization.", sourceFactIds: ["b4"] }], facts);
    expect(r.mayShow).toBe(false);
    expect(r.unsupportedClaims[0]!.reason).toMatch(/60/);
    const ok = validateClaims([{ text: "Reduced dashboard load time by 40% using virtualization.", sourceFactIds: ["b4"] }], facts);
    expect(ok.mayShow).toBe(true);
  });

  it("rejects skills that are not in the verified profile", () => {
    const r = validateClaims([{ text: "Built a timeline editor in React with WebGL shaders.", sourceFactIds: ["b1"] }], facts);
    expect(r.mayShow).toBe(false);
    expect(r.unsupportedClaims.find((u) => u.reason.includes("WebGL"))?.severity).toBe("high");
  });

  it("flags skills from other facts that were not cited as medium", () => {
    const r = validateClaims([{ text: "Built a timeline editor in React using Redux.", sourceFactIds: ["b1"] }], facts);
    expect(r.unsupportedClaims.find((u) => u.reason.includes("Redux"))?.severity).toBe("medium");
    expect(r.mayShow).toBe(true);
    expect(r.validClaims).toHaveLength(0);
  });

  it("rejects fake employers and credentials", () => {
    const employer = validateClaims([{ text: "Built a timeline editor at Google.", sourceFactIds: ["b1"] }], facts);
    expect(employer.mayShow).toBe(false);
    const cert = validateClaims([{ text: "AWS certified engineer who designed chunked uploads to Amazon S3.", sourceFactIds: ["b3"] }], facts);
    expect(cert.mayShow).toBe(false);
    const allowed = validateClaims([{ text: "Built a timeline editor, relevant for Framecraft Labs.", sourceFactIds: ["b1"] }], facts, {
      allowedEntities: ["Framecraft Labs"],
    });
    expect(allowed.mayShow).toBe(true);
  });

  it("marks exaggerations as low severity", () => {
    const r = validateClaims([{ text: "World-class engineer who built a timeline editor.", sourceFactIds: ["b1"] }], facts);
    expect(r.mayShow).toBe(true);
    expect(r.unsupportedClaims[0]!.severity).toBe("low");
  });
});

describe("employer detection vs capitalised skills", () => {
  it("does not mistake a capitalised skill phrase for an organisation", () => {
    const f = [{ id: "b1", kind: "EXPERIENCE_BULLET" as const, text: "Built a video timeline editor with Canvas and state management" }];
    const r = validateClaims([{ text: "Hands-on experience with Video editing timelines and State management.", sourceFactIds: ["b1"] }], f);
    expect(r.unsupportedClaims.filter((u) => /organisation/.test(u.reason))).toEqual([]);
    expect(r.mayShow).toBe(true);
    // Real unknown employers are still caught.
    const bad = validateClaims([{ text: "Built a video timeline editor at Netflix.", sourceFactIds: ["b1"] }], f);
    expect(bad.mayShow).toBe(false);
  });
});

describe("fact id normalisation", () => {
  it('accepts ids copied in the "[id]" display format', () => {
    const r = validateClaims([{ text: "Built a video timeline editor with React and TypeScript.", sourceFactIds: ["[b1]", " profile:yoe "] }], facts);
    expect(r.mayShow).toBe(true);
    expect(r.validClaims[0]!.sourceFactIds).toEqual(["b1", "profile:yoe"]);
  });
});
