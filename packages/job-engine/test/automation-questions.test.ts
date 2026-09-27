import { describe, expect, it } from "vitest";
import type { ApplicationQuestion } from "@applywise/types";
import { parseJobDescription } from "../src/jd-parser";
import {
  classifyQuestion,
  collectApplicationQuestions,
  countryForLocations,
  normalizeQuestionText,
  questionKeyFor,
  requiresApplicationScopedAnswer,
  resolveAnswer,
  resolveApplicationAnswers,
  standardApplicationQuestions,
  type AnswerSources,
} from "../src/automation/questions";

function makeSources(overrides: Partial<AnswerSources> = {}): AnswerSources {
  return {
    profile: {
      fullName: "Priya Raman Sharma",
      email: "priya@example.test",
      phone: "+91 98765 43210",
      currentTitle: "Senior Software Engineer",
      currentCompany: "Acme Labs",
      yoe: 5.5,
      linkedinUrl: "https://linkedin.com/in/priya",
      githubUrl: "https://github.com/priya",
      portfolioUrl: null,
      location: "Bengaluru",
      highestEducation: null,
    },
    preference: {
      noticePeriod: "30 days",
      expectedSalaryMin: 2_800_000,
      expectedSalaryMax: 3_800_000,
      currency: "INR",
      openToRelocation: false,
      workModePreference: "remote",
    },
    verifiedSkills: [
      { id: "sk-react", name: "ReactJS", canonicalName: "React", yearsUsed: 4 },
      { id: "sk-ts", name: "TypeScript", canonicalName: "TypeScript", yearsUsed: null },
      { id: "sk-py", name: "Python", canonicalName: "Python", yearsUsed: 2.5 },
    ],
    verifiedFacts: [
      { id: "f-k8s", kind: "EXPERIENCE_BULLET", text: "Migrated 40 services to Kubernetes with Helm charts" },
      { id: "f-tf", kind: "PROJECT", text: "Provisioned the staging stack with Terraform" },
      { id: "f-edu1", kind: "EDUCATION", text: "B.Tech in Computer Science, NIT Trichy, 2016" },
      { id: "f-edu2", kind: "EDUCATION", text: "M.Tech in Data Science, IIT Madras, 2018" },
    ],
    previousAnswers: [],
    candidateAnswers: [],
    ...overrides,
  };
}

const q = (text: string, opts: Parameters<typeof classifyQuestion>[1] = {}): ApplicationQuestion => classifyQuestion(text, { required: true, ...opts });

