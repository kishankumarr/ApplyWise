import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { ANSWER_MATCH_MIN, defaultSelected, matchAnswers, proposeMappings, scoreQuestion } from "../src/lib/form-match";
import { applicationPageUrl, handoffForTab, handoffHint, handoffStatusLabel, onApplySite, prefillMismatch, safeApplyUrl } from "../src/lib/handoff";
import { applyFills, collectFormFields } from "../src/lib/injected";
import type { FieldDescriptor, HandoffItem, PrefillPayload } from "../src/lib/types";

const item = (id: string, applyUrl: string | null, extra: Partial<HandoffItem> = {}): HandoffItem => ({
  applicationId: id,
  status: "MANUAL_ACTION_REQUIRED",
  job: { title: `Role ${id}`, company: `Company ${id}`, applyUrl },
  reason: "CAPTCHA",
  reasonLabel: "The application page shows a CAPTCHA",
  reasonDetail: null,
  updatedAt: "2026-09-27T10:00:00.000Z",
  ...extra,
});

describe("manual handoff helpers", () => {
  it("opens only http(s) apply URLs", () => {
    expect(safeApplyUrl("https://boards.greenhouse.io/acme/jobs/1")).toBe("https://boards.greenhouse.io/acme/jobs/1");
    expect(safeApplyUrl("http://localhost:3000/demo/ats/lever/x")).toBe("http://localhost:3000/demo/ats/lever/x");
    for (const bad of ["javascript:alert(1)", "data:text/html,<b>x</b>", "file:///C:/secret.pdf", "chrome-extension://abc/popup.html", "not a url", "", null, undefined]) {
      expect(safeApplyUrl(bad), String(bad)).toBeNull();
    }
  });

  it("recognises the handoff whose apply page is open in the current tab", () => {
    const items = [
      item("gh1", "https://boards.greenhouse.io/acme/jobs/1"),
      item("gh2", "https://boards.greenhouse.io/acme/jobs/2"),
      item("lever", "https://jobs.lever.co/beta/abc"),
      item("none", null),
      item("evil", "javascript:alert(1)"),
    ];
    expect(handoffForTab(items, "https://boards.greenhouse.io/acme/jobs/2?gh_src=x")?.applicationId).toBe("gh2");
    expect(handoffForTab(items, "https://boards.greenhouse.io/acme/jobs/1/apply")?.applicationId).toBe("gh1");
    // Same host, different job path, several candidates -> ambiguous.
    expect(handoffForTab(items, "https://boards.greenhouse.io/acme/jobs/3")).toBeNull();
    // Only one handoff on that host (e.g. after a redirect inside the ATS) -> that one.
    expect(handoffForTab(items, "https://www.jobs.lever.co/beta/abc/apply")?.applicationId).toBe("lever");
    expect(handoffForTab(items, "https://jobs.lever.co/other")?.applicationId).toBe("lever");
    // "/jobs/1" must not match "/jobs/10".
    expect(handoffForTab([item("a", "https://x.test/jobs/1"), item("b", "https://x.test/jobs/2")], "https://x.test/jobs/10")).toBeNull();
    expect(handoffForTab(items, "https://example.test/")).toBeNull();
    expect(handoffForTab(items, "chrome://extensions")).toBeNull();
    expect(handoffForTab(items, null)).toBeNull();
  });

  it("compares sites, labels statuses and warns about uncertain submissions", () => {
    expect(onApplySite("https://www.acme.test/careers/1", "https://acme.test/careers/1/apply")).toBe(true);
    expect(onApplySite("https://acme.test/careers/1", "https://evil.test/careers/1")).toBe(false);
    expect(onApplySite(null, "https://acme.test/")).toBe(false);
    expect(handoffStatusLabel("MANUAL_ACTION_REQUIRED")).toBe("Needs you");
    expect(handoffStatusLabel("OPENED_APPLY_PAGE")).toBe("Apply page opened");
    expect(handoffHint({ reason: "SUBMISSION_UNCERTAIN", status: "MANUAL_ACTION_REQUIRED" })).toMatchObject({ tone: "warn", text: expect.stringMatching(/do not apply twice/) });
    expect(handoffHint({ reason: "CAPTCHA", status: "MANUAL_ACTION_REQUIRED" })?.text).toMatch(/never solves or bypasses/);
    expect(handoffHint({ reason: null, status: "APPROVED" })).toBeNull();
    expect(applicationPageUrl("http://localhost:3000/", "app 1")).toBe("http://localhost:3000/applications/app%201");
  });

  it("rejects a prefill code for a different application than the selected handoff", () => {
    const selected = item("a1", "https://acme.test/jobs/1");
    const payload = { applicationId: "a2", job: { title: "Other", company: "Else", applyUrl: null } };
    expect(prefillMismatch(payload, selected)).toMatch(/not "Role a1"/);
    expect(prefillMismatch({ ...payload, applicationId: "a1" }, selected)).toBeNull();
    expect(prefillMismatch(payload, null)).toBeNull();
  });
});

