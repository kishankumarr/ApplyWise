import type { ParsedCv } from "./types";

/**
 * ATS-readability heuristics. These are advisory warnings, never a guarantee of
 * ATS compatibility.
 */
export function checkResumeFormat(rawText: string, parsed: ParsedCv): string[] {
  const warnings: string[] = [];
  const words = rawText.split(/\s+/).filter(Boolean).length;
  if (!parsed.email) warnings.push("No email address detected in the resume header.");
  if (!parsed.phone) warnings.push("No phone number detected in the resume header.");
  if (parsed.experience.length === 0) warnings.push('No "Experience" section detected - use a conventional heading.');
  else if (parsed.experience.some((e) => !e.startDate)) warnings.push("Some roles are missing dates; keep a readable chronology.");
  if (parsed.skills.length === 0) warnings.push('No "Skills" section detected.');
  if (words > 1400) warnings.push("The resume is long (over ~3 pages); consider tightening to 1-2 pages.");
  if (words < 120) warnings.push("Very little text could be extracted - scanned/image resumes are not ATS-readable.");
  const tabbyLines = rawText.split("\n").filter((l) => /\S\s{6,}\S.*\s{6,}\S/.test(l)).length;
  if (tabbyLines > 8) warnings.push("Possible multi-column or table layout detected; single-column layouts parse more reliably.");
  if (/[▰▱■□●○]{3,}|★{2,}/.test(rawText)) warnings.push("Graphical skill bars/ratings detected; list skills as plain text instead.");
  return warnings;
}