describe("classifyQuestion", () => {
  it.each([
    ["First Name", "first_name"],
    ["Given name", "first_name"],
    ["Last Name*", "last_name"],
    ["Surname", "last_name"],
    ["Full name", "full_name"],
    ["Name", "full_name"],
    ["Email address", "email"],
    ["E-mail ID", "email"],
    ["Mobile number", "phone"],
    ["Phone", "phone"],
    ["Contact number", "phone"],
    ["WhatsApp number", "phone"],
    ["Current location", "current_location"],
    ["Where are you currently based?", "current_location"],
    ["Current city", "current_location"],
    ["LinkedIn profile URL", "linkedin_url"],
    ["LinkedIn", "linkedin_url"],
    ["GitHub profile", "github_url"],
    ["Portfolio / website", "portfolio_url"],
    ["Personal website", "portfolio_url"],
    ["Current company", "current_company"],
    ["Current employer", "current_company"],
    ["Current organisation name", "current_company"],
    ["Current designation", "current_title"],
    ["Current job title", "current_title"],
    ["Total experience (in years)", "total_experience_years"],
    ["How many years of experience do you have?", "total_experience_years"],
    ["Total years of experience", "total_experience_years"],
    ["Overall experience", "total_experience_years"],
    ["How many years of experience do you have in total?", "total_experience_years"],
    ["Total years of experience in the IT industry", "total_experience_years"],
    ["What is your notice period?", "notice_period"],
    ["Notice period (in days)", "notice_period"],
    ["How soon can you join?", "notice_period"],
    ["Are you an immediate joiner?", "notice_period"],
    ["Can you join within 30 days?", "notice_period"],
    ["Current CTC", "current_salary"],
    ["What is your current CTC (in LPA)?", "current_salary"],
    ["Current salary", "current_salary"],
    ["What is your CTC?", "current_salary"],
    ["Last drawn salary", "current_salary"],
    ["Expected CTC", "expected_salary"],
    ["What are your salary expectations?", "expected_salary"],
    ["Expected compensation", "expected_salary"],
    ["ECTC (LPA)", "expected_salary"],
    ["Do you have a valid work permit?", "work_authorization"],
    ["Will you now or in the future require visa sponsorship?", "visa_sponsorship"],
    ["Do you require sponsorship for employment visa status (e.g. H-1B)?", "visa_sponsorship"],
    ["Visa sponsorship", "visa_sponsorship"],
    ["Are you willing to relocate to Bengaluru?", "willing_to_relocate"],
    ["Open to relocation?", "willing_to_relocate"],
    ["Preferred work mode", "work_mode_preference"],
    ["Do you prefer remote, hybrid or onsite work?", "work_mode_preference"],
    ["Earliest start date", "earliest_start_date"],
    ["When can you start?", "earliest_start_date"],
    ["Highest qualification", "highest_education"],
    ["What is your highest level of education?", "highest_education"],
    ["Highest degree", "highest_education"],
    ["Cover letter", "cover_letter"],
    ["Resume/CV", "resume"],
    ["Upload your resume", "resume"],
    ["CV", "resume"],
    ["How did you hear about this job?", "how_did_you_hear"],
    ["Gender", "diversity"],
    ["Do you identify as a veteran?", "diversity"],
    ["Disability status", "diversity"],
    ["Ethnicity", "diversity"],
    ["Why do you want to join us?", "custom"],
    ["Have you worked in a startup before?", "custom"],
    ["How many years of experience do you have in sales?", "custom"],
    ["What is your current and expected CTC?", "custom"],
    ["Are you comfortable with on-call rotations?", "custom"],
    ["Are you serving your notice period?", "custom"],
    ["What is your last working day?", "custom"],
    ["Relevant experience (in years)", "custom"],
    ["How many years of experience do you have in Java and Spring Boot?", "custom"],
    ["Are you comfortable working from office 5 days a week?", "custom"],
    ["Preferred location", "custom"],
    ["Manager's email address", "custom"],
    ["Emergency contact number", "custom"],
    ["Referrer name", "custom"],
    ["Do you have experience with race conditions?", "custom"],
  ])("%s -> %s", (text, expected) => {
    expect(classifyQuestion(text).canonicalKey).toBe(expected);
  });

  it("classifies skill-years questions with the canonical skill in the key", () => {
    for (const text of [
      "How many years of experience do you have with React?",
      "How many years of experience do you have in ReactJS?",
      "How many years of React.js experience do you have?",
      "Years of professional experience with React.js",
      "React experience (in years)",
      "Experience with ReactJS (years)",
    ]) {
      const c = classifyQuestion(text);
      expect(c.canonicalKey, text).toBe("skill_experience_years");
      expect(c.skill, text).toBe("React");
      expect(c.key, text).toBe("skill_experience_years:react");
      expect(c.inputType, text).toBe("number");
    }
    expect(classifyQuestion("How many years have you worked with Python?").key).toBe("skill_experience_years:python");
    expect(classifyQuestion("Years of experience in Node.js").key).toBe("skill_experience_years:node.js");
    expect(classifyQuestion("PyTorch experience (years)").key).toBe("skill_experience_years:pytorch");
  });

  it("classifies skill-experience questions (taxonomy aliases and unknown technology names)", () => {
    expect(classifyQuestion("Do you have experience with Kubernetes?")).toMatchObject({ canonicalKey: "skill_experience", skill: "Kubernetes", key: "skill_experience:kubernetes" });
    expect(classifyQuestion("Have you worked with K8s?").key).toBe("skill_experience:kubernetes");
    expect(classifyQuestion("Have you used Kubernetes in production?").key).toBe("skill_experience:kubernetes");
    expect(classifyQuestion("Do you have hands-on experience in Docker?").key).toBe("skill_experience:docker");
    expect(classifyQuestion("Do you know SQL?").key).toBe("skill_experience:sql");
    expect(classifyQuestion("Are you proficient in C++?").key).toBe("skill_experience:c++");
    expect(classifyQuestion("Do you know how to drive?").canonicalKey).toBe("custom");
    expect(classifyQuestion("Are you familiar with Terraform?")).toMatchObject({ canonicalKey: "skill_experience", skill: "Terraform", key: "skill_experience:terraform" });
    // Two skills in one question cannot be answered from one skill's evidence.
    expect(classifyQuestion("Do you have experience with React and Kubernetes?").canonicalKey).toBe("custom");
  });

  it("adds the country to work authorisation / sponsorship keys (authorisation for one country says nothing about another)", () => {
    expect(questionKeyFor("Are you authorised to work in India?")).toBe("work_authorization:india");
    expect(questionKeyFor("Are you legally authorized to work in the United States?")).toBe("work_authorization:us");
    expect(questionKeyFor("Are you authorized to work in the US without requiring sponsorship?")).toBe("work_authorization:us");
    expect(questionKeyFor("Do you have the right to work in the UK?")).toBe("work_authorization:uk");
    expect(questionKeyFor("Will you require visa sponsorship to work in the UK?")).toBe("visa_sponsorship:uk");
    expect(questionKeyFor("Are you authorized to work in the country where this job is located?")).toBe("work_authorization");
    // "us" the pronoun is not a country.
    expect(questionKeyFor("Are you legally allowed to work for us?")).toBe("work_authorization");
  });

  it("keeps diversity categories apart (a gender answer is never a veteran answer)", () => {
    expect(questionKeyFor("Gender")).toBe("diversity:gender");
    expect(questionKeyFor("What is your gender?")).toBe("diversity:gender");
    expect(questionKeyFor("Do you identify as a veteran?")).toBe("diversity:veteran");
    expect(questionKeyFor("Disability status")).toBe("diversity:disability");
    expect(questionKeyFor("Are you a person with disability (PwD)?")).toBe("diversity:disability");
    expect(questionKeyFor("Race / ethnicity")).toBe("diversity:ethnicity");
    const sources = makeSources({ candidateAnswers: [{ id: "ca-g", questionKey: "diversity:gender", question: "Gender", answer: "Female" }] });
    expect(resolveAnswer(q("What is your gender?"), sources)).toMatchObject({ answer: "Female", source: "CANDIDATE_ANSWER" });
    expect(resolveAnswer(q("Do you identify as a veteran?"), sources)).toMatchObject({ status: "UNKNOWN", answer: null });
  });

  it("builds stable custom keys from the normalised text", () => {
    const a = questionKeyFor("Why do you want to join us?");
    expect(a).toMatch(/^custom:[0-9a-f]{12}$/);
    expect(questionKeyFor("  why do you want to JOIN us ?* ")).toBe(a);
    expect(questionKeyFor("Why do you want to join us? (required)")).toBe(a);
    expect(questionKeyFor("What motivates you?")).not.toBe(a);
    expect(normalizeQuestionText("What's your notice period? (required)")).toBe("whats your notice period");
  });

  it("marks sensitive keys and picks obvious input types; opts override", () => {
    expect(classifyQuestion("Expected CTC").sensitive).toBe(true);
    expect(classifyQuestion("Current CTC").sensitive).toBe(true);
    expect(classifyQuestion("Gender").sensitive).toBe(true);
    expect(classifyQuestion("Email address").sensitive).toBe(false);
    expect(classifyQuestion("Email address").inputType).toBe("email");
    expect(classifyQuestion("LinkedIn profile URL").inputType).toBe("url");
    expect(classifyQuestion("Upload your resume").inputType).toBe("file");
    expect(classifyQuestion("Total experience (in years)").inputType).toBe("number");
    expect(classifyQuestion("Why do you want to join us?").inputType).toBe("text");
    expect(classifyQuestion("Gender", { options: ["Female", "Male", "Prefer not to say"] }).inputType).toBe("select");
    const c = classifyQuestion("Expected CTC", { required: true, options: ["10-20 LPA", " ", "20-30 LPA"], inputType: "select", origin: "provider" });
    expect(c).toMatchObject({ required: true, inputType: "select", options: ["10-20 LPA", "20-30 LPA"], origin: "provider" });
    expect(classifyQuestion("Expected CTC")).toMatchObject({ required: false, options: null, origin: "job_description" });
  });
});