const field = (index: number, label: string, extra: Partial<FieldDescriptor> = {}): FieldDescriptor => ({
  index,
  tag: "input",
  type: "text",
  name: "",
  id: "",
  placeholder: "",
  label,
  ariaLabel: "",
  autocomplete: "",
  automationId: "",
  ...extra,
});

describe("screening-answer matching", () => {
  it("scores field labels against questions", () => {
    expect(scoreQuestion(field(0, "What is your notice period? *"), "What is your notice period?")).toBe(1);
    expect(scoreQuestion(field(0, "Notice period"), "What is your notice period?")).toBeGreaterThanOrEqual(0.9);
    expect(scoreQuestion(field(0, "Visa sponsorship"), "Do you need visa sponsorship?")).toBeGreaterThanOrEqual(ANSWER_MATCH_MIN);
    expect(scoreQuestion(field(0, "Phone"), "What is your notice period?")).toBe(0);
    expect(scoreQuestion(field(0, ""), "What is your notice period?")).toBe(0);
  });

  it("proposes each answer for at most one fillable field and never for file/password/checkbox inputs", () => {
    const fields = [
      field(0, "Notice period", { type: "file" }),
      field(1, "Notice period", { type: "password" }),
      field(2, "Notice period", { type: "checkbox" }),
      field(3, "Notice period"),
      field(4, "Notice period (days)"),
      field(5, "Do you need visa sponsorship?", { tag: "select", type: "select" }),
    ];
    const m = matchAnswers(fields, [
      { question: "What is your notice period?", answer: "30 days", reviewed: true },
      { question: "Do you need visa sponsorship?", answer: "No", reviewed: false },
      { question: "Salary expectations?", answer: "" },
    ]);
    expect(m.map((x) => [x.fieldIndex, x.key, x.value])).toEqual([
      [3, "answer:0", "30 days"],
      [5, "answer:1", "No"],
    ]);
    expect(m[0]).toMatchObject({ confidence: "high" });
    expect(m[0]!.needsReview).toBeUndefined();
    expect(m[1]).toMatchObject({ confidence: "high", needsReview: true });
    expect(defaultSelected(m[0]!)).toBe(true);
    // Not reviewed in ApplyWise yet -> starts unselected.
    expect(defaultSelected(m[1]!)).toBe(false);
    // Fields already used by profile values are skipped.
    expect(matchAnswers(fields, [{ question: "Notice period", answer: "30 days" }], new Set([3, 4]))).toEqual([]);
  });
});

