import { describe, expect, it } from "vitest";
import type { RawImportedJob } from "../src/connectors/types";
import { assessRelevance, roleTokens, titleMatchesKeywords, titleMatchesRole } from "../src/feeds/relevance";
import type { RelevancePrefs } from "../src/feeds/types";

function job(title: string, location?: string[] | string, extra: Partial<RawImportedJob["hints"]> = {}, text = ""): RawImportedJob {
  return {
    provider: "JOB_SEARCH_API",
    importMethod: "JOB_SEARCH_API",
    externalId: `test:${title}`,
    sourceUrl: null,
    attribution: "test",
    raw: {},
    text: text || `${title}\nBuild things.`,
    hints: { title, ...(location !== undefined ? { location } : {}), ...extra },
  };
}

const prefs = (over: Partial<RelevancePrefs> = {}): RelevancePrefs => ({
  targetRoles: ["Frontend Engineer"],
  preferredLocations: ["Bengaluru"],
  workModePreference: "any",
  openToRelocation: false,
  skills: [],
  ...over,
});

describe("role tokens", () => {
  it("lowercases, strips punctuation, merges synonyms and drops seniority", () => {
    expect(roleTokens("Sr. Front-End Engineer II")).toEqual(["frontend", "engineer"]);
    expect(roleTokens("Senior Software Development Engineer (SDE-3)")).toEqual(["swe"]);
    expect(roleTokens("Full Stack Developer")).toEqual(["fullstack", "swe"]);
    expect(roleTokens("Machine Learning Engineer")).toEqual(["ml", "engineer"]);
    expect(roleTokens("Node.js Backend Developer")).toEqual(["node", "backend", "swe"]);
    expect(roleTokens("Lead, Principal, Staff, Junior, Jr, Associate, III")).toEqual([]);
  });
});

