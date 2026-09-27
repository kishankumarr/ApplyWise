import { computeMatchReport, parseJobDescription } from "@applywise/job-engine";
import type { SourceFact } from "@applywise/types";
import type { GenerationContext } from "../src/context";

export const facts: SourceFact[] = [
  { id: "profile:yoe", kind: "OTHER", text: "5 years of professional experience" },
  { id: "profile:title", kind: "OTHER", text: "Current title: Senior Frontend Engineer at Clipverse Media" },
  { id: "b1", kind: "EXPERIENCE_BULLET", text: "Built a multi-track video timeline editor in React and TypeScript" },
  { id: "b2", kind: "EXPERIENCE_BULLET", text: "Implemented canvas-based preview rendering using the HTML5 Canvas API" },
  { id: "b3", kind: "EXPERIENCE_BULLET", text: "Designed resumable chunked uploads to Amazon S3 for multi-GB media files" },
  { id: "b4", kind: "EXPERIENCE_BULLET", text: "Reduced dashboard load time by 40% with list virtualization" },
  { id: "s1", kind: "SKILL", text: "Redux" },
];

export function makeContext(overrides: Partial<GenerationContext> = {}): GenerationContext {
  const job = {
    ...parseJobDescription(
      [
        "Senior Frontend Engineer",
        "Requirements",
        "- Must have React and TypeScript",
        "- Experience with HTML5 Canvas",
        "- Must have Kubernetes",
        "Nice to have",
        "- WebGL",
      ].join("\n"),
      { importMethod: "MANUAL_ENTRY", title: "Senior Frontend Engineer", company: "Framecraft Labs", location: ["Bengaluru"], workMode: "hybrid" },
    ),
    id: "job1",
  };
  const matchReport = computeMatchReport(job, {
    yoe: 5,
    preferredLocations: ["Bengaluru"],
    workModePreference: "any",
    openToRelocation: false,
    targetRoles: ["Frontend Engineer"],
    currentTitle: "Senior Frontend Engineer",
    facts: facts.map((f) => ({ ...f, status: "USER_VERIFIED" as const })),
    skills: [],
  });
  return {
    job,
    candidate: {
      fullName: "Aarav Mehta",
      email: "aarav@example.test",
      phone: "+91 98765 43210",
      yoe: 5,
      currentTitle: "Senior Frontend Engineer",
      currentCompany: "Clipverse Media",
      noticePeriod: "30 days",
      preferredLocations: ["Bengaluru"],
      openToRelocation: false,
      linkedinUrl: null,
      githubUrl: null,
      portfolioUrl: null,
    },
    facts,
    experiences: [{ id: "e1", title: "Senior Frontend Engineer", company: "Clipverse Media", bulletFactIds: ["b1", "b2", "b3", "b4"] }],
    answers: [],
    matchReport,
    ...overrides,
  };
}
