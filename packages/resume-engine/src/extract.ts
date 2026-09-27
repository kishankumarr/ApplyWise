/**
 * Text extraction from uploaded CVs. Only PDF and DOCX are accepted.
 * Extraction happens server-side; raw text is never logged.
 */

export const ALLOWED_RESUME_TYPES = {
  pdf: { mime: "application/pdf", extension: ".pdf" },
  docx: {
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    extension: ".docx",
  },
} as const;

export type ResumeFileKind = keyof typeof ALLOWED_RESUME_TYPES;

export class UnsupportedResumeFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedResumeFileError";
  }
}

/**
 * Validate by extension, declared MIME type AND magic bytes. Returns the file kind.
 * PDF files start with "%PDF-"; DOCX files are ZIP containers starting with "PK\x03\x04".
 */
export function detectResumeFileKind(fileName: string, declaredMime: string, bytes: Uint8Array): ResumeFileKind {
  const lower = fileName.toLowerCase();
  const byExt: ResumeFileKind | null = lower.endsWith(".pdf") ? "pdf" : lower.endsWith(".docx") ? "docx" : null;
  if (!byExt) throw new UnsupportedResumeFileError("Only .pdf and .docx files are supported.");
  const expectedMime = ALLOWED_RESUME_TYPES[byExt].mime;
  // Some browsers send an empty/octet-stream type; tolerate that but never a conflicting type.
  if (declaredMime && declaredMime !== expectedMime && declaredMime !== "application/octet-stream") {
    throw new UnsupportedResumeFileError("File type does not match its extension.");
  }
  const isPdf = bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d;
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
  if (byExt === "pdf" && !isPdf) throw new UnsupportedResumeFileError("File content is not a valid PDF.");
  if (byExt === "docx" && !isZip) throw new UnsupportedResumeFileError("File content is not a valid DOCX.");
  return byExt;
}

export async function extractTextFromResume(kind: ResumeFileKind, bytes: Uint8Array): Promise<string> {
  if (kind === "pdf") {
    const { getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const pages: string[] = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      // Rebuild line structure from item positions so section headings survive.
      let line = "";
      let lastY: number | null = null;
      const lines: string[] = [];
      for (const item of content.items as { str?: string; transform?: number[]; hasEOL?: boolean }[]) {
        if (typeof item.str !== "string") continue;
        const y = item.transform?.[5] ?? null;
        if (lastY !== null && y !== null && Math.abs(y - lastY) > 2 && line.trim()) {
          lines.push(line);
          line = "";
        }
        line += item.str;
        if (y !== null) lastY = y;
        if (item.hasEOL) {
          lines.push(line);
          line = "";
        }
      }
      if (line.trim()) lines.push(line);
      pages.push(lines.join("\n"));
    }
    return normalizeExtractedText(pages.join("\n\n"));
  }
  const mammoth = await import("mammoth");
  // HTML conversion keeps list structure (raw text drops Word bullet markers).
  const result = await mammoth.convertToHtml({ buffer: Buffer.from(bytes) });
  return normalizeExtractedText(htmlToStructuredText(result.value));
}

/** Minimal HTML -> text that preserves headings, paragraphs and list items ("- item"). */
export function htmlToStructuredText(html: string): string {
  return html
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/(p|h[1-6]|li|tr|div)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<(td|th)[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .join("\n");
}

export function normalizeExtractedText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