describe("title matching", () => {
  const cases: [role: string, title: string, expected: boolean][] = [
    // frontend / front-end / front end / ui engineer
    ["Frontend Engineer", "Senior Frontend Engineer", true],
    ["Frontend Engineer", "Front-End Developer", true],
    ["Frontend Engineer", "Front End Engineer II", true],
    ["Frontend Engineer", "UI Engineer", true],
    ["Frontend Engineer", "Sr. React Developer", true],
    ["Frontend Engineer", "Software Engineer, Frontend", true],
    ["Frontend Engineer", "Staff Engineer - Front End (Payments)", true],
    ["Frontend Engineer", "Frontend Lead", true],
    ["Frontend Engineer", "Backend Engineer", false],
    ["Frontend Engineer", "Frontend Engineering Manager", false],
    ["Frontend Engineer", "Product Designer", false],
    ["Frontend Engineer", "UI/UX Designer", false],
    ["front-end engineer", "Frontend Developer", true],
    // backend / back-end
    ["Backend Engineer", "Back-end Developer (Node.js)", true],
    ["Backend Engineer", "Backend Engineer - Golang", true],
    ["Backend Engineer", "Senior Software Engineer - Backend", true],
    ["Back End Developer", "Backend Engineer", true],
    ["Backend Engineer", "Full Stack Engineer", false],
    // full stack / fullstack / full-stack
    ["Full Stack Developer", "Fullstack Engineer", true],
    ["Full Stack Developer", "Full-Stack Software Engineer", true],
    ["fullstack engineer", "Full Stack Developer (MERN)", true],
    // sde / software engineer / software developer / developer
    ["Software Engineer", "SDE II", true],
    ["Software Engineer", "Software Development Engineer", true],
    ["Software Engineer", "Software Developer", true],
    ["Software Engineer", "Developer", true],
    ["Software Engineer", "Senior Backend Engineer", true],
    ["SDE", "Software Engineer III", true],
    ["Software Developer", "SDE-1", true],
    ["Software Engineer", "Engineering Manager", false],
    ["Software Engineer", "Mechanical Engineer", false],
    ["Software Engineer", "Sales Engineer", false],
    // ml / machine learning, data scientist
    ["ML Engineer", "Machine Learning Engineer", true],
    ["Machine Learning Engineer", "Senior ML Engineer - Applied AI", true],
    ["ML Engineer", "Data Scientist", false],
    ["Data Scientist", "Senior Data Scientist", true],
    ["Data Scientist", "Lead Data Scientist, Risk", true],
    ["Data Scientist", "Data Science Manager", false],
    // devops / sre
    ["DevOps Engineer", "Site Reliability Engineer", true],
    ["DevOps Engineer", "SRE II", true],
    ["DevOps Engineer", "DevOps Lead", true],
    ["SRE", "DevOps Engineer", true],
    ["DevOps Engineer", "Platform Engineer", false],
    // product manager / pm
    ["Product Manager", "Senior Product Manager", true],
    ["Product Manager", "PM - Payments", true],
    ["Product Manager", "Associate Product Manager", true],
    ["PM", "Product Manager, Growth", true],
    ["Product Manager", "Project Manager", false],
    ["Product Manager", "Product Designer", false],
    // qa / sdet / test
    ["QA Engineer", "SDET", true],
    ["QA Engineer", "Quality Assurance Engineer", true],
    ["QA Engineer", "Test Engineer", true],
    ["QA Engineer", "QA Automation Lead", true],
    ["SDET", "QA Engineer II", true],
    // android / ios / mobile
    ["Mobile Engineer", "Android Developer", true],
    ["Mobile Engineer", "iOS Engineer", true],
    ["Mobile Engineer", "React Native Developer", true],
    ["Android Developer", "Mobile Engineer", true],
    ["Android Developer", "Senior Android Engineer", true],
    ["Android Developer", "iOS Developer", false],
    ["iOS Engineer", "Android Engineer", false],
    // frameworks imply the specialisation, but not a competing framework
    ["React Developer", "Frontend Engineer", true],
    ["React Developer", "Angular Developer", false],
    ["React Developer", "React Native Developer", false],
    // seniority words never matter
    ["Senior Frontend Engineer", "Junior Frontend Developer", true],
    ["Lead Backend Engineer", "Backend Engineer", true],
    // empty / filler-only roles never match
    ["Senior", "Senior Frontend Engineer", false],
    ["", "Frontend Engineer", false],
    // common Indian titles (review fixes)
    ["Software Engineer", "Member of Technical Staff", true],
    ["Software Engineer", "Senior Member Technical Staff", true],
    ["Software Engineer", "MTS 2", true],
    ["Software Engineer", "SMTS", true],
    ["Software Engineer", "Engineer - Software", true],
    ["Software Engineer", "Software Engineering Intern", true],
    ["Software Engineer", "C++ Engineer", true],
    ["Software Engineer", ".NET Engineer", true],
    ["Software Engineer", "Software Engineer - Hiring Manager Tools", true],
    ["Software Engineer", "Software Engineering Manager", false],
    ["Software Engineer", "Senior Manager (Software Engineering)", false],
    ["Software Engineer", "(Remote) Software Engineering Manager", false],
    ["Engineering Manager", "Manager, Software Engineering", true],
    ["Engineering Manager", "Engineering Manager - Backend", true],
    ["Backend Engineer", "Engineering Manager - Backend", false],
    ["Full Stack Developer", "MERN Stack Developer", true],
    ["Full Stack Developer", "MEAN Stack Developer", true],
    ["Full Stack Developer", "MERN Developer", true],
    ["UI/UX Designer", "UX Designer", true],
    ["UI/UX Designer", "UI Designer", true],
    ["UX Designer", "UI/UX Designer", true],
    ["UI UX Designer", "Senior UX/UI Designer", true],
    ["UI/UX Designer", "Graphic Designer", false],
    ["Machine Learning Engineer", "AI Engineer", true],
    ["AI Engineer", "Machine Learning Engineer", true],
    ["AI Engineer", "GenAI Engineer", true],
    ["AI Engineer", "Gen AI Engineer", true],
    ["AI Engineer", "LLM Engineer", true],
    ["AI Engineer", "AI Product Manager", false],
    ["DevOps Engineer", "DevSecOps Engineer", true],
    ["Salesforce Developer", "Salesforce Engineer", true],
    ["Software Tester", "Manual Tester", true],
    ["Customer Support Executive", "Customer Support Associate", true],
    ["Customer Support Executive", "Customer Support Specialist", true],
    ["Customer Support Executive", "Customer Support Engineer", false],
    ["Sales Executive", "Sales Officer", true],
    ["Sales Executive", "Sales Engineer", false],
    ["Sales Executive", "Area Sales Manager", false],
    ["Remote React Developer", "React Developer", true],
    ["Frontend Developer (Fresher)", "Frontend Developer", true],
  ];

  it.each(cases)("role %j vs title %j -> %s", (role, title, expected) => {
    expect(titleMatchesRole(title, role)).toBe(expected);
  });

  it("keyword filtering for keyword-less APIs is looser than role matching", () => {
    expect(titleMatchesKeywords("React Engineer", "react frontend")).toBe(true);
    expect(titleMatchesKeywords("Frontend Developer (React & TypeScript)", "react developer")).toBe(true);
    expect(titleMatchesKeywords("Customer Success Manager", "react developer")).toBe(false);
    // Generic words alone ("engineer", "software") are not enough.
    expect(titleMatchesKeywords("Mechanical Engineer", "software engineer")).toBe(false);
    expect(titleMatchesKeywords("Anything at all", "")).toBe(true);
  });
});

