import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { adapterFor } from "../src/lib/adapters";
import { matchFields } from "../src/lib/form-match";
import { applyFills, collectFormFields } from "../src/lib/injected";
import type { PrefillField } from "../src/lib/types";

const prefill: PrefillField[] = [
  { key: "firstName", label: "First name", value: "Aarav" },
  { key: "lastName", label: "Last name", value: "Mehta" },
  { key: "fullName", label: "Full name", value: "Aarav Mehta" },
  { key: "email", label: "Email", value: "aarav@example.test" },
  { key: "phone", label: "Phone", value: "+91 98765 43210" },
  { key: "linkedin", label: "LinkedIn URL", value: "https://linkedin.com/in/aarav-demo" },
  { key: "coverLetter", label: "Cover letter", value: "Dear team..." },
];

beforeEach(() => {
  document.body.innerHTML = `
    <form id="f">
      <label>First Name * <input name="first_name" /></label>
      <label>Last Name * <input name="last_name" /></label>
      <label for="em">Email address</label><input id="em" type="email" name="x1" />
      <input name="phone" placeholder="Mobile number" />
      <label>LinkedIn Profile <input name="urls[LinkedIn]" /></label>
      <label>Resume <input type="file" name="resume" /></label>
      <label>Password <input type="password" name="pw" /></label>
      <label>Cover letter <textarea name="cover_letter"></textarea></label>
      <input type="hidden" name="csrf" value="x" />
      <button type="submit">Submit application</button>
    </form>`;
});

describe("generic form-label matching", () => {
  it("maps fields by label, placeholder, name and type, and skips file/password/hidden inputs", () => {
    const fields = collectFormFields();
    expect(fields.some((f) => f.type === "file" || f.type === "password" || f.type === "hidden")).toBe(false);
    const m = matchFields(fields, prefill, "https://example.test/jobs/1");
    const byKey = Object.fromEntries(m.map((x) => [x.key, x.fieldLabel]));
    expect(Object.keys(byKey)).toEqual(expect.arrayContaining(["firstName", "lastName", "email", "phone", "linkedin", "coverLetter"]));
    // Full name must not be forced into a form with separate first/last name fields.
    expect(byKey.fullName).toBeUndefined();
  });

  it("uses adapters for known ATS field names", () => {
    expect(adapterFor("https://boards.greenhouse.io/x/jobs/1").id).toBe("greenhouse");
    expect(adapterFor("https://jobs.lever.co/x/1").id).toBe("lever");
    expect(adapterFor("https://x.wd3.myworkdayjobs.com/y").id).toBe("workday");
    expect(adapterFor("https://jobs.ashbyhq.com/x").id).toBe("ashby");
    const m = matchFields(collectFormFields(), prefill, "https://boards.greenhouse.io/x/jobs/1");
    expect(m.find((x) => x.key === "firstName")?.confidence).toBe("adapter");
  });
});

describe("prefill never submits", () => {
  it("fills only selected fields, never file inputs, and never submits the form", () => {
    let submitted = false;
    document.getElementById("f")!.addEventListener("submit", () => {
      submitted = true;
    });
    const fields = collectFormFields();
    const m = matchFields(fields, prefill, "https://example.test");
    const only = m.filter((x) => x.key === "email" || x.key === "firstName");
    const r = applyFills(only.map((x) => ({ index: x.fieldIndex, value: x.value })));
    expect(r.filled).toBe(2);
    expect((document.querySelector("input[name=first_name]") as HTMLInputElement).value).toBe("Aarav");
    expect((document.querySelector("input[name=last_name]") as HTMLInputElement).value).toBe("");
    expect(submitted).toBe(false);
    // Even if asked to, file inputs are skipped.
    const fileIndex = Array.from(document.querySelectorAll("input, textarea, select")).findIndex((e) => (e as HTMLInputElement).type === "file");
    expect(applyFills([{ index: fileIndex, value: "C:/secret.pdf" }])).toEqual({ filled: 0, skipped: 1 });
    expect(submitted).toBe(false);
  });

  it("contains no submit/click calls anywhere in the extension source", () => {
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
      expect(src, f).not.toMatch(/\.(submit|requestSubmit|click)\s*\(/);
    }
  });
});
