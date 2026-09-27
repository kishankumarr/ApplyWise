import { describe, expect, it } from "vitest";
import type { StatusEmailApplicationRef, StatusEmailInput } from "@applywise/types";
import {
  associateStatusEmail,
  classifyStatusEmail,
  cleanStatusEmailSubject,
  STATUS_EMAIL_MIN_CONFIDENCE,
  statusEmailPlainText,
  statusEmailSenderDomain,
  statusForMessageCategory,
  unwrapForwardedStatusEmail,
} from "../src/automation/email-status";

const mail = (subject: string, text: string, from = "Talent Team <talent@acme-test.com>", receivedAt = "2026-09-25T10:00:00Z"): StatusEmailInput => ({
  from,
  subject,
  text,
  receivedAt,
});

const ref = (id: string, company: string, title: string, companyWebsite: string | null = null, sentAt: string | null = "2026-09-20T10:00:00Z"): StatusEmailApplicationRef => ({
  applicationId: id,
  company,
  title,
  companyWebsite,
  sentAt,
});

describe("classifyStatusEmail: categories", () => {
  it("detects an application confirmation", () => {
    const c = classifyStatusEmail(
      mail(
        "Thank you for applying to Acme Test",
        "Hi Asha,\n\nWe have received your application for the Frontend Engineer role. Our team will carefully review your application.\nIf your profile matches, we will contact you to schedule an interview.\n\nAcme Test Recruiting",
      ),
    );
    expect(c.category).toBe("APPLICATION_CONFIRMATION");
    expect(c.confidence).toBeGreaterThanOrEqual(STATUS_EMAIL_MIN_CONFIDENCE);
    expect(c.signals).toContain("thank you for applying (subject)");
    expect(c.fromDomain).toBe("acme-test.com");
    expect(c.companyHint).toBe("Acme Test");
  });

  it("detects an assessment invitation (HackerRank, take-home, online test)", () => {
    const c = classifyStatusEmail(
      mail("Next step: online assessment for Frontend Engineer", "Thanks for applying! As a next step please complete the HackerRank coding test within 5 days. The link expires on Friday."),
    );
    expect(c.category).toBe("ASSESSMENT");
    expect(c.confidence).toBeGreaterThanOrEqual(0.8);
    expect(c.titleHint).toBe("Frontend Engineer");

    expect(classifyStatusEmail(mail("Take-home assignment", "Please find the take-home exercise attached. Submit it within 3 days.")).category).toBe("ASSESSMENT");
  });

  it("detects an interview invitation", () => {
    const c = classifyStatusEmail(
      mail(
        "Interview invitation: Frontend Engineer at Acme Test",
        "Hi Asha, we reviewed your profile and would like to invite you to a technical interview. Please share your availability for a call this week. Let us know if Tuesday works.",
      ),
    );
    expect(c.category).toBe("INTERVIEW");
    expect(c.confidence).toBeGreaterThanOrEqual(0.9);
    expect(c.titleHint).toBe("Frontend Engineer");
    expect(c.companyHint).toBe("Acme Test");
    expect(classifyStatusEmail(mail("Quick chat?", "Could we schedule a call to meet the team next week?")).category).toBe("INTERVIEW");
  });

  it("detects a rejection", () => {
    const c = classifyStatusEmail(
      mail(
        "Your application to Acme Test",
        "Thank you for your interest in Acme Test. Unfortunately, we have decided to move forward with other candidates whose experience more closely matches our needs. We will keep your resume on file for future opportunities.",
      ),
    );
    expect(c.category).toBe("REJECTION");
    expect(c.confidence).toBeGreaterThanOrEqual(0.9);
    expect(classifyStatusEmail(mail("Update", "We regret to inform you that the position has been filled.")).category).toBe("REJECTION");
    expect(classifyStatusEmail(mail("Update", "After careful consideration we will not be proceeding with your application.")).category).toBe("REJECTION");
  });

  it("detects an offer", () => {
    const c = classifyStatusEmail(mail("Offer letter - Frontend Engineer", "We are pleased to offer you the position of Frontend Engineer. Please find the offer letter attached."));
    expect(c.category).toBe("OFFER");
    expect(c.confidence).toBeGreaterThanOrEqual(0.9);
    expect(classifyStatusEmail(mail("Great news", "We would like to extend an offer to you for the role.")).category).toBe("OFFER");
  });

  it("detects a recruiter response that is none of the above", () => {
    const c = classifyStatusEmail(mail("Regarding your profile", "Hi Asha, I came across your profile and would like to discuss a role with you. Are you open to a conversation?"));
    expect(c.category).toBe("RECRUITER_RESPONSE");
    expect(c.confidence).toBeGreaterThanOrEqual(STATUS_EMAIL_MIN_CONFIDENCE);
  });

  it("returns OTHER without signals", () => {
    const c = classifyStatusEmail(mail("Our newsletter", "Read about our latest product launch and the new office."));
    expect(c).toMatchObject({ category: "OTHER", confidence: 0, signals: [] });
  });
});

