/**
 * Functions injected into the active tab with chrome.scripting.executeScript - ONLY after an
 * explicit user click in the popup. Each function is serialised, so it must be fully
 * self-contained (no imports, no outer references).
 *
 * Hard rules enforced here:
 *  - Never submit a form and never press any button (no programmatic submit or click).
 *  - Never touch file inputs, password fields, checkboxes or hidden fields.
 *  - Read only visible text/labels needed for the preview; no background scraping.
 */

import type { ExtractedJob, FieldDescriptor } from "./types";

/** Extract the visible job posting from the current page. */
export function collectJobPage(): ExtractedJob {
  const isVisible = (el: Element) => {
    const s = window.getComputedStyle(el as HTMLElement);
    return s.display !== "none" && s.visibility !== "hidden" && (el as HTMLElement).offsetParent !== null;
  };
  const text = (el: Element | null | undefined) => (el && isVisible(el) ? (el as HTMLElement).innerText.trim() : "");
  const meta = (sel: string) => document.querySelector<HTMLMetaElement>(sel)?.content?.trim() ?? "";
  const h1 = Array.from(document.querySelectorAll("h1")).find(isVisible);
  const main = document.querySelector("main, article, [role=main], #content, .job-description") ?? document.body;
  const description = text(main).slice(0, 20000);
  const locEl = Array.from(document.querySelectorAll("[class*=location], [data-testid*=location], .location")).find(isVisible);
  const applyLink = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]")).find((a) => isVisible(a) && /apply/i.test(a.innerText));
  const mailto = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href^='mailto:']")).find(isVisible);
  const emailInText = description.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] ?? null;
  return {
    pageUrl: location.href,
    pageTitle: document.title.slice(0, 300),
    title: (text(h1) || meta("meta[property='og:title']") || document.title).slice(0, 200),
    company: (meta("meta[property='og:site_name']") || meta("meta[name='author']")).slice(0, 200),
    location: text(locEl).slice(0, 300),
    description,
    applyUrl: applyLink?.href ?? null,
    contactEmail: mailto ? mailto.href.replace(/^mailto:/i, "").split("?")[0] ?? null : emailInText,
  };
}

/** Describe visible, fillable form fields (labels only - existing values are not read). */
export function collectFormFields(): FieldDescriptor[] {
  const SKIP = ["file", "submit", "button", "reset", "image", "hidden", "password", "checkbox", "radio"];
  const els = Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input, textarea, select"));
  const out: FieldDescriptor[] = [];
  els.forEach((el, index) => {
    const type = (el.getAttribute("type") ?? (el.tagName === "TEXTAREA" ? "textarea" : el.tagName === "SELECT" ? "select" : "text")).toLowerCase();
    const s = window.getComputedStyle(el);
    if (SKIP.includes(type) || s.display === "none" || s.visibility === "hidden" || el.disabled || (el as HTMLInputElement).readOnly) return;
    let label = Array.from(el.labels ?? []).map((l) => l.textContent ?? "").join(" ");
    if (!label) label = el.closest("label")?.textContent ?? "";
    if (!label) {
      const labelledBy = el.getAttribute("aria-labelledby");
      if (labelledBy) label = labelledBy.split(" ").map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
    }
    out.push({
      index,
      tag: el.tagName.toLowerCase() as FieldDescriptor["tag"],
      type,
      name: el.getAttribute("name") ?? "",
      id: el.id ?? "",
      placeholder: el.getAttribute("placeholder") ?? "",
      label: label.replace(/\s+/g, " ").trim().slice(0, 200),
      ariaLabel: el.getAttribute("aria-label") ?? "",
      autocomplete: el.getAttribute("autocomplete") ?? "",
      automationId: el.getAttribute("data-automation-id") ?? "",
    });
  });
  return out;
}

/**
 * Fill ONLY the fields the user selected. Uses native value setters + input/change events so
 * frameworks notice the change. Returns the number of fields filled. Never submits.
 */
export function applyFills(fills: { index: number; value: string }[]): { filled: number; skipped: number } {
  const SKIP = ["file", "submit", "button", "reset", "image", "hidden", "password", "checkbox", "radio"];
  const els = Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input, textarea, select"));
  let filled = 0;
  let skipped = 0;
  for (const { index, value } of fills) {
    const el = els[index];
    const type = (el?.getAttribute("type") ?? "text").toLowerCase();
    if (!el || SKIP.includes(type) || el.disabled || (el as HTMLInputElement).readOnly) {
      skipped++;
      continue;
    }
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (el instanceof HTMLSelectElement) {
      const option = Array.from(el.options).find((o) => o.value.toLowerCase() === value.toLowerCase() || o.text.toLowerCase() === value.toLowerCase());
      if (!option) {
        skipped++;
        continue;
      }
      setter?.call(el, option.value);
    } else {
      setter?.call(el, value);
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.style.outline = "2px solid #6d5dfc";
    filled++;
  }
  return { filled, skipped };
}