describe("assessRelevance: role or skills", () => {
  it("explains a title match with the matching role and place", () => {
    expect(assessRelevance(job("Senior Frontend Engineer", ["Bengaluru"]), prefs())).toEqual({
      relevant: true,
      reason: "Title matches 'Frontend Engineer'; Bengaluru",
    });
  });

  it("names the first target role that matches", () => {
    const result = assessRelevance(job("Machine Learning Engineer", ["Bengaluru"]), prefs({ targetRoles: ["Data Scientist", "ML Engineer"] }));
    expect(result).toEqual({ relevant: true, reason: "Title matches 'ML Engineer'; Bengaluru" });
  });

  it("treats a role like 'Software Engineer / Team Lead' as several roles", () => {
    const p = prefs({ targetRoles: ["Software Engineer / Team Lead"] });
    expect(assessRelevance(job("Senior Software Engineer", ["Bengaluru"]), p)).toEqual({ relevant: true, reason: "Title matches 'Software Engineer'; Bengaluru" });
    expect(assessRelevance(job("Backend Developer", ["Bengaluru"]), prefs({ targetRoles: ["SDE, Backend Developer"] })).reason).toBe("Title matches 'SDE'; Bengaluru");
    expect(assessRelevance(job("Data Engineer", ["Bengaluru"]), prefs({ targetRoles: ["Data Analyst or Data Engineer"] })).relevant).toBe(true);
    // An unspaced slash is part of the role name.
    expect(assessRelevance(job("UX Designer", ["Bengaluru"]), prefs({ targetRoles: ["UI/UX Designer"] })).relevant).toBe(true);
    expect(assessRelevance(job("Product Manager", ["Bengaluru"]), p).relevant).toBe(false);
  });

  it("rejects titles outside the target roles before looking at location", () => {
    expect(assessRelevance(job("Backend Engineer", ["Bengaluru"]), prefs())).toEqual({
      relevant: false,
      reason: "Title doesn't match your target roles",
    });
  });

  it("falls back to three or more verified skills when there are no target roles", () => {
    const skills = ["react", "TypeScript", "Node.js", "GraphQL"];
    const three = job("Engineer", ["Bengaluru"], {}, "We use React, TypeScript and Node.js on AWS.");
    expect(assessRelevance(three, prefs({ targetRoles: [], skills }))).toEqual({
      relevant: true,
      reason: "Mentions 3 of your skills (React, TypeScript, Node.js); Bengaluru",
    });
    const two = job("Engineer", ["Bengaluru"], {}, "We use React and TypeScript.");
    expect(assessRelevance(two, prefs({ targetRoles: [], skills }))).toEqual({
      relevant: false,
      reason: "Mentions 2 of your skills (needs 3)",
    });
    // Duplicate spellings of one skill count once.
    expect(assessRelevance(two, prefs({ targetRoles: [], skills: ["React", "react.js", "TypeScript"] })).relevant).toBe(false);
    // Blank target roles are ignored.
    expect(assessRelevance(three, prefs({ targetRoles: ["  "], skills })).relevant).toBe(true);
  });

  it("asks for roles or skills when neither is set", () => {
    expect(assessRelevance(job("Frontend Engineer", ["Bengaluru"]), prefs({ targetRoles: [], skills: [] }))).toEqual({
      relevant: false,
      reason: "Add target roles or skills to get matching jobs",
    });
  });
});