describe("classifyStatusEmail: conflicting phrases", () => {
  it("a rejection beats the interview it mentions", () => {
    const c = classifyStatusEmail(
      mail("Interview feedback - Frontend Engineer", "Thank you for taking the time to interview with us. Unfortunately, after the final interview we have decided not to move forward."),
    );
    expect(c.category).toBe("REJECTION");
    expect(c.signals.some((s) => s.startsWith("overrides interview"))).toBe(true);
  });

  it("an offer beats the interview it follows", () => {
    const c = classifyStatusEmail(mail("Following your interview", "Congratulations! Following your final interview, we are delighted to extend an offer. The offer letter is attached."));
    expect(c.category).toBe("OFFER");
  });

  it("a rejection beats an offer mentioned in the negative", () => {
    expect(classifyStatusEmail(mail("Update on your application", "We are unable to extend an offer at this time. We wish you the best.")).category).toBe("REJECTION");
  });

  it("a weak 'unfortunately' does not turn an interview reschedule into a rejection", () => {
    const c = classifyStatusEmail(mail("Interview reschedule", "Unfortunately the interviewer is unavailable, so we need to reschedule your interview to Friday."));
    expect(c.category).toBe("INTERVIEW");
  });

  it("conditional mentions of a later step do not outweigh a confirmation", () => {
    const c = classifyStatusEmail(
      mail("Application received", "Thank you for applying. If you are shortlisted, our recruiters may contact you to schedule an interview. Our process typically includes an online assessment."),
    );
    expect(c.category).toBe("APPLICATION_CONFIRMATION");
    expect(c.signals.some((s) => s.includes("(subject)"))).toBe(true);
  });

  it("an 'interview' mention alone stays below the confidence threshold", () => {
    const c = classifyStatusEmail(mail("Hello", "We are updating our interview process and will share more details soon."));
    expect(c.category).toBe("INTERVIEW");
    expect(c.confidence).toBeLessThan(STATUS_EMAIL_MIN_CONFIDENCE);
  });

  it("ignores quoted reply history", () => {
    const c = classifyStatusEmail(mail("Re: Frontend Engineer", "Thanks, noted.\n\nOn Mon, 21 Sep 2026 at 10:00, Asha wrote:\n> Unfortunately I cannot make the interview.\n> I regret to inform you"));
    expect(c.category).toBe("OTHER");
  });

  it("is deterministic", () => {
    const m = mail("Interview invitation", "We would like to invite you to an interview.");
    expect(classifyStatusEmail(m)).toEqual(classifyStatusEmail(m));
  });
});

