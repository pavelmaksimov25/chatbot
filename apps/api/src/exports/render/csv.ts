import type { ExportDocument } from './assemble';
import { roleLabel, slugify } from './shared';
import type { RenderedExport } from './shared';

export const CSV_MIME = 'text/csv';

/**
 * Hand-rolled RFC-4180 CSV: a `role,content` header followed by one row per
 * turn. Fields are quoted only when they must be (contain a quote, comma, CR
 * or LF); embedded quotes double; records end with CRLF.
 */
export async function renderCsv(doc: ExportDocument): Promise<RenderedExport> {
  const rows: string[][] = [
    ['role', 'content'],
    ...doc.rows.map((r) => [roleLabel(r.role), r.content]),
  ];
  const body = rows.map((fields) => fields.map(quoteField).join(',')).join('\r\n');
  return {
    buffer: Buffer.from(body, 'utf8'),
    filename: `${slugify(doc.title)}.csv`,
    mime: CSV_MIME,
  };
}

function quoteField(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
