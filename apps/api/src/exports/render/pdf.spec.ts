import { assemble, ExportScope } from './assemble';
import { PDF_MIME, renderPdf } from './pdf';

describe('renderPdf', () => {
  it('produces a non-empty PDF buffer with the right mime/extension', async () => {
    const out = await renderPdf(
      assemble({
        scope: ExportScope.Conversation,
        title: 'Quarterly Review',
        messages: [
          { role: 'user', content: 'How did we do?' },
          { role: 'assistant', content: 'Revenue is up.' },
        ],
      }),
    );
    expect(out.mime).toBe(PDF_MIME);
    expect(out.filename).toBe('quarterly-review.pdf');
    expect(out.buffer.length).toBeGreaterThan(0);
    // Every PDF starts with the "%PDF-" header and ends near an %%EOF marker.
    expect(out.buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(out.buffer.toString('latin1')).toContain('%%EOF');
  });

  it('flows long content across multiple pages', async () => {
    const long = Array.from({ length: 400 }, (_, i) => `Line ${i} of a very long answer.`).join(
      '\n',
    );
    const out = await renderPdf(
      assemble({
        scope: ExportScope.Answer,
        title: null,
        message: { role: 'assistant', content: long },
      }),
    );
    expect(out.filename).toBe('answer.pdf');
    // More than one page object means pdfkit paginated the overflow.
    const pageCount = out.buffer.toString('latin1').match(/\/Type\s*\/Page[^s]/g)?.length ?? 0;
    expect(pageCount).toBeGreaterThan(1);
  });
});
