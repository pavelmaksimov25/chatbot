import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';
import type { ExportDocument, ExportMessage } from './assemble';
import { roleLabel, slugify } from './shared';
import type { RenderedExport } from './shared';

export const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/**
 * Render the export model to a .docx: the title as Heading 1, then each turn
 * as a bold speaker heading followed by its content. Blank lines in the content
 * become separate paragraphs so multi-paragraph answers keep their shape.
 */
export async function renderDocx(doc: ExportDocument): Promise<RenderedExport> {
  const children: Paragraph[] = [
    new Paragraph({ text: doc.title, heading: HeadingLevel.HEADING_1 }),
  ];
  for (const row of doc.rows) {
    children.push(...turnParagraphs(row));
  }

  const document = new Document({ sections: [{ children }] });
  const buffer = await Packer.toBuffer(document);
  return {
    buffer: Buffer.from(buffer),
    filename: `${slugify(doc.title)}.docx`,
    mime: DOCX_MIME,
  };
}

function turnParagraphs(row: ExportMessage): Paragraph[] {
  const speaker = new Paragraph({
    spacing: { before: 200 },
    children: [new TextRun({ text: roleLabel(row.role), bold: true })],
  });
  const lines = row.content.split('\n');
  const body = lines.map((line) => new Paragraph({ children: [new TextRun(line)] }));
  return [speaker, ...body];
}
