import PDFDocument from 'pdfkit';
import type { ExportDocument } from './assemble';
import { roleLabel, slugify } from './shared';
import type { RenderedExport } from './shared';

export const PDF_MIME = 'application/pdf';

/**
 * Render the export model to a PDF with pdfkit. Uses the built-in Helvetica
 * family only (the standard-14 fonts ship as AFM metrics — no filesystem font
 * lookup), and lets pdfkit flow text across as many pages as the content needs.
 */
export async function renderPdf(doc: ExportDocument): Promise<RenderedExport> {
  const pdf = new PDFDocument({ size: 'A4', margin: 56 });
  const chunks: Buffer[] = [];
  pdf.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve, reject) => {
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);
  });

  pdf.font('Helvetica-Bold').fontSize(20).text(doc.title);
  pdf.moveDown(0.5);
  for (const row of doc.rows) {
    pdf.font('Helvetica-Bold').fontSize(12).text(roleLabel(row.role));
    pdf.font('Helvetica').fontSize(11).text(row.content, { align: 'left' });
    pdf.moveDown(0.75);
  }

  pdf.end();
  const buffer = await done;
  return {
    buffer,
    filename: `${slugify(doc.title)}.pdf`,
    mime: PDF_MIME,
  };
}
