import { describe, expect, it } from "vitest";
import {
  applicationContactEmail,
  applicationContactEmails,
  CONNECTORS,
  emailApplicationRequested,
  isNonApplicationAddress,
  parseJobDescription,
  parseJobEmail,
} from "../src";

const FRAUD_POSTING = [
  "Backend Engineer at Northwind",
  "We build payment APIs with Node.js and PostgreSQL.",
  "Requirements",
  "- 3+ years of Node.js",
  "Report recruitment fraud to trust@example-agency.test",
].join("\n");

describe("applicationContactEmail", () => {
  it("never falls back to the first address in the text", () => {
    expect(applicationContactEmail(FRAUD_POSTING)).toBeNull();
    expect(applicationContactEmail("Questions about the product? Write to info@northwind.test.")).toBeNull();
    expect(applicationContactEmail("Contact: people@northwind.test")).toBeNull();
  });

  it("finds an address in an application-request sentence or the apply section", () => {
    expect(applicationContactEmail("To apply, email your resume to hiring@northwind.test")).toBe("hiring@northwind.test");
    expect(applicationContactEmail("Send CV to jobs@northwind.test.")).toBe("jobs@northwind.test");
    expect(applicationContactEmail("Please share your updated profile at Talent@Northwind.test")).toBe("talent@northwind.test");
    expect(applicationContactEmail("Apply by email: careers@northwind.test")).toBe("careers@northwind.test");
    expect(applicationContactEmail("Interested candidates can write to hr@northwind.test")).toBe("hr@northwind.test");
    expect(applicationContactEmail("Resumes to recruit@northwind.test")).toBe("recruit@northwind.test");
    // The "How to apply" section counts as a whole.
    expect(applicationContactEmail("Some text", ["hiring@northwind.test"])).toBe("hiring@northwind.test");
    // Apply-section addresses win over request sentences elsewhere.
    expect(applicationContactEmails("Send your CV to a@northwind.test", "b@northwind.test")).toEqual(["b@northwind.test", "a@northwind.test"]);
  });

  it("rejects automated senders and non-recruiting contacts, even in an application context", () => {
    for (const address of ["noreply@northwind.test", "jobalerts-noreply@linkedin.com", "alerts@agency.test", "notifications@ats.test", "fraud@northwind.test", "abuse@northwind.test", "privacy@northwind.test", "security@northwind.test", "support@northwind.test", "accessibility@northwind.test", "accommodations@northwind.test"]) {
      expect(isNonApplicationAddress(address), address).toBe(true);
      expect(applicationContactEmail(`Send your resume to ${address}`), address).toBeNull();
    }
    expect(isNonApplicationAddress("hiring@northwind.test")).toBe(false);
    // Fraud / accessibility sentences inside the apply section are not the application address.
    expect(applicationContactEmail("", ["Send your CV to hiring@northwind.test.", "Report suspicious messages to trust@northwind.test."])).toBe("hiring@northwind.test");
    expect(applicationContactEmails("", ["For accommodation requests, email help@northwind.test."])).toEqual([]);
    // "Send your CV to ... Report fraud to ..." on one line: the sentences are judged separately.
    expect(applicationContactEmails("Send your CV to hiring@northwind.test. Report fraud to trust@example-agency.test.")).toEqual(["hiring@northwind.test"]);
  });
});

