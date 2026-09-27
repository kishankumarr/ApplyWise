import { createHash } from "node:crypto";
import { DEFAULT_SECTION_ORDER, SECTION_TITLES, type ResumeDocument } from "./types";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

function dateRange(start: string | null, end: string | null): string {
  if (!start && !end) return "";
  return `${start ?? ""} – ${end ?? "Present"}`;
}

function eduLine(e: ResumeDocument["education"][number]): string {
  const years = e.startYear && e.endYear ? `${e.startYear} – ${e.endYear}` : e.endYear ? String(e.endYear) : "";
  const degree = [e.degree, e.field].filter(Boolean).join(", ");
  return [degree, e.institution, years].filter(Boolean).join(" | ");
}

/**
 * ATS-readable single-column HTML: conventional headings, no tables, no graphics,
 * selectable text, simple fonts, plain bullet lists.
 */
export function renderResumeHtml(doc: ResumeDocument, opts: { standalone?: boolean } = {}): string {
  const order = doc.sectionOrder.length ? doc.sectionOrder : DEFAULT_SECTION_ORDER;
  const parts: string[] = [];
  const contact = [doc.contact.email, doc.contact.phone, doc.contact.location, ...doc.contact.links].filter(Boolean) as string[];
  parts.push(`<header><h1>${esc(doc.contact.fullName)}</h1>`);
  if (doc.headline) parts.push(`<p class="headline">${esc(doc.headline)}</p>`);
  if (contact.length) parts.push(`<p class="contact">${contact.map(esc).join(" | ")}</p>`);
  parts.push("</header>");

  for (const key of order) {
    const title = `<h2>${esc(SECTION_TITLES[key])}</h2>`;
    if (key === "summary" && doc.summary) parts.push(`<section>${title}<p>${esc(doc.summary)}</p></section>`);
    if (key === "experience" && doc.experience.length) {
      parts.push(`<section>${title}`);
      for (const e of doc.experience) {
        const meta = [e.company, e.location, dateRange(e.startDate, e.endDate)].filter(Boolean).join(" | ");
        parts.push(`<h3>${esc(e.title)}</h3><p class="meta">${esc(meta)}</p>`);
        if (e.bullets.length) parts.push(`<ul>${e.bullets.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>`);
      }
      parts.push("</section>");
    }
    if (key === "projects" && doc.projects.length) {
      parts.push(`<section>${title}`);
      for (const p of doc.projects) {
        parts.push(`<h3>${esc(p.name)}</h3>`);
        if (p.description) parts.push(`<p>${esc(p.description)}</p>`);
        if (p.technologies.length) parts.push(`<p class="meta">Technologies: ${esc(p.technologies.join(", "))}</p>`);
        if (p.url) parts.push(`<p class="meta">${esc(p.url)}</p>`);
      }
      parts.push("</section>");
    }
    if (key === "skills" && doc.skills.length) parts.push(`<section>${title}<p>${esc(doc.skills.join(", "))}</p></section>`);
    if (key === "education" && doc.education.length) {
      parts.push(`<section>${title}<ul>${doc.education.map((e) => `<li>${esc(eduLine(e))}</li>`).join("")}</ul></section>`);
    }
    if (key === "achievements" && doc.achievements.length) {
      parts.push(`<section>${title}<ul>${doc.achievements.map((a) => `<li>${esc(a)}</li>`).join("")}</ul></section>`);
    }
  }

  const body = `<article class="resume">${parts.join("\n")}</article>`;
  if (!opts.standalone) return body;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(doc.contact.fullName)} - Resume</title>
<style>
body{font-family:Arial,Helvetica,sans-serif;color:#111;max-width:780px;margin:32px auto;padding:0 24px;line-height:1.45;font-size:11pt}
h1{font-size:20pt;margin:0}h2{font-size:12pt;text-transform:uppercase;border-bottom:1px solid #999;margin:18px 0 6px;letter-spacing:.04em}
h3{font-size:11pt;margin:10px 0 0}.meta,.contact,.headline{margin:2px 0;color:#333}ul{margin:4px 0 0 18px;padding:0}li{margin:2px 0}
</style></head><body>${body}</body></html>`;
}

export function renderResumeText(doc: ResumeDocument): string {
  const order = doc.sectionOrder.length ? doc.sectionOrder : DEFAULT_SECTION_ORDER;
  const out: string[] = [doc.contact.fullName.toUpperCase()];
  if (doc.headline) out.push(doc.headline);
  const contact = [doc.contact.email, doc.contact.phone, doc.contact.location, ...doc.contact.links].filter(Boolean);
  if (contact.length) out.push(contact.join(" | "));
  for (const key of order) {
    const lines: string[] = [];
    if (key === "summary" && doc.summary) lines.push(doc.summary);
    if (key === "experience") {
      for (const e of doc.experience) {
        lines.push(`${e.title} - ${[e.company, e.location, dateRange(e.startDate, e.endDate)].filter(Boolean).join(" | ")}`);
        for (const b of e.bullets) lines.push(`  - ${b}`);
      }
    }
    if (key === "projects") {
      for (const p of doc.projects) {
        lines.push(p.name);
        if (p.description) lines.push(`  ${p.description}`);
        if (p.technologies.length) lines.push(`  Technologies: ${p.technologies.join(", ")}`);
      }
    }
    if (key === "skills" && doc.skills.length) lines.push(doc.skills.join(", "));
    if (key === "education") for (const e of doc.education) lines.push(`- ${eduLine(e)}`);
    if (key === "achievements") for (const a of doc.achievements) lines.push(`- ${a}`);
    if (lines.length) out.push("", SECTION_TITLES[key].toUpperCase(), ...lines);
  }
  return out.join("\n") + "\n";
}

/** Stable content hash used for version de-duplication. */
export function resumeContentHash(doc: ResumeDocument): string {
  return createHash("sha256").update(JSON.stringify(doc)).digest("hex").slice(0, 32);
}

export interface ResumeDiffLine {
  type: "added" | "removed" | "same";
  text: string;
}

/** Simple line diff (LCS) between two rendered text resumes, for version history. */
export function diffResumeText(before: string, after: string): ResumeDiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: ResumeDiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ type: "same", text: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ type: "removed", text: a[i++]! });
    } else {
      out.push({ type: "added", text: b[j++]! });
    }
  }
  while (i < a.length) out.push({ type: "removed", text: a[i++]! });
  while (j < b.length) out.push({ type: "added", text: b[j++]! });
  return out;
}
