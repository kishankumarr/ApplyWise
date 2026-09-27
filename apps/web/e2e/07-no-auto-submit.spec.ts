import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { expect, test } from "@playwright/test";
import { matchFields } from "../../extension/src/lib/form-match";
import { applyFills, collectFormFields } from "../../extension/src/lib/injected";
import type { PrefillField } from "../../extension/src/lib/types";
import { signIn } from "./helpers";

const here = dirname(fileURLToPath(import.meta.url));

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) {
      if (!["node_modules", ".next", ".plasmo", "build"].includes(f)) out.push(...sourceFiles(p));
    } else if (/\.(ts|tsx)$/.test(f)) out.push(p);
  }
  return out;
}

const WEB_SRC = resolve(here, "../src");
const EXTENSION_SRC = resolve(here, "../../extension/src");
/** The worker-side browser executor (Playwright in the worker, never the user's browser). */
const BROWSER_EXECUTOR_DIR = resolve(WEB_SRC, "server/services/executors/browser");
const EXECUTORS_DIR = resolve(WEB_SRC, "server/services/executors");
const EXECUTORS_INDEX = resolve(EXECUTORS_DIR, "index.ts");
const EXECUTION_SERVICE = resolve(WEB_SRC, "server/services/application-execution.service.ts");

const inside = (file: string, dir: string) => file.startsWith(dir + sep);
const isTestFile = (f: string) => /[\\/]test[\\/]|\.test\.ts$/.test(f);

/**
 * Module references of a source file: static imports (with their clause, e.g. "{ a, type B }"), re-exports and
 * side-effect imports (clause "export" / "side-effect") and dynamic imports (clause null).
 */
