import type { NormalizedJob } from "@applywise/types";
import type { MatchCandidate } from "../src/matching";

export function makeJob(overrides: Partial<NormalizedJob> = {}): NormalizedJob {
  return {
    platform: "GREENHOUSE",
    title: "Senior Frontend Engineer",
    company: "Test Co",
    companyWebsite: null,
    location: ["Bengaluru"],
    workMode: "hybrid",
    employmentType: "full_time",
    seniority: "senior",
    description: "Build a video editor",
    responsibilities: [],
    requiredSkills: [
      { name: "React", canonicalName: "React", mandatory: true },
      { name: "TypeScript", canonicalName: "TypeScript", mandatory: false },
    ],
    preferredSkills: [{ name: "WebGL", canonicalName: "WebGL", mandatory: false }],
    otherRequirements: [],
    domains: ["video & media"],
    experienceMinYears: 4,
    experienceMaxYears: 7,
    salaryMin: null,
    salaryMax: null,
    currency: null,
    postedAt: null,
    expiresAt: null,
    applyUrl: "https://example.test/apply",
    hrEmail: null,
    applicationInstructions: null,
    screeningQuestions: [],
    applyMethod: "CAREER_PAGE",
    importMethod: "MANUAL_ENTRY",
    sourceUrl: null,
    sourceExternalId: null,
    ...overrides,
  };
}

export function makeCandidate(overrides: Partial<MatchCandidate> = {}): MatchCandidate {
  return {
    yoe: 5,
    preferredLocations: ["Bengaluru", "Remote - India"],
    workModePreference: "any",
    openToRelocation: false,
    targetRoles: ["Frontend Engineer"],
    currentTitle: "Senior Frontend Developer",
    facts: [
      {
        id: "f1",
        kind: "EXPERIENCE_BULLET",
        text: "Built a video timeline editor in React and TypeScript for a media platform",
        status: "USER_VERIFIED",
      },
    ],
    skills: [
      { id: "s1", name: "React", source: "SKILLS_SECTION", status: "USER_VERIFIED" },
      { id: "s2", name: "TypeScript", source: "SKILLS_SECTION", status: "USER_VERIFIED" },
    ],
    resumeFormatWarnings: [],
    ...overrides,
  };
}