describe("prefill proposal for a manual handoff", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <form id="f">
        <label>First Name <input name="first_name" /></label>
        <label>Last Name <input name="last_name" /></label>
        <label>Email <input type="email" name="email" /></label>
        <label>Resume <input type="file" name="resume" /></label>
        <label>Cover letter <textarea name="cover_letter"></textarea></label>
        <label>What is your notice period? <input name="q_notice" /></label>
        <label>Why do you want to join us? <textarea name="q_why"></textarea></label>
        <label>I agree to the privacy policy <input type="checkbox" name="agree" /></label>
        <button type="submit">Submit application</button>
      </form>`;
  });

  const payload: Pick<PrefillPayload, "fields" | "screeningAnswers" | "coverLetterReviewed"> = {
    fields: [
      { key: "firstName", label: "First name", value: "Aarav" },
      { key: "lastName", label: "Last name", value: "Mehta" },
      { key: "email", label: "Email", value: "aarav@example.test" },
      { key: "coverLetter", label: "Cover letter", value: "Dear team, ..." },
    ],
    screeningAnswers: [
      { question: "What is your notice period?", answer: "30 days", source: "PREFERENCE", reviewed: true },
      { question: "Why do you want to join us?", answer: "Generated from verified facts.", source: "GENERATED", reviewed: false },
    ],
    coverLetterReviewed: false,
  };

  it("maps profile fields, the cover letter and answers; unreviewed values start unselected", () => {
    const m = proposeMappings(collectFormFields(), payload, "https://example.test/apply");
    const byKey = Object.fromEntries(m.map((x) => [x.key, x]));
    expect(Object.keys(byKey).sort()).toEqual(["answer:0", "answer:1", "coverLetter", "email", "firstName", "lastName"]);
    expect(byKey.coverLetter).toMatchObject({ needsReview: true });
    expect(defaultSelected(byKey.coverLetter!)).toBe(false);
    expect(defaultSelected(byKey["answer:0"]!)).toBe(true);
    expect(defaultSelected(byKey["answer:1"]!)).toBe(false);
    // A reviewed cover letter (or an older server that omits the flag) is not flagged.
    expect(proposeMappings(collectFormFields(), { ...payload, coverLetterReviewed: undefined }, "https://example.test/apply").find((x) => x.key === "coverLetter")?.needsReview).toBeUndefined();
  });

  it("fills only the selected fields and never submits, even with answers mapped", () => {
    let submitted = false;
    document.getElementById("f")!.addEventListener("submit", () => {
      submitted = true;
    });
    const m = proposeMappings(collectFormFields(), payload, "https://example.test/apply").filter(defaultSelected);
    const r = applyFills(m.map((x) => ({ index: x.fieldIndex, value: x.value })));
    expect(r).toEqual({ filled: m.length, skipped: 0 });
    expect((document.querySelector("input[name=q_notice]") as HTMLInputElement).value).toBe("30 days");
    expect((document.querySelector("textarea[name=q_why]") as HTMLTextAreaElement).value).toBe("");
    expect((document.querySelector("textarea[name=cover_letter]") as HTMLTextAreaElement).value).toBe("");
    expect((document.querySelector("input[name=agree]") as HTMLInputElement).checked).toBe(false);
    expect(submitted).toBe(false);
  });
});

describe("extension guarantees", () => {
  it("keeps the MV3 manifest minimal: activeTab/scripting/storage, no content scripts, no background", () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as { manifest: Record<string, unknown> };
    expect(pkg.manifest.permissions).toEqual(["activeTab", "scripting", "storage"]);
    expect(pkg.manifest.content_scripts).toBeUndefined();
    expect(pkg.manifest.background).toBeUndefined();
    const srcEntries = readdirSync(join(__dirname, "..", "src"));
    // Plasmo registers content scripts / a service worker from these entry points.
    for (const entry of ["contents", "content.ts", "content.tsx", "background.ts", "background", "tabs"]) expect(srcEntries).not.toContain(entry);
  });

  it("never polls: no timers or alarms anywhere in the extension source", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(f)) files.push(p);
      }
    };
    walk(join(__dirname, "..", "src"));
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/setInterval|chrome\.alarms|setTimeout/);
    }
  });
});