describe("standard and collected questions", () => {
  it("lists the standard application fields", () => {
    const std = standardApplicationQuestions();
    expect(std.map((x) => [x.key, x.required, x.inputType])).toEqual([
      ["first_name", true, "text"],
      ["last_name", true, "text"],
      ["email", true, "email"],
      ["phone", false, "text"],
      ["resume", true, "file"],
      ["cover_letter", false, "textarea"],
      ["linkedin_url", false, "url"],
    ]);
    expect(std.every((x) => x.origin === "standard")).toBe(true);
    // Standard keys agree with the classifier, so provider fields de-duplicate against them.
    for (const x of std) expect(questionKeyFor(x.question)).toBe(x.key);
  });

  it("merges standard + JD + provider questions; provider wins over JD, JD over standard", () => {
    const qs = collectApplicationQuestions({
      screeningQuestions: ["What is your notice period? (required)", "Are you comfortable with on-call rotations?", "Expected CTC*", "Email address"],
      providerQuestions: [
        { question: "Notice Period", required: false, inputType: "select", options: ["Immediate", "15 days", "1 month", "2 months"], providerKey: "q_notice" },
        { question: "First Name", required: true, inputType: "text", options: null, providerKey: "first_name" },
        { question: "Do you have experience with Kubernetes?", required: true, inputType: "boolean", options: null, providerKey: "q_k8s" },
      ],
    });
    const keys = qs.map((x) => x.key);
    expect(new Set(keys).size).toBe(keys.length);
    const notice = qs.find((x) => x.key === "notice_period")!;
    expect(notice).toMatchObject({ origin: "provider", required: false, inputType: "select", options: ["Immediate", "15 days", "1 month", "2 months"] });
    const oncall = qs.find((x) => x.question === "Are you comfortable with on-call rotations?")!;
    expect(oncall).toMatchObject({ origin: "job_description", required: false, canonicalKey: "custom" });
    const ctc = qs.find((x) => x.key === "expected_salary")!;
    expect(ctc).toMatchObject({ origin: "job_description", required: true, question: "Expected CTC" });
    expect(qs.find((x) => x.key === "email")!.origin).toBe("job_description");
    expect(qs.find((x) => x.key === "first_name")!.origin).toBe("provider");
    expect(qs.find((x) => x.key === "skill_experience:kubernetes")).toMatchObject({ origin: "provider", inputType: "boolean", required: true });
    // Standard fields keep their position at the top.
    expect(keys.slice(0, 3)).toEqual(["first_name", "last_name", "email"]);
    expect(collectApplicationQuestions({ screeningQuestions: ["Expected CTC"], providerQuestions: [], includeStandard: false }).map((x) => x.key)).toEqual(["expected_salary"]);
  });
});

