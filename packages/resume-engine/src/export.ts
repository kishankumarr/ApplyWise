import { DEFAULT_SECTION_ORDER, SECTION_TITLES, type ResumeDocument } from "./types";

function dateRange(start: string | null, end: string | null): string {
  if (!start && !end) return "";
  return `${start ?? ""} - ${end ?? "Present"}`;
}

/** ATS-readable PDF: single column, standard Helvetica font, selectable text, no graphics. */
export async function renderResumePdf(doc: ResumeDocument, opts: { creationDate?: Date } = {}): Promise<Buffer> {
  const { default: PDFDocument } = await import("pdfkit");
  const pdf = new PDFDocument({ size: "A4", margins: { top: 48, bottom: 48, left: 54, right: 54 }, info: { Title: `${doc.contact.fullName} - Resume`, ...(opts.creationDate ? { CreationDate: opts.creationDate } : {}) } });
  const chunks: Buffer[] = [];
  pdf.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    pdf.on("error", reject);
  });

  const width = pdf.page.width - 108;
  pdf.font("Helvetica-Bold").fontSize(18).text(doc.contact.fullName);
  if (doc.headline) pdf.font("Helvetica").fontSize(11).text(doc.headline);
  const contact = [doc.contact.email, doc.contact.phone, doc.contact.location, ...doc.contact.links].filter(Boolean).join(" | ");
  if (contact) pdf.font("Helvetica").fontSize(9.5).fillColor("#333").text(contact).fillColor("#000");

  const heading = (t: string) => {
    pdf.moveDown(0.8);
    pdf.font("Helvetica-Bold").fontSize(11).text(t.toUpperCase());
    const y = pdf.y + 1;
    pdf.moveTo(54, y).lineTo(54 + width, y).lineWidth(0.5).strokeColor("#888").stroke();
    pdf.moveDown(0.3);
  };
  const bullets = (items: string[]) => {
    for (const b of items) pdf.font("Helvetica").fontSize(10).text(`•  ${b}`, { indent: 8, width: width - 8 });
  };

  for (const key of doc.sectionOrder.length ? doc.sectionOrder : DEFAULT_SECTION_ORDER) {
    if (key === "summary" && doc.summary) {
      heading(SECTION_TITLES.summary);
      pdf.font("Helvetica").fontSize(10).text(doc.summary, { width });
    }
    if (key === "experience" && doc.experience.length) {
      heading(SECTION_TITLES.experience);
      for (const e of doc.experience) {
        pdf.moveDown(0.3).font("Helvetica-Bold").fontSize(10.5).text(e.title);
        pdf.font("Helvetica").fontSize(9.5).fillColor("#333").text([e.company, e.location, dateRange(e.startDate, e.endDate)].filter(Boolean).join(" | ")).fillColor("#000");
        bullets(e.bullets);
      }
    }
    if (key === "projects" && doc.projects.length) {
      heading(SECTION_TITLES.projects);
      for (const p of doc.projects) {
        pdf.moveDown(0.3).font("Helvetica-Bold").fontSize(10.5).text(p.name);
        if (p.description) pdf.font("Helvetica").fontSize(10).text(p.description, { width });
        if (p.technologies.length) pdf.font("Helvetica").fontSize(9.5).text(`Technologies: ${p.technologies.join(", ")}`);
      }
    }
    if (key === "skills" && doc.skills.length) {
      heading(SECTION_TITLES.skills);
      pdf.font("Helvetica").fontSize(10).text(doc.skills.join(", "), { width });
    }
    if (key === "education" && doc.education.length) {
      heading(SECTION_TITLES.education);
      bullets(
        doc.education.map((e) =>
          [[e.degree, e.field].filter(Boolean).join(", "), e.institution, e.endYear ? String(e.endYear) : ""].filter(Boolean).join(" | "),
        ),
      );
    }
    if (key === "achievements" && doc.achievements.length) {
      heading(SECTION_TITLES.achievements);
      bullets(doc.achievements);
    }
  }
  pdf.end();
  return done;
}

/** DOCX export using standard Word heading/bullet styles (no tables, no text boxes). */
export async function renderResumeDocx(doc: ResumeDocument): Promise<Buffer> {
  const { Document, HeadingLevel, Packer, Paragraph, TextRun } = await import("docx");
  const children: InstanceType<typeof Paragraph>[] = [];
  children.push(new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: doc.contact.fullName, bold: true })] }));
  if (doc.headline) children.push(new Paragraph({ text: doc.headline }));
  const contact = [doc.contact.email, doc.contact.phone, doc.contact.location, ...doc.contact.links].filter(Boolean).join(" | ");
  if (contact) children.push(new Paragraph({ text: contact }));
  const h = (t: string) => children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, text: t }));
  const bullet = (t: string) => children.push(new Paragraph({ text: t, bullet: { level: 0 } }));

  for (const key of doc.sectionOrder.length ? doc.sectionOrder : DEFAULT_SECTION_ORDER) {
    if (key === "summary" && doc.summary) {
      h(SECTION_TITLES.summary);
      children.push(new Paragraph({ text: doc.summary }));
    }
    if (key === "experience" && doc.experience.length) {
      h(SECTION_TITLES.experience);
      for (const e of doc.experience) {
        children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, text: e.title }));
        children.push(new Paragraph({ text: [e.company, e.location, dateRange(e.startDate, e.endDate)].filter(Boolean).join(" | ") }));
        e.bullets.forEach(bullet);
      }
    }
    if (key === "projects" && doc.projects.length) {
      h(SECTION_TITLES.projects);
      for (const p of doc.projects) {
        children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, text: p.name }));
        if (p.description) children.push(new Paragraph({ text: p.description }));
        if (p.technologies.length) children.push(new Paragraph({ text: `Technologies: ${p.technologies.join(", ")}` }));
      }
    }
    if (key === "skills" && doc.skills.length) {
      h(SECTION_TITLES.skills);
      children.push(new Paragraph({ text: doc.skills.join(", ") }));
    }
    if (key === "education" && doc.education.length) {
      h(SECTION_TITLES.education);
      doc.education.forEach((e) =>
        bullet([[e.degree, e.field].filter(Boolean).join(", "), e.institution, e.endYear ? String(e.endYear) : ""].filter(Boolean).join(" | ")),
      );
    }
    if (key === "achievements" && doc.achievements.length) {
      h(SECTION_TITLES.achievements);
      doc.achievements.forEach(bullet);
    }
  }
  const document = new Document({
    creator: "ApplyWise",
    title: `${doc.contact.fullName} - Resume`,
    styles: { default: { document: { run: { font: "Arial", size: 21 } } } },
    sections: [{ children }],
  });
  return Packer.toBuffer(document);
}
