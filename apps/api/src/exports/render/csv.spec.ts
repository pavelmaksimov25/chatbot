import { assemble, ExportScope } from './assemble';
import { CSV_MIME, renderCsv } from './csv';

describe('renderCsv', () => {
  it('emits a role,content header and CRLF line endings with the right mime/extension', async () => {
    const out = await renderCsv(
      assemble({
        scope: ExportScope.Conversation,
        title: 'Notes',
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'hello' },
        ],
      }),
    );
    expect(out.mime).toBe(CSV_MIME);
    expect(out.filename).toBe('notes.csv');
    expect(out.buffer.length).toBeGreaterThan(0);
    expect(out.buffer.toString('utf8')).toBe('role,content\r\nYou,hi\r\nAssistant,hello');
  });

  it('quotes and escapes fields with quotes, commas, and newlines (RFC 4180)', async () => {
    const out = await renderCsv(
      assemble({
        scope: ExportScope.Answer,
        title: 'Edge',
        message: {
          role: 'assistant',
          content: 'has "quotes", a comma, and\na newline',
        },
      }),
    );
    const lines = out.buffer.toString('utf8').split('\r\n');
    expect(lines[0]).toBe('role,content');
    // Embedded quotes doubled; whole field wrapped; the literal LF stays inside.
    expect(lines[1]).toBe('Assistant,"has ""quotes"", a comma, and\na newline"');
  });

  it('quotes a field containing a carriage return', async () => {
    const out = await renderCsv(
      assemble({
        scope: ExportScope.Answer,
        title: 'CR',
        message: { role: 'assistant', content: 'line1\r\nline2' },
      }),
    );
    expect(out.buffer.toString('utf8')).toBe('role,content\r\nAssistant,"line1\r\nline2"');
  });

  it('leaves plain fields unquoted', async () => {
    const out = await renderCsv(
      assemble({
        scope: ExportScope.Answer,
        title: 'Plain',
        message: { role: 'user', content: 'simple text' },
      }),
    );
    expect(out.buffer.toString('utf8')).toBe('role,content\r\nYou,simple text');
  });
});