describe("resolveAnswer - profile, preferences and TruthBank", () => {
  const sources = makeSources();

  it("answers identity and contact fields from the profile", () => {
    expect(resolveAnswer(q("First name"), sources)).toMatchObject({ status: "RESOLVED", answer: "Priya", source: "PROFILE", sourceRef: "fullName" });
    expect(resolveAnswer(q("Last name"), sources)).toMatchObject({ answer: "Raman Sharma", source: "PROFILE" });
    expect(resolveAnswer(q("Full name"), sources).answer).toBe("Priya Raman Sharma");
    expect(resolveAnswer(q("Email address"), sources)).toMatchObject({ answer: "priya@example.test", sourceRef: "email" });
    expect(resolveAnswer(q("Mobile number"), sources)).toMatchObject({ answer: "+91 98765 43210", sourceRef: "phone" });
    expect(resolveAnswer(q("LinkedIn profile URL"), sources)).toMatchObject({ answer: "https://linkedin.com/in/priya", sourceRef: "linkedinUrl" });
    expect(resolveAnswer(q("GitHub profile"), sources)).toMatchObject({ answer: "https://github.com/priya", sourceRef: "githubUrl" });
    expect(resolveAnswer(q("Current company"), sources)).toMatchObject({ answer: "Acme Labs", sourceRef: "currentCompany" });
    expect(resolveAnswer(q("Current designation"), sources)).toMatchObject({ answer: "Senior Software Engineer", sourceRef: "currentTitle" });
    expect(resolveAnswer(q("Current city"), sources)).toMatchObject({ answer: "Bengaluru", sourceRef: "location" });
    const yoe = resolveAnswer(q("Total experience (in years)"), sources);
    expect(yoe).toMatchObject({ answer: "5.5", source: "PROFILE", sourceRef: "yoe" });
    expect(yoe.reason).toContain("profile");
    expect(resolveAnswer(q("Total experience (in years)"), makeSources({ profile: { ...sources.profile, yoe: 5 } })).answer).toBe("5");
  });

  it("never invents a missing profile value", () => {
    const portfolio = resolveAnswer(q("Portfolio / website"), sources);
    expect(portfolio).toMatchObject({ status: "UNKNOWN", answer: null, source: "UNKNOWN" });
    expect(portfolio.reason).toMatch(/no portfolio/i);
    const single = makeSources({ profile: { ...sources.profile, fullName: "Priya" } });
    expect(resolveAnswer(q("First name"), single).answer).toBe("Priya");
    expect(resolveAnswer(q("Last name"), single)).toMatchObject({ status: "UNKNOWN", answer: null });
  });

  it("answers skill years only from verified skills with recorded years", () => {
    const react = resolveAnswer(q("How many years of experience do you have with React?"), sources);
    expect(react).toMatchObject({ status: "RESOLVED", answer: "4", source: "TRUTH_BANK", sourceRef: "sk-react" });
    expect(resolveAnswer(q("How many years have you worked with Python?"), sources).answer).toBe("2.5");
    const ts = resolveAnswer(q("How many years of TypeScript experience do you have?"), sources);
    expect(ts).toMatchObject({ status: "UNKNOWN", answer: null });
    expect(ts.reason).toMatch(/no years of experience are recorded/);
    // Total experience is never used as a skill's years.
    expect(resolveAnswer(q("How many years of experience do you have with Go?"), sources)).toMatchObject({ status: "UNKNOWN", answer: null });
  });

  it("answers skill experience from verified skills or verified facts, never 'No' from missing evidence", () => {
    expect(resolveAnswer(q("Do you have experience with React?"), sources)).toMatchObject({ answer: "Yes", source: "TRUTH_BANK", sourceRef: "sk-react" });
    const k8s = resolveAnswer(q("Have you worked with K8s?"), sources);
    expect(k8s).toMatchObject({ answer: "Yes", source: "TRUTH_BANK", sourceRef: "f-k8s" });
    expect(k8s.reason).toContain("Kubernetes");
    expect(resolveAnswer(q("Are you familiar with Terraform?"), sources)).toMatchObject({ answer: "Yes", sourceRef: "f-tf" });
    const rust = resolveAnswer(q("Do you have experience with Rust?"), sources);
    expect(rust).toMatchObject({ status: "UNKNOWN", answer: null, source: "UNKNOWN" });
    expect(rust.reason).toContain('"No" is never assumed');
    // Even a yes/no question with options stays unknown without evidence.
    expect(resolveAnswer(q("Do you have experience with Rust?", { options: ["Yes", "No"] }), sources).status).toBe("UNKNOWN");
  });

  it("answers notice period and expected salary from preferences", () => {
    expect(resolveAnswer(q("What is your notice period?"), sources)).toMatchObject({ answer: "30 days", source: "PREFERENCE", sourceRef: "noticePeriod" });
    expect(resolveAnswer(q("Expected CTC"), sources)).toMatchObject({ answer: "INR 2,800,000 - 3,800,000 per year", source: "PREFERENCE", sourceRef: "expectedSalary" });
    expect(resolveAnswer(q("Expected CTC (in LPA)"), sources).answer).toBe("28 - 38 LPA");
    const onlyMin = makeSources({ preference: { ...sources.preference, expectedSalaryMax: null, currency: "usd" } });
    expect(resolveAnswer(q("What are your salary expectations?"), onlyMin).answer).toBe("USD 2,800,000 per year");
  });

  it("answers relocation only from an explicit 'open to relocation', and only when no place is named", () => {
    const off = resolveAnswer(q("Are you willing to relocate?"), sources);
    expect(off).toMatchObject({ status: "UNKNOWN", answer: null });
    expect(off.reason).toMatch(/default/);
    const on = makeSources({ preference: { ...sources.preference, openToRelocation: true } });
    expect(resolveAnswer(q("Are you willing to relocate?"), on)).toMatchObject({ answer: "Yes", source: "PREFERENCE", sourceRef: "openToRelocation" });
    expect(resolveAnswer(q("Open to relocation?", { options: ["Yes", "No"] }), on)).toMatchObject({ answer: "Yes", source: "PREFERENCE" });
    // Being open to relocation in general is not a "Yes" to one particular city or country.
    for (const text of ["Are you willing to relocate to Pune?", "Would you relocate to London for this role?", "Are you open to relocating to the United States?", "Are you willing to relocate to our Hyderabad office?"]) {
      const named = resolveAnswer(q(text), on);
      expect(named, text).toMatchObject({ status: "UNKNOWN", answer: null, source: "UNKNOWN" });
      expect(named.reason, text).toMatch(/names a specific place/);
    }
  });

  it("answers work mode preference unless it is 'any'", () => {
    expect(resolveAnswer(q("Preferred work mode"), sources)).toMatchObject({ answer: "Remote", source: "PREFERENCE" });
    const any = makeSources({ preference: { ...sources.preference, workModePreference: "any" } });
    expect(resolveAnswer(q("Preferred work mode"), any).status).toBe("UNKNOWN");
    expect(resolveAnswer(q("Preferred work mode", { options: ["Work from office", "Hybrid", "Work from home"] }), sources).answer).toBe("Work from home");
  });

  it("answers highest education from the highest verified education fact", () => {
    expect(resolveAnswer(q("Highest qualification"), sources)).toMatchObject({ answer: "M.Tech in Data Science, IIT Madras, 2018", source: "TRUTH_BANK", sourceRef: "f-edu2" });
    expect(resolveAnswer(q("Highest qualification", { options: ["Diploma", "Bachelor's degree", "Master's degree", "PhD"] }), sources).answer).toBe("Master's degree");
    const none = makeSources({ verifiedFacts: [] });
    expect(resolveAnswer(q("Highest qualification"), none).status).toBe("UNKNOWN");
    const answered = makeSources({ verifiedFacts: [], candidateAnswers: [{ id: "ca-edu", questionKey: "highest_education", question: "Highest qualification", answer: "B.E. Mechanical" }] });
    expect(resolveAnswer(q("What is your highest level of education?"), answered)).toMatchObject({ answer: "B.E. Mechanical", source: "CANDIDATE_ANSWER", sourceRef: "ca-edu" });
  });

  it("marks cover letter and resume as not applicable (attached separately)", () => {
    for (const text of ["Cover letter", "Upload your resume"]) {
      const a = resolveAnswer(q(text), sources);
      expect(a).toMatchObject({ status: "NOT_APPLICABLE", answer: null });
      expect(a.reason).toMatch(/attached/);
    }
  });
});

