import { assemble, ExportScope } from './assemble';

describe('assemble', () => {
  it('flattens a whole conversation into ordered rows, preserving order', () => {
    const doc = assemble({
      scope: ExportScope.Conversation,
      title: 'Trip planning',
      messages: [
        { role: 'user', content: 'Where to in June?' },
        { role: 'assistant', content: 'Consider Lisbon.' },
        { role: 'user', content: 'Why Lisbon?' },
      ],
    });
    expect(doc.title).toBe('Trip planning');
    expect(doc.rows).toEqual([
      { role: 'user', content: 'Where to in June?' },
      { role: 'assistant', content: 'Consider Lisbon.' },
      { role: 'user', content: 'Why Lisbon?' },
    ]);
  });

  it('reduces a single assistant answer to one row', () => {
    const doc = assemble({
      scope: ExportScope.Answer,
      title: 'Trip planning',
      message: { role: 'assistant', content: 'Consider Lisbon.' },
    });
    expect(doc.rows).toEqual([{ role: 'assistant', content: 'Consider Lisbon.' }]);
  });

  it('falls back to a scope-appropriate title when none is given', () => {
    expect(assemble({ scope: ExportScope.Conversation, title: null, messages: [] }).title).toBe(
      'Conversation',
    );
    expect(
      assemble({
        scope: ExportScope.Answer,
        title: '   ',
        message: { role: 'assistant', content: 'x' },
      }).title,
    ).toBe('Answer');
  });

  it('keeps a provided title trimmed', () => {
    expect(
      assemble({ scope: ExportScope.Conversation, title: '  Budget  ', messages: [] }).title,
    ).toBe('Budget');
  });
});