describe("assessRelevance: location", () => {
  const title = "Frontend Engineer";
  const cases: [name: string, location: string[] | string | undefined, extra: Partial<RawImportedJob["hints"]>, p: Partial<RelevancePrefs>, relevant: boolean, reason: string][] = [
    ["preferred city (alias)", ["Bangalore"], {}, {}, true, "Bengaluru"],
    ["one of several cities", ["Mumbai", "Bengaluru"], {}, {}, true, "Bengaluru"],
    ["location as a string", "Pune / Bengaluru", {}, {}, true, "Bengaluru"],
    ["NCR counts as one region", ["Gurgaon"], {}, { preferredLocations: ["Noida"] }, true, "Gurgaon"],
    ["other Indian city", ["Pune"], {}, {}, false, "Pune is not one of your preferred locations"],
    ["other Indian city, open to relocation", ["Pune"], {}, { openToRelocation: true }, true, "Pune (open to relocation)"],
    ["abroad, even when open to relocation", ["Singapore"], {}, { openToRelocation: true }, false, "Located in Singapore (outside India)"],
    ["no location", undefined, {}, {}, true, "Location not specified"],
    ["empty location list", [], {}, {}, true, "Location not specified"],
    ["hybrid in preferred city", ["Bengaluru"], { workMode: "hybrid" }, { workModePreference: "hybrid" }, true, "Bengaluru"],
    ["remote India", ["Remote - India"], { workMode: "remote" }, {}, true, "Remote - India"],
    ["remote India for a remote seeker", ["Remote - India"], { workMode: "remote" }, { workModePreference: "remote", preferredLocations: ["Remote - India"] }, true, "Remote - India"],
    ["remote global for a remote seeker", ["Remote - Global"], { workMode: "remote" }, { workModePreference: "remote", preferredLocations: [] }, true, "Remote - Global"],
    ["remote for a hybrid seeker", ["Remote - India"], { workMode: "remote" }, { workModePreference: "hybrid" }, true, "Remote - India"],
    ["remote label without a work-mode hint", ["Remote - India"], {}, {}, true, "Remote - India"],
    ["remote flag with an Indian city", ["Bengaluru"], { workMode: "remote" }, { preferredLocations: ["Pune"] }, true, "Remote (Bengaluru)"],
    ["remote flag without location", undefined, { workMode: "remote" }, {}, true, "Remote"],
    ["remote for an on-site seeker", ["Remote - India"], { workMode: "remote" }, { workModePreference: "onsite" }, false, "Remote role, but you prefer on-site work"],
    ["remote global for an on-site seeker", ["Remote - Global"], {}, { workModePreference: "onsite" }, false, "Remote role, but you prefer on-site work"],
    ["remote restricted to another country", ["United States"], { workMode: "remote" }, { workModePreference: "remote" }, false, "Remote role limited to United States"],
    [
      "remote-or-office listing for an on-site seeker in that city",
      ["Remote - India", "Bengaluru"],
      {},
      { workModePreference: "onsite" },
      true,
      "Bengaluru",
    ],
    ["remote role with a city, on-site seeker", ["Remote - India", "Bengaluru"], { workMode: "remote" }, { workModePreference: "onsite" }, false, "Remote role, but you prefer on-site work"],
    ["country-only India listing", ["India"], {}, {}, true, "India (city not specified)"],
    ["country-only India listing for a remote-only seeker", ["India"], {}, { workModePreference: "remote", preferredLocations: ["Remote - India"] }, false, "India is not one of your preferred locations"],
    ["no preferred locations = anywhere in India", ["Chennai"], {}, { preferredLocations: [] }, true, "Chennai"],
    ["no preferred locations, abroad", ["London, United Kingdom"], {}, { preferredLocations: [] }, false, "Located in London, United Kingdom (outside India)"],
    ["remote-only seeker, on-site job", ["Bengaluru"], { workMode: "onsite" }, { workModePreference: "remote", preferredLocations: ["Remote - India"] }, false, "Bengaluru is not one of your preferred locations"],
    ["remote-only seeker, on-site job in a listed city", ["Bengaluru"], { workMode: "onsite" }, { workModePreference: "remote", preferredLocations: ["Remote - India", "Bengaluru"] }, true, "Bengaluru"],
    // review fixes: multi-city strings, "City, State, Country", India-wide values
    ["comma-separated cities in a string", "Mumbai, Bengaluru, Pune", {}, { preferredLocations: ["Pune"] }, true, "Pune"],
    ["comma-separated cities in one array entry", ["Mumbai, Pune"], {}, { preferredLocations: ["Pune"] }, true, "Pune"],
    ["Naukri-style city list", "Bangalore/Bengaluru, Hyderabad/Secunderabad, Pune", {}, { preferredLocations: ["Pune"] }, true, "Pune"],
    ["city, state, country is one place", "Pune, Maharashtra, India", {}, {}, false, "Pune is not one of your preferred locations"],
    ["work-mode words in a raw string", "Hybrid in Bangalore, India", {}, {}, true, "Bengaluru"],
    ["a bare work-mode word names no place", "On-site", {}, {}, true, "Location not specified"],
    ["Pan India listing", ["Pan India"], {}, {}, true, "India (city not specified)"],
    ["Anywhere in India listing", "Anywhere in India", {}, { preferredLocations: ["Pune"] }, true, "India (city not specified)"],
    ["'India' as the preferred location", ["Chennai"], {}, { preferredLocations: ["India"] }, true, "Chennai"],
    ["'Pan India' as the preferred location", ["Kochi"], {}, { preferredLocations: ["Pan India"] }, true, "Kochi"],
    ["'India' preferred, job abroad", ["Dubai"], {}, { preferredLocations: ["India"] }, false, "Located in Dubai (outside India)"],
  ];

  it.each(cases)("%s", (_name, location, extra, p, relevant, reason) => {
    const result = assessRelevance(job(title, location, extra), prefs(p));
    expect(result.relevant).toBe(relevant);
    expect(result.reason).toBe(relevant ? `Title matches 'Frontend Engineer'; ${reason}` : reason);
  });
});