describe("resolveAnswer - sensitive and custom questions", () => {
  it("never infers current salary, even when expected salary is set", () => {
    const a = resolveAnswer(q("What is your current CTC?"), makeSources());
    expect(a).toMatchObject({ status: "UNKNOWN", answer: null, source: "UNKNOWN" });
    expect(a.reason).toMatch(/never from your expected salary/);
  });

  it("never infers work authorisation, sponsorship, start date or diversity answers", () => {
    const sources = makeSources();
    for (const text of ["Are you authorised to work in India?", "Will you require visa sponsorship?", "Earliest start date", "Gender", "How did you hear about this job?"]) {
      expect(resolveAnswer(q(text), sources), text).toMatchObject({ status: "UNKNOWN", answer: null });
    }
  });

  it("uses the user's saved answers by key", () => {
    const sources = makeSources({
      candidateAnswers: [
        { id: "ca-auth", questionKey: "work_authorization:india", question: "Are you authorised to work in India?", answer: "Yes" },
        { id: "ca-ctc", questionKey: "current_salary", question: "Current CTC", answer: "22 LPA" },
      ],
    });
    expect(resolveAnswer(q("Are you legally authorized to work in India?"), sources)).toMatchObject({ answer: "Yes", source: "CANDIDATE_ANSWER", sourceRef: "ca-auth" });
    // India authorisation is not US authorisation.
    expect(resolveAnswer(q("Are you legally authorized to work in the United States?"), sources).status).toBe("UNKNOWN");
    const ctc = resolveAnswer(q("What is your current CTC (in LPA)?"), sources);
    expect(ctc).toMatchObject({ answer: "22 LPA", source: "CANDIDATE_ANSWER", sourceRef: "ca-ctc" });
    expect(ctc.reason).toContain("saved answer");
  });

  it("uses previous answers by key or identical question text and maps questionnaire codes", () => {
    const sources = makeSources({
      previousAnswers: [
        { id: "pa-oncall", question: "Are you comfortable with on-call rotations?", questionKey: "screening_1", answer: "yes_professional" },
        { id: "pa-visa", question: "Do you need visa sponsorship to work in India?", questionKey: "visa_sponsorship:india", answer: "no" },
        { id: "pa-unsure", question: "Why do you want to join us?", questionKey: null, answer: "not_sure" },
      ],
    });
    expect(resolveAnswer(q("Are you comfortable with on-call rotations? (required)"), sources)).toMatchObject({ answer: "Yes", source: "PREVIOUS_ANSWER", sourceRef: "pa-oncall" });
    // An earlier sponsorship answer for India counts for an India job...
    expect(resolveAnswer(q("Will you require visa sponsorship?", { jobCountry: "india" }), sources)).toMatchObject({ answer: "No", source: "PREVIOUS_ANSWER", sourceRef: "pa-visa" });
    // ...never for a job in another country, or one whose country is unknown.
    expect(resolveAnswer(q("Will you require visa sponsorship?", { jobCountry: "uk" }), sources).status).toBe("UNKNOWN");
    expect(resolveAnswer(q("Will you require visa sponsorship?"), sources).status).toBe("UNKNOWN");
    expect(resolveAnswer(q("Why do you want to join us?"), sources).status).toBe("UNKNOWN");
  });

  it("prefers reusable answers over previous answers", () => {
    const sources = makeSources({
      candidateAnswers: [{ id: "ca", questionKey: "earliest_start_date", question: "Earliest start date", answer: "1 November 2026" }],
      previousAnswers: [{ id: "pa", question: "Earliest start date", questionKey: "earliest_start_date", answer: "1 July 2026" }],
    });
    expect(resolveAnswer(q("When can you start?"), sources)).toMatchObject({ answer: "1 November 2026", source: "CANDIDATE_ANSWER" });
  });

  it("reuses an explicit earlier 'No' for a skill (the user said it, nothing is assumed)", () => {
    const sources = makeSources({ previousAnswers: [{ id: "pa-rust", question: "Have you worked with Rust?", questionKey: "skill_rust", answer: "no" }] });
    expect(resolveAnswer(q("Do you have experience with Rust?"), sources)).toMatchObject({ answer: "No", source: "PREVIOUS_ANSWER", sourceRef: "pa-rust" });
  });
});

