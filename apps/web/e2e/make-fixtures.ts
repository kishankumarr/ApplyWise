/** Generates CV fixtures for E2E (run with tsx from global setup). DEMO CONTENT. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCvText, parsedCvToDocument, renderResumeDocx, renderResumePdf } from "@applywise/resume-engine";

const here = dirname(fileURLToPath(import.meta.url));
const text = readFileSync(resolve(here, "../../../packages/resume-engine/fixtures/demo-cv.txt"), "utf8");
const doc = parsedCvToDocument(parseCvText(text));
const out = resolve(here, ".fixtures");
mkdirSync(out, { recursive: true });
writeFileSync(resolve(out, "demo-cv.docx"), await renderResumeDocx(doc));
writeFileSync(resolve(out, "demo-cv.pdf"), await renderResumePdf(doc));
