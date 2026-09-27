const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Convert a plain-text application email into minimal, accessible HTML. */
export function plainTextToHtml(text: string): string {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 12px">${esc(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#111">${paragraphs}</div>`;
}

/** mailto: link for "Open in my email client". Attachments cannot be added via mailto. */
export function buildMailtoUrl(opts: { to: string; cc?: string[]; subject: string; body: string }): string {
  const params = new URLSearchParams();
  if (opts.cc?.length) params.set("cc", opts.cc.join(","));
  params.set("subject", opts.subject);
  params.set("body", opts.body);
  // URLSearchParams encodes spaces as "+", which some mail clients show literally.
  return `mailto:${encodeURIComponent(opts.to)}?${params.toString().replace(/\+/g, "%20")}`;
}