function importsOf(src: string): { spec: string; clause: string | null }[] {
  const out: { spec: string; clause: string | null }[] = [];
  for (const m of src.matchAll(/\bimport\s+([^'";()]*?)\s+from\s+["']([^"']+)["']/g)) out.push({ spec: m[2]!, clause: m[1]!.trim() });
  for (const m of src.matchAll(/\bexport\s+(type\s+)?(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s+from\s+["']([^"']+)["']/g)) out.push({ spec: m[2]!, clause: m[1] ? "type export" : "export" });
  for (const m of src.matchAll(/\bimport\s+["']([^"']+)["']/g)) out.push({ spec: m[1]!, clause: "side-effect" });
  for (const m of src.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) out.push({ spec: m[1]!, clause: null });
  return out;
}

/** Resolve a relative or "@/..." specifier to an absolute path without extension (null for packages). */
function resolveSpec(from: string, spec: string): string | null {
  const base = spec.startsWith("@/") ? join(WEB_SRC, spec.slice(2)) : spec.startsWith(".") ? resolve(dirname(from), spec) : null;
  return base ? base.replace(/\.(ts|tsx)$/, "") : null;
}

test.describe("final submission cannot be automated", () => {
  test("backend and extension code contain no programmatic form submission or clicks", () => {
    const roots = [WEB_SRC, EXTENSION_SRC, resolve(here, "../../../packages")];
    const offenders: string[] = [];
    for (const root of roots) {
      for (const f of sourceFiles(root)) {
        if (isTestFile(f)) continue;
        // Only the worker-side browser executor may press an employer form's own submit button, and only when the
        // execution service runs it (see the next tests).
        if (inside(f, BROWSER_EXECUTOR_DIR)) continue;
        const src = readFileSync(f, "utf8");
        if (/\.(requestSubmit|submit)\s*\(/.test(src)) offenders.push(f);
        // The only allowed .click() is the synthetic <a download> used to save files in our own UI.
        if (/\.click\s*\(/.test(src) && !/a\.download = name;[\s\S]*a\.click\(\)/.test(src)) offenders.push(f);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("inside the browser executor, the only click presses the employer form's own submit button, after the challenge and dry-run checks", () => {
    const files = sourceFiles(BROWSER_EXECUTOR_DIR).filter((f) => !isTestFile(f));
    expect(files.length).toBeGreaterThan(0);
    const clicks: string[] = [];
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/\.(click|dblclick|tap)\s*\(/g)) clicks.push(`${basename(f)}:${m[1]}`);
      // Never a DOM-level submission, a synthetic event or a key press (Enter in a field submits a form).
      if (/requestSubmit|dispatchEvent|\.press\s*\(|\bkeyboard\s*\./.test(src)) offenders.push(`${basename(f)}: synthetic submission`);
      // The only ".submit(" is the flow asking the session to press the form's own button.
      for (const m of src.matchAll(/(\w+)\.submit\s*\(/g)) if (!(basename(f) === "flow.ts" && m[1] === "session")) offenders.push(`${basename(f)}: ${m[0]}`);
    }
    expect(offenders).toEqual([]);
    expect(clicks).toEqual(["playwright-driver.ts:click"]);

    // That click lives in PlaywrightSession.submit() (the adapter's submit-button selectors, first visible match)...
    const driver = readFileSync(join(BROWSER_EXECUTOR_DIR, "playwright-driver.ts"), "utf8");
    const submitBody = /\r?\n {2}async submit\(selectors: string\[\]\)[^{]*\{([\s\S]*?)\r?\n {2}\}/.exec(driver)?.[1] ?? "";
    expect(submitBody).toMatch(/\.click\(\)/);
    expect(submitBody).toMatch(/throw new SubmitButtonNotFoundError\(\)/);

    // ...which the flow calls exactly once, only after the CAPTCHA / MFA / sign-in checks and the dry-run check.
    const flow = readFileSync(join(BROWSER_EXECUTOR_DIR, "flow.ts"), "utf8");
    const calls = [...flow.matchAll(/\bsession\.submit\s*\(/g)];
    expect(calls).toHaveLength(1);
    const before = flow.slice(0, calls[0]!.index);
    expect(before.match(/await session\.detectChallenge\(\)/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(before).toMatch(/if \(challenge\) \{[\s\S]*?return manual\(challenge/);
    expect(before).toMatch(/if \(late\) return manual\(late/);
    expect(before).toMatch(/if \(opts\.dryRun\) \{[\s\S]*?return manual\(/);
    expect(before).toMatch(/if \(missing\.length\) \{[\s\S]*?return \{ outcome: "NEEDS_INFORMATION"/);
  });

  test("the browser extension never clicks or submits anything", () => {
    const offenders = sourceFiles(EXTENSION_SRC)
      .filter((f) => !isTestFile(f))
      .filter((f) => /\.(requestSubmit|submit|click)\s*\(|dispatchEvent\(\s*new\s+(?:Mouse|Submit)Event/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  test("only the executor registry loads the browser executor, and only the worker driver loads Playwright", () => {
    const offenders: string[] = [];
    for (const f of sourceFiles(WEB_SRC)) {
      if (inside(f, BROWSER_EXECUTOR_DIR)) continue;
      const src = readFileSync(f, "utf8");
      for (const { spec } of importsOf(src)) {
        const target = resolveSpec(f, spec);
        if (target && (target === BROWSER_EXECUTOR_DIR || inside(target, BROWSER_EXECUTOR_DIR)) && f !== EXECUTORS_INDEX) offenders.push(`${f} -> ${spec}`);
        if (spec === "playwright-core" || spec === "playwright") offenders.push(`${f} -> ${spec}`);
      }
    }
    for (const f of sourceFiles(BROWSER_EXECUTOR_DIR)) {
      const src = readFileSync(f, "utf8");
      if (/from\s+["']playwright(-core)?["']|import\(\s*["']playwright(-core)?["']/.test(src) && !f.endsWith(`${sep}playwright-driver.ts`)) offenders.push(`${f} -> playwright`);
    }
    expect(offenders).toEqual([]);
    expect(readFileSync(EXECUTORS_INDEX, "utf8")).toMatch(/from\s+["']\.\/browser\//);
  });

  test("only the execution service runs executors; other code may only describe the selection", () => {
    const offenders: string[] = [];
    for (const f of sourceFiles(WEB_SRC)) {
      if (inside(f, EXECUTORS_DIR) || f === EXECUTION_SERVICE) continue;
      const src = readFileSync(f, "utf8");
      for (const { spec, clause } of importsOf(src)) {
        const target = resolveSpec(f, spec);
        if (!target || !(target === EXECUTORS_DIR || inside(target, EXECUTORS_DIR))) continue;
        if (clause === null || clause === "export" || clause === "side-effect") {
          offenders.push(`${f}: ${clause ?? "dynamic import"} of ${spec}`);
          continue;
        }
        if (/^type\s/.test(clause)) continue;
        const names = /^\{([\s\S]*)\}$/.exec(clause.trim())?.[1]?.split(",").map((n) => n.trim()).filter(Boolean) ?? [clause];
        const values = names.filter((n) => !n.startsWith("type "));
        const allowed = target === EXECUTORS_DIR || target === join(EXECUTORS_DIR, "index") ? ["selectExecutor", "executorInfo", "providerLabel"] : [];
        const bad = values.filter((n) => !allowed.includes(n.split(/\s+as\s+/)[0]!));
        if (bad.length) offenders.push(`${f}: ${bad.join(", ")} from ${spec}`);
      }
      if (/\bexecutor\.execute\s*\(|\.executor\.execute\s*\(/.test(src)) offenders.push(`${f}: calls executor.execute`);
    }
    expect(offenders).toEqual([]);
    // The execution service is the one caller (sanity check so this test cannot pass vacuously).
    const service = readFileSync(EXECUTION_SERVICE, "utf8");
    expect(service).toMatch(/from\s+["']\.\/executors["']/);
    expect(service).toMatch(/\bexecutor\.execute\s*\(/);
  });

  test("no endpoint can mark an application submitted or send email without explicit user confirmation", async ({ page }) => {
    await signIn(page);
    const apps = await page.request.get("/api/applications?pageSize=100");
    const list = (await apps.json()).data.items as { id: string; status: string }[];
    const target = list.find((a) => a.status === "APPROVED" || a.status === "READY_FOR_REVIEW")?.id ?? list[0]?.id ?? "nonexistent";
    // Missing explicit confirmation flags -> validation error; nothing changes.
    const submitted = await page.request.post(`/api/applications/${target}/mark-submitted`, { data: {}, headers: { origin: new URL(page.url()).origin } });
    expect(submitted.status()).toBe(422);
    const sent = await page.request.post(`/api/applications/${target}/email/send`, { data: { confirmationToken: "x".repeat(40) }, headers: { origin: new URL(page.url()).origin } });
    expect(sent.status()).toBe(422);
    // Cross-site requests are blocked outright.
    const csrf = await page.request.post(`/api/applications/${target}/mark-submitted`, { data: { submittedByUser: true }, headers: { origin: "https://evil.example" } });
    expect(csrf.status()).toBe(403);
    // The tracker cannot jump to SUBMITTED.
    const patch = await page.request.patch(`/api/applications/${target}`, { data: { status: "SUBMITTED" }, headers: { origin: new URL(page.url()).origin } });
    expect([404, 409]).toContain(patch.status());
  });

  test("extension prefill fills approved fields on a real form and never submits it", async ({ page }) => {
    await page.goto("/demo/ats/greenhouse/framecraft-senior-frontend");
    await expect(page.getByText(/DEMO CONTENT/)).toBeVisible();
    let submitted = false;
    page.on("request", (r) => {
      if (r.method() === "POST" && r.url().includes("/demo/ats/")) submitted = true;
    });

    const fields = await page.evaluate(collectFormFields);
    expect(fields.some((f) => f.type === "file")).toBe(false);
    const prefill: PrefillField[] = [
      { key: "firstName", label: "First name", value: "Aarav" },
      { key: "lastName", label: "Last name", value: "Mehta" },
      { key: "email", label: "Email", value: "aarav.mehta@example.test" },
      { key: "phone", label: "Phone", value: "+91 98765 43210" },
      { key: "coverLetter", label: "Cover letter", value: "Dear team, ..." },
    ];
    const mapping = matchFields(fields, prefill, page.url());
    expect(mapping.map((m) => m.key).sort()).toEqual(["coverLetter", "email", "firstName", "lastName", "phone"]);
    // The user selects everything except the phone number.
    const selected = mapping.filter((m) => m.key !== "phone").map((m) => ({ index: m.fieldIndex, value: m.value }));
    const result = await page.evaluate(applyFills, selected);
    expect(result.filled).toBe(4);

    await expect(page.locator("input[name=first_name]")).toHaveValue("Aarav");
    await expect(page.locator("input[name=email]")).toHaveValue("aarav.mehta@example.test");
    await expect(page.locator("input[name=phone]")).toHaveValue("");
    await expect(page.locator("input[type=file]")).toHaveValue("");
    // The form was not submitted.
    await expect(page.getByText("Demo only - nothing was sent")).toHaveCount(0);
    expect(submitted).toBe(false);
  });
});
