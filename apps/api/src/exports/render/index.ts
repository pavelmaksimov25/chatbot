import type { ExportFormat } from '../export.repository';
import type { ExportDocument } from './assemble';
import { renderCsv } from './csv';
import { renderDocx } from './docx';
import { renderPdf } from './pdf';
import type { RenderedExport } from './shared';

export type { ExportDocument, ExportMessage, AssembleInput, SourceMessage } from './assemble';
export { assemble, ExportScope } from './assemble';
export type { RenderedExport } from './shared';
export { renderCsv, CSV_MIME } from './csv';
export { renderDocx, DOCX_MIME } from './docx';
export { renderPdf, PDF_MIME } from './pdf';

export type Renderer = (doc: ExportDocument) => Promise<RenderedExport>;

/** Lookup the job pipeline (18c) uses to pick a renderer by requested format. */
export const RENDERERS: Record<ExportFormat, Renderer> = {
  csv: renderCsv,
  docx: renderDocx,
  pdf: renderPdf,
};