describe("resolveAnswer - options mapping", () => {
  const sources = makeSources();

  it("maps years onto ranges", () => {
    const opts = ["0-1 years", "1-3 years", "3-5 years", "5+ years"];
    expect(resolveAnswer(q("Total experience (in years)", { options: opts }), sources).answer).toBe("5+ years");
    expect(resolveAnswer(q("How many years of experience do you have with React?", { options: opts }), sources).answer).toBe("3-5 years");
    expect(resolveAnswer(q("How many years of experience do you have with Python?", { options: ["0-2", "3-5", "6+"] }), sources).answer).toBe("0-2");
    const three = makeSources({ profile: { ...sources.profile, yoe: 3 } });
    expect(resolveAnswer(q("Total experience", { options: opts }), three).answer).toBe("3-5 years");
    const mapped = resolveAnswer(q("Total experience", { options: ["Less than 2 years", "2 to 5 years", "More than 5 years"] }), sources);
    expect(mapped).toMatchObject({ answer: "More than 5 years", source: "PROFILE" });
    expect(mapped.reason).toContain('Mapped to the option "More than 5 years"');
  });

  it("maps notice periods onto options", () => {
    expect(resolveAnswer(q("Notice period", { options: ["Immediate", "15 days", "1 month", "2 months", "3 months"] }), sources).answer).toBe("1 month");
    expect(resolveAnswer(q("Notice period", { options: ["Immediately", "Within 30 days", "Within 60 days", "More than 60 days"] }), sources).answer).toBe("Within 30 days");
    expect(resolveAnswer(q("Notice period", { options: ["Immediate", "30 days", "60 days", "90 days"] }), sources).answer).toBe("30 days");
    const immediate = makeSources({ preference: { ...sources.preference, noticePeriod: "Immediate" } });
    expect(resolveAnswer(q("Notice period", { options: ["Immediate joiner", "15 days", "30 days"] }), immediate).answer).toBe("Immediate joiner");
  });

  it("derives yes/no from a threshold in the question", () => {
    expect(resolveAnswer(q("Can you join within 30 days?", { options: ["Yes", "No"] }), sources).answer).toBe("Yes");
    expect(resolveAnswer(q("Are you an immediate joiner?", { options: ["Yes", "No"] }), sources).answer).toBe("No");
    expect(resolveAnswer(q("Are you an immediate joiner?"), sources).answer).toBe("No");
    expect(resolveAnswer(q("Do you have 5+ years of experience?", { options: ["Yes", "No"] }), sources).answer).toBe("Yes");
    expect(resolveAnswer(q("Do you have 5+ years of experience with React?", { inputType: "boolean" }), sources).answer).toBe("No");
  });

  it("maps yes/no synonyms and questionnaire variants", () => {
    expect(resolveAnswer(q("Do you have experience with React?", { options: ["YES", "NO"] }), sources).answer).toBe("YES");
    expect(resolveAnswer(q("Do you have experience with React?", { options: ["Yes, I do", "No, I don't"] }), sources).answer).toBe("Yes, I do");
    // Two "Yes" options and nothing to choose between them -> unknown.
    const ambiguous = resolveAnswer(q("Do you have experience with React?", { options: ["Yes, professionally", "Yes, in personal projects", "No"] }), sources);
    expect(ambiguous.status).toBe("UNKNOWN");
    expect(ambiguous.reason).toContain("does not match the available options");
    const withVariant = makeSources({ previousAnswers: [{ id: "pa", question: "Have you worked with Rust?", questionKey: null, answer: "yes_project" }] });
    expect(resolveAnswer(q("Do you have experience with Rust?", { options: ["Yes, professionally", "Yes, in personal projects", "No"] }), withVariant).answer).toBe("Yes, in personal projects");
  });

  it("maps case-insensitive equal options and salary ranges", () => {
    expect(resolveAnswer(q("Preferred work mode", { options: ["REMOTE", "HYBRID", "ONSITE"] }), sources).answer).toBe("REMOTE");
    expect(resolveAnswer(q("Expected CTC", { options: ["10-20 LPA", "20-40 LPA", "40+ LPA"] }), sources).answer).toBe("20-40 LPA");
    // 28-38 LPA spans two buckets: no single option is right.
    expect(resolveAnswer(q("Expected CTC", { options: ["20-30 LPA", "30-40 LPA"] }), sources).status).toBe("UNKNOWN");
  });

  it("returns UNKNOWN when no source value fits the options", () => {
    const a = resolveAnswer(q("What is your notice period?", { options: ["Serving notice", "Not serving notice"] }), sources);
    expect(a).toMatchObject({ status: "UNKNOWN", answer: null, source: "UNKNOWN" });
    expect(a.reason).toContain("preferences (notice period)");
    expect(a.reason).toContain("does not match the available options");
  });
});

describe("resolveApplicationAnswers", () => {
  it("returns every answer and only required unknowns as pending", () => {
    const questions = collectApplicationQuestions({
      screeningQuestions: ["What is your current CTC? (required)", "Why do you want to join us?", "Do you have experience with Rust?*"],
      providerQuestions: [{ question: "Are you authorised to work in India?", required: true, inputType: "select", options: ["Yes", "No"], providerKey: "auth" }],
    });
    const { answers, pending } = resolveApplicationAnswers(questions, makeSources({ profile: { ...makeSources().profile, phone: null } }));
    expect(answers).toHaveLength(questions.length);
    for (const a of answers) expect(a.reason.length).toBeGreaterThan(0);
    expect(answers.find((a) => a.key === "phone")!.status).toBe("UNKNOWN");
    expect(answers.find((a) => a.key === "resume")!.status).toBe("NOT_APPLICABLE");
    expect(pending.map((p) => p.key)).toEqual(["current_salary", "skill_experience:rust", "work_authorization:india"]);
    expect(pending.find((p) => p.key === "work_authorization:india")).toMatchObject({ canonicalKey: "work_authorization", sensitive: true, required: true, options: ["Yes", "No"] });
    expect(pending.find((p) => p.key === "skill_experience:rust")!.sensitive).toBe(false);
  });

  it("is deterministic", () => {
    const questions = collectApplicationQuestions({ screeningQuestions: ["Expected CTC", "How many years of experience do you have with React?"], providerQuestions: [] });
    const sources = makeSources();
    expect(resolveApplicationAnswers(questions, sources)).toEqual(resolveApplicationAnswers(questions, sources));
  });
});