describe("classifyStatusEmail: India-style recruiter mails", () => {
  it("a consultant's requirement mail is a recruiter response", () => {
    const c = classifyStatusEmail(
      mail(
        "Urgent requirement - Java Developer - Bangalore",
        "Dear Candidate,\nGreetings from TalentCorp Consulting!\nYour profile has been shortlisted for our client's requirement for Java Developer.\nPlease share your updated CV along with current CTC, expected CTC and notice period.\nKindly revert at the earliest.",
        "HR <hr@talentcorp-consulting.in>",
      ),
    );
    expect(c.category).toBe("RECRUITER_RESPONSE");
    expect(c.companyHint).toBe("TalentCorp Consulting");
  });

  it("shortlisting for a technical round is an interview", () => {
    const c = classifyStatusEmail(
      mail(
        "Interview scheduled - Technical round | Infotech Solutions",
        "Dear Asha,\nCongratulations! Your profile has been shortlisted for the technical round of interview scheduled on 12th Oct at 11 AM (Google Meet link below). Kindly confirm your availability.",
      ),
    );
    expect(c.category).toBe("INTERVIEW");
    expect(c.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("an online test on Mettl / AMCAT is an assessment", () => {
    const c = classifyStatusEmail(mail("Online Test Invitation", "Dear Candidate, you have been shortlisted for the online test. Please take the Mettl aptitude test using the link below."));
    expect(c.category).toBe("ASSESSMENT");
  });

  it("'not been shortlisted' is a rejection, not an interview", () => {
    const c = classifyStatusEmail(mail("Application status", "Dear Candidate, we regret to inform you that your profile has not been shortlisted for the next round."));
    expect(c.category).toBe("REJECTION");
  });

  it("an offer with CTC break-up is an offer", () => {
    const c = classifyStatusEmail(mail("Offer Letter - Software Engineer", "Please find attached your offer letter with the CTC break-up. Your date of joining is 1st Nov."));
    expect(c.category).toBe("OFFER");
  });
});

describe("helpers", () => {
  it("reads the sender domain, cleans subjects and falls back to HTML text", () => {
    expect(statusEmailSenderDomain("Acme Talent <talent@careers.acme.com>")).toBe("careers.acme.com");
    expect(statusEmailSenderDomain("not an address")).toBeNull();
    expect(cleanStatusEmailSubject("Re: Fwd: RE:  Interview  invitation")).toBe("Interview invitation");
    expect(statusEmailPlainText(null, "<p>We would like to <b>invite you</b> to an interview.</p>")).toContain("invite you to an interview");
    expect(statusEmailPlainText("plain", "<p>html</p>")).toBe("plain");
  });

  it("extracts company and title hints", () => {
    expect(classifyStatusEmail(mail("Application received - Globex Systems", "Thank you."))).toMatchObject({ companyHint: "Globex Systems" });
    expect(classifyStatusEmail(mail("Your application for Senior Data Analyst at Globex", "Thanks for applying."))).toMatchObject({
      titleHint: "Senior Data Analyst",
      companyHint: "Globex",
    });
    expect(classifyStatusEmail(mail("Update", "Thank you for your interest in the Platform Engineer role at Initech."))).toMatchObject({
      titleHint: "Platform Engineer",
      companyHint: "Initech",
    });
  });

  it("unwraps a hand-forwarded email to the employer's original message", () => {
    const fwd = unwrapForwardedStatusEmail({
      from: "asha@example.test",
      subject: "Fwd: Interview invitation - Frontend Engineer",
      text: [
        "FYI",
        "",
        "---------- Forwarded message ---------",
        "From: Acme Talent <talent@acme-test.com>",
        "Date: Mon, 21 Sep 2026 at 10:00",
        "Subject: Interview invitation - Frontend Engineer",
        "To: <asha@example.test>",
        "",
        "We would like to invite you to an interview.",
      ].join("\n"),
      receivedAt: "2026-09-25T10:00:00Z",
    });
    expect(fwd).toEqual({ from: "Acme Talent <talent@acme-test.com>", subject: "Interview invitation - Frontend Engineer", text: "We would like to invite you to an interview.", receivedAt: "2026-09-25T10:00:00Z" });

    const outlook = unwrapForwardedStatusEmail({
      from: "asha@example.test",
      subject: "FW: Your application",
      text: "________________________________\nFrom: Acme <no-reply@acme-test.com>\nSent: Monday, September 21, 2026 10:00 AM\nTo: Asha\nSubject: Your application\n\nUnfortunately we will not be moving forward.",
      receivedAt: "2026-09-25T10:00:00Z",
    });
    expect(outlook.from).toBe("Acme <no-reply@acme-test.com>");
    expect(outlook.text).toBe("Unfortunately we will not be moving forward.");

    const direct = mail("Interview invitation", "Hello");
    expect(unwrapForwardedStatusEmail(direct)).toBe(direct);
  });

  it("treats an Outlook reply as a reply: the candidate's quoted message is neither unwrapped nor classified", () => {
    const reply = mail(
      "RE: Application for Frontend Engineer",
      "Hi Asha, thanks for your note. Please find the offer letter attached.\n\n________________________________\nFrom: Asha <asha@example.test>\nSent: Monday, September 21, 2026 10:00 AM\nSubject: Application for Frontend Engineer\n\nUnfortunately I have another interview that day and regret to inform you I cannot join.",
    );
    expect(unwrapForwardedStatusEmail(reply)).toBe(reply);
    const c = classifyStatusEmail(reply);
    expect(c.category).toBe("OFFER");
    expect(c.signals.join(" ")).not.toMatch(/regret|overrides/);
  });

  it("maps categories to statuses", () => {
    expect(statusForMessageCategory("ASSESSMENT")).toBe("ASSESSMENT");
    expect(statusForMessageCategory("INTERVIEW")).toBe("INTERVIEW");
    expect(statusForMessageCategory("REJECTION")).toBe("REJECTED");
    expect(statusForMessageCategory("OFFER")).toBe("OFFER");
    expect(statusForMessageCategory("APPLICATION_CONFIRMATION")).toBeNull();
    expect(statusForMessageCategory("RECRUITER_RESPONSE")).toBeNull();
    expect(statusForMessageCategory("OTHER")).toBeNull();
  });
});

describe("associateStatusEmail", () => {
  const apps = [
    ref("app-acme-fe", "Acme Test Pvt Ltd", "Frontend Engineer", "https://www.acme-test.com"),
    ref("app-acme-be", "Acme Test Pvt Ltd", "Backend Engineer", "https://www.acme-test.com"),
    ref("app-globex", "Globex Systems", "Data Analyst"),
    ref("app-initech", "Initech", "Frontend Engineer"),
  ];

  const assoc = (m: StatusEmailInput, list = apps) => associateStatusEmail(classifyStatusEmail(m), m, list);

  it("links by sender domain + title", () => {
    const m = mail("Interview invitation - Frontend Engineer", "We would like to invite you to an interview.", "Acme Talent <talent@careers.acme-test.com>");
    const a = assoc(m);
    expect(a.applicationId).toBe("app-acme-fe");
    expect(a.confidence).toBeGreaterThanOrEqual(STATUS_EMAIL_MIN_CONFIDENCE);
    expect(a.associatedBy).toContain("domain");
    expect(a.associatedBy).toContain("title");
  });

  it("links by company name in the domain when the job has no website", () => {
    const m = mail("Your interview", "We would like to schedule an interview with you.", "recruiting@globexsystems.com");
    const a = assoc(m);
    expect(a.applicationId).toBe("app-globex");
    expect(a.associatedBy).toContain("domain");

    // Only part of a domain label ("globexsystemsjobs") is weaker: it needs another signal.
    const partial = mail("Your interview", "We would like to schedule an interview with you.", "recruiting@globexsystemsjobs.com");
    expect(assoc(partial).applicationId).toBeNull();
    const named = mail("Your interview", "Globex Systems would like to schedule an interview with you.", "recruiting@globexsystemsjobs.com");
    expect(assoc(named)).toMatchObject({ applicationId: "app-globex", associatedBy: "domain~+company" });
  });

  it("links by company + title from an ATS sender", () => {
    const m = mail("Globex Systems - Data Analyst application update", "Unfortunately we will not be moving forward.", "no-reply@greenhouse.io");
    const a = assoc(m);
    expect(a).toMatchObject({ applicationId: "app-globex", associatedBy: "company+title" });
  });

  it("uses the mailbox name of an ATS sender (acme@myworkday.com)", () => {
    const m = mail("Data Analyst", "Thank you for applying.", "globexsystems@myworkday.com");
    expect(assoc(m).applicationId).toBe("app-globex");
  });

  it("returns null when two applications fit equally (same company, no title)", () => {
    const m = mail("Your application at Acme Test", "We would like to invite you to an interview.", "talent@acme-test.com");
    const a = assoc(m);
    expect(a.applicationId).toBeNull();
    expect(a.associatedBy).toBeNull();
  });

  it("returns null when only the job title matches (below the threshold)", () => {
    const m = mail("Frontend Engineer interview", "We would like to invite you to an interview.", "someone@gmail.com");
    const a = assoc(m, [apps[3]!]);
    expect(a.applicationId).toBeNull();
    expect(a.confidence).toBeLessThan(STATUS_EMAIL_MIN_CONFIDENCE);
  });

  it("ignores applications sent after the email was received", () => {
    const m = mail("Globex Systems - Data Analyst", "Unfortunately we will not be moving forward.", "no-reply@greenhouse.io", "2026-09-01T10:00:00Z");
    expect(assoc(m).applicationId).toBeNull();
  });

  it("never links through a shared mail or job-board domain", () => {
    const m = mail("Update", "We would like to invite you to an interview.", "acme@gmail.com");
    expect(assoc(m, [ref("x", "Gmail", "Engineer")]).applicationId).toBeNull();
  });

  it("returns null without applications", () => {
    expect(assoc(mail("Interview", "Interview"), [])).toEqual({ applicationId: null, confidence: 0, associatedBy: null });
  });
});