describe("emailApplicationRequested", () => {
  const posting = "Frontend Engineer\nRequirements\n- React\n\nHow to apply\nEmail your resume to hiring@northwind.test.\n\nReport recruitment fraud to trust@example-agency.test";

  it("is true only when the posting asks for applications to that address", () => {
    expect(emailApplicationRequested(posting, null, "hiring@northwind.test")).toBe(true);
    expect(emailApplicationRequested(posting, null, "HIRING@northwind.test ")).toBe(true);
    expect(emailApplicationRequested(posting, null, "trust@example-agency.test")).toBe(false);
    expect(emailApplicationRequested(FRAUD_POSTING, null, "trust@example-agency.test")).toBe(false);
    expect(emailApplicationRequested(posting, null, "attacker@evil.test")).toBe(false);
    expect(emailApplicationRequested(posting, null, "")).toBe(false);
    expect(emailApplicationRequested(posting, null, "not-an-address")).toBe(false);
    expect(emailApplicationRequested("Send your CV to noreply@northwind.test", null, "noreply@northwind.test")).toBe(false);
  });

  it("uses the application instructions only when they are part of the posting", () => {
    const bare = "Frontend Engineer\nHow to apply\nhiring@northwind.test\n\nReport fraud to trust@example-agency.test";
    // The parsed "How to apply" section (a bare address) is in the posting: it counts.
    expect(emailApplicationRequested(bare, "hiring@northwind.test", "hiring@northwind.test")).toBe(true);
    expect(emailApplicationRequested(bare, null, "hiring@northwind.test")).toBe(false);
    // Instructions that are not in the posting (a model's paraphrase) never count on their own.
    expect(emailApplicationRequested(FRAUD_POSTING, "Email your resume to trust@example-agency.test", "trust@example-agency.test")).toBe(false);
    expect(emailApplicationRequested(bare, "Email your resume to trust@example-agency.test", "trust@example-agency.test")).toBe(false);
  });

  it("agrees with the parser for jobs it parsed", () => {
    const job = parseJobDescription(posting, { importMethod: "MANUAL_ENTRY" });
    expect(job.hrEmail).toBe("hiring@northwind.test");
    expect(emailApplicationRequested(job.description, job.applicationInstructions, job.hrEmail!)).toBe(true);
  });
});

describe("job description parser - HR email", () => {
  it("does not treat a fraud-report or other stray address as the HR email", () => {
    const job = parseJobDescription(FRAUD_POSTING, { importMethod: "MANUAL_ENTRY" });
    expect(job.hrEmail).toBeNull();
    expect(job.applyMethod).toBe("MANUAL");
    const footer = parseJobDescription("Data Analyst\nWe love data.\nPress: media@northwind.test\nPrivacy questions: dpo@northwind.test", { importMethod: "MANUAL_ENTRY" });
    expect(footer.hrEmail).toBeNull();
    expect(footer.applyMethod).toBe("MANUAL");
  });

  it("takes the address from the apply section or an application sentence", () => {
    const section = parseJobDescription("Data Analyst\nWe love data.\nHow to apply\nhiring@northwind.test\nAbout us\nWrite to info@northwind.test", { importMethod: "MANUAL_ENTRY" });
    expect(section.hrEmail).toBe("hiring@northwind.test");
    expect(section.applyMethod).toBe("EMAIL");
    const sentence = parseJobDescription("Data Analyst\nPress: media@northwind.test\nInterested candidates can send their CV to talent@northwind.test", { importMethod: "MANUAL_ENTRY" });
    expect(sentence.hrEmail).toBe("talent@northwind.test");
    // Explicit hints still win.
    expect(parseJobDescription(FRAUD_POSTING, { importMethod: "CSV_IMPORT", hrEmail: "jobs@northwind.test" }).hrEmail).toBe("jobs@northwind.test");
  });
});

describe("forwarded email connector - contact email", () => {
  it("ignores a bare 'Email:' line and HR-looking addresses outside an application context", async () => {
    const raw = [
      "Subject: Hiring: Data Engineer | Northwind | Pune",
      "From: Northwind <careers@northwind.test>",
      "",
      "Northwind is hiring a Data Engineer to build our Spark pipelines.",
      "Email: hr-desk@northwind.test",
      "Report fraud to fraud-team@northwind.test",
    ].join("\n");
    const parsed = await parseJobEmail(raw);
    expect(parsed.contactEmail).toBeNull();
    const [job] = await CONNECTORS.email.importJobs({ payload: { raw } });
    expect((await CONNECTORS.email.normalize(job!)).hrEmail).toBeNull();
  });

  it("keeps a labelled HR email and an application request, but never a non-recruiting address", async () => {
    expect((await parseJobEmail("Subject: Data Engineer\n\nWe are hiring a Data Engineer.\nHR email: talent@northwind.test")).contactEmail).toBe("talent@northwind.test");
    expect((await parseJobEmail("Subject: Data Engineer\n\nWe are hiring a Data Engineer.\nPlease send your resume to jobs@northwind.test")).contactEmail).toBe("jobs@northwind.test");
    expect((await parseJobEmail("Subject: Data Engineer\n\nWe are hiring a Data Engineer.\nContact email: support@northwind.test")).contactEmail).toBeNull();
  });
});