describe("country-specific answers (work authorisation, sponsorship, relocation)", () => {
  const IN_THIS_COUNTRY = "Are you legally authorized to work in this country?";
  const SPONSORSHIP = "Will you now or in the future require visa sponsorship?";

  it("derives the job's country from its locations (null unless every location is in one known country)", () => {
    for (const locations of [["Bengaluru"], ["Bangalore, Karnataka, India"], ["Remote - India"], ["Mumbai", "Pune"], ["Gurugram", "Noida", "New Delhi"], ["Hyderabad"], ["Chennai"], ["Kolkata"], ["Ahmedabad"], ["India"]]) {
      expect(countryForLocations(locations), locations.join(" | ")).toBe("india");
    }
    expect(countryForLocations(["New York, NY"])).toBe("us");
    expect(countryForLocations(["San Francisco, CA", "Remote - US"])).toBe("us");
    expect(countryForLocations(["Austin, TX"])).toBe("us");
    expect(countryForLocations(["United States"])).toBe("us");
    expect(countryForLocations(["London, UK"])).toBe("uk");
    expect(countryForLocations(["Manchester"])).toBe("uk");
    expect(countryForLocations(["Singapore"])).toBe("singapore");
    expect(countryForLocations(["Berlin, Germany"])).toBe("germany");
    expect(countryForLocations(["München"])).toBe("germany");
    expect(countryForLocations(["Toronto, ON"])).toBe("canada");
    expect(countryForLocations(["London, ON"])).toBe("canada");
    expect(countryForLocations(["Sydney"])).toBe("australia");
    expect(countryForLocations(["Dubai"])).toBe("uae");
    expect(countryForLocations(["Bengaluru, KA, IN"])).toBe("india");
    // Several countries, a global or multi-country remote role, or an unknown place: no single country.
    expect(countryForLocations(["Bengaluru", "New York, NY"])).toBeNull();
    expect(countryForLocations(["Remote - Global"])).toBeNull();
    expect(countryForLocations(["Remote"])).toBeNull();
    expect(countryForLocations(["Remote - Latin America"])).toBeNull();
    expect(countryForLocations(["Bengaluru", "Kathmandu"])).toBeNull();
    expect(countryForLocations([])).toBeNull();
  });

  it("keeps a remote job's other country when the job is parsed (never turned into 'Remote - India')", () => {
    const us = parseJobDescription("Backend Engineer\nWe use Go.", { importMethod: "MANUAL_ENTRY", location: ["Remote - US"] });
    expect(us.location).toEqual(["Remote - US"]);
    expect(countryForLocations(us.location)).toBe("us");
    expect(parseJobDescription("Backend Engineer", { importMethod: "CSV_IMPORT", location: "Remote (UK)" }).location).toEqual(["Remote (UK)"]);
    // India and global remote labels are unchanged.
    expect(parseJobDescription("Backend Engineer", { importMethod: "MANUAL_ENTRY", location: ["Remote - India", "Bangalore"] }).location).toEqual(["Remote - India", "Bengaluru"]);
    expect(parseJobDescription("Backend Engineer", { importMethod: "MANUAL_ENTRY", location: ["Remote - Worldwide"] }).location).toEqual(["Remote - Global"]);
  });

  it("keys a question that names no country to the job's country; a named country always wins", () => {
    expect(questionKeyFor(IN_THIS_COUNTRY)).toBe("work_authorization");
    expect(questionKeyFor(IN_THIS_COUNTRY, { jobCountry: "india" })).toBe("work_authorization:india");
    expect(classifyQuestion(IN_THIS_COUNTRY, { jobCountry: "us" })).toMatchObject({ key: "work_authorization:us", canonicalKey: "work_authorization", sensitive: true });
    expect(classifyQuestion("Do you have the right to work?", { jobCountry: "uk" }).key).toBe("work_authorization:uk");
    expect(classifyQuestion(SPONSORSHIP, { jobCountry: "uk" }).key).toBe("visa_sponsorship:uk");
    expect(classifyQuestion("Are you authorised to work in the UK?", { jobCountry: "india" }).key).toBe("work_authorization:uk");
    // A named city counts as its country.
    expect(questionKeyFor("Are you authorised to work in Bangalore?")).toBe("work_authorization:india");
    // Other keys never take the job's country.
    expect(classifyQuestion("Expected CTC", { jobCountry: "india" }).key).toBe("expected_salary");
    const qs = collectApplicationQuestions({ screeningQuestions: [`${IN_THIS_COUNTRY} (required)`], providerQuestions: [{ question: SPONSORSHIP, required: true, inputType: "select", options: ["Yes", "No"], providerKey: "q1" }], jobCountry: "us" });
    expect(qs.map((x) => x.key)).toEqual(expect.arrayContaining(["work_authorization:us", "visa_sponsorship:us"]));
    expect(requiresApplicationScopedAnswer("work_authorization")).toBe(true);
    expect(requiresApplicationScopedAnswer("visa_sponsorship")).toBe(true);
    expect(requiresApplicationScopedAnswer("work_authorization:india")).toBe(false);
    expect(requiresApplicationScopedAnswer("notice_period")).toBe(false);
  });

  it("never reuses a work-authorisation answer given for a job in another country", () => {
    // Answered "Yes" for a Bengaluru job before answers were country-specific (saved under the bare key).
    const legacy = makeSources({ candidateAnswers: [{ id: "ca-legacy", questionKey: "work_authorization", question: IN_THIS_COUNTRY, answer: "Yes" }] });
    expect(resolveAnswer(q(IN_THIS_COUNTRY, { jobCountry: "us", options: ["Yes", "No"] }), legacy)).toMatchObject({ status: "UNKNOWN", answer: null });
    // Answered for a Bengaluru job (keyed to India): reused for another India job, not for a New York one.
    const india = makeSources({ candidateAnswers: [{ id: "ca-in", questionKey: "work_authorization:india", question: IN_THIS_COUNTRY, answer: "Yes" }] });
    expect(resolveAnswer(q(IN_THIS_COUNTRY, { jobCountry: "india" }), india)).toMatchObject({ status: "RESOLVED", answer: "Yes", source: "CANDIDATE_ANSWER", sourceRef: "ca-in" });
    expect(resolveAnswer(q("Do you have the right to work?", { jobCountry: "india" }), india)).toMatchObject({ answer: "Yes", sourceRef: "ca-in" });
    expect(resolveAnswer(q(IN_THIS_COUNTRY, { jobCountry: "us" }), india).status).toBe("UNKNOWN");
    // "No sponsorship needed" for India is not an answer for a UK role.
    const visa = makeSources({ candidateAnswers: [{ id: "ca-visa", questionKey: "visa_sponsorship:india", question: SPONSORSHIP, answer: "No" }] });
    expect(resolveAnswer(q(SPONSORSHIP, { jobCountry: "uk", options: ["Yes", "No"] }), visa).status).toBe("UNKNOWN");
    expect(resolveAnswer(q(SPONSORSHIP, { jobCountry: "india" }), visa)).toMatchObject({ answer: "No", sourceRef: "ca-visa" });
  });

  it("uses only this application's own answers when the job's country is unknown", () => {
    const reusable = makeSources({
      candidateAnswers: [
        { id: "ca-auth", questionKey: "work_authorization", question: IN_THIS_COUNTRY, answer: "Yes" },
        { id: "ca-visa", questionKey: "visa_sponsorship", question: SPONSORSHIP, answer: "No" },
      ],
      previousAnswers: [{ id: "pa-auth", question: IN_THIS_COUNTRY, questionKey: "work_authorization", answer: "yes" }],
    });
    const auth = resolveAnswer(q(IN_THIS_COUNTRY), reusable);
    expect(auth).toMatchObject({ status: "UNKNOWN", answer: null, source: "UNKNOWN" });
    expect(auth.reason).toMatch(/country/);
    expect(resolveAnswer(q(SPONSORSHIP), reusable).status).toBe("UNKNOWN");
    const pending = resolveApplicationAnswers([q(IN_THIS_COUNTRY), q(SPONSORSHIP)], reusable).pending;
    expect(pending.map((p) => p.key)).toEqual(["work_authorization", "visa_sponsorship"]);

    // Answers the user gave for this application (flagged, or still carrying the "app:<id>:" prefix) are used.
    const scoped = makeSources({
      candidateAnswers: [
        { id: "ca-scoped", questionKey: "work_authorization", question: IN_THIS_COUNTRY, answer: "Yes", applicationScoped: true },
        { id: "ca-prefixed", questionKey: "app:app123:visa_sponsorship", question: SPONSORSHIP, answer: "No" },
      ],
    });
    expect(resolveAnswer(q(IN_THIS_COUNTRY), scoped)).toMatchObject({ status: "RESOLVED", answer: "Yes", sourceRef: "ca-scoped" });
    expect(resolveAnswer(q(SPONSORSHIP), scoped)).toMatchObject({ status: "RESOLVED", answer: "No", sourceRef: "ca-prefixed" });
    // The same application's answer to the same question still counts once the job's country is known...
    expect(resolveAnswer(q(IN_THIS_COUNTRY, { jobCountry: "india" }), scoped)).toMatchObject({ status: "RESOLVED", answer: "Yes", sourceRef: "ca-scoped" });
    // ...but never for a question about another named country, or when the answer is not scoped to this application.
    expect(resolveAnswer(q("Are you authorised to work in the UK?"), scoped).status).toBe("UNKNOWN");
    const unscoped = makeSources({ candidateAnswers: [{ id: "ca-other-job", questionKey: "work_authorization", question: IN_THIS_COUNTRY, answer: "Yes" }] });
    expect(resolveAnswer(q(IN_THIS_COUNTRY, { jobCountry: "india" }), unscoped).status).toBe("UNKNOWN");
  });

  it("keys relocation questions by the place they name, so an answer for Pune is not an answer for London", () => {
    expect(questionKeyFor("Are you willing to relocate to Pune?")).toBe("willing_to_relocate:pune");
    expect(questionKeyFor("Are you willing to relocate to Bangalore?")).toBe("willing_to_relocate:bengaluru");
    expect(questionKeyFor("Would you relocate to London?")).toBe("willing_to_relocate:london");
    expect(questionKeyFor("Are you willing to relocate to the UK?")).toBe("willing_to_relocate:uk");
    expect(questionKeyFor("Are you open to relocation?")).toBe("willing_to_relocate");
    expect(questionKeyFor("Are you willing to relocate if required?")).toBe("willing_to_relocate");
    const sources = makeSources({ candidateAnswers: [{ id: "ca-pune", questionKey: "willing_to_relocate", question: "Are you willing to relocate to Pune?", answer: "Yes" }] });
    expect(resolveAnswer(q("Would you relocate to Pune?"), sources)).toMatchObject({ answer: "Yes", sourceRef: "ca-pune" });
    expect(resolveAnswer(q("Would you relocate to London?"), sources).status).toBe("UNKNOWN");
    expect(resolveAnswer(q("Are you open to relocation?"), sources).status).toBe("UNKNOWN");
  });
});
