import { assemble, ExportScope } from './assemble';
import { DOCX_MIME, renderDocx } from './docx';

describe('renderDocx', () => {
  it('produces a non-empty .docx (zip) buffer with the right mime/extension', async () => {
    const out = await renderDocx(
      assemble({
        scope: ExportScope.Conversation,
        title: 'My Report',
        messages: [
          { role: 'user', content: 'Summarise the meeting.' },
          { role: 'assistant', content: 'Para one.\n\nPara two.' },
        ],
      }),
    );
    expect(out.mime).toBe(DOCX_MIME);
    expect(out.filename).toBe('my-report.docx');
    expect(out.buffer.length).toBeGreaterThan(0);
    // .docx is an OOXML zip — it starts with the PK local-file-header magic.
    expect(out.buffer.subarray(0, 2).toString('latin1')).toBe('PK');
  });

  it('renders a single answer to a valid document', async () => {
    const out = await renderDocx(
      assemble({
        scope: ExportScope.Answer,
        title: null,
        message: { role: 'assistant', content: 'Just one answer.' },
      }),
    );
    expect(out.filename).toBe('answer.docx');
    expect(out.buffer.subarray(0, 2).toString('latin1')).toBe('PK');
  });
});
