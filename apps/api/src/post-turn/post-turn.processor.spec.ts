import { parseChips, sanitizeTitle } from './post-turn.processor';

describe('parseChips', () => {
  it('parses a clean JSON array', () => {
    expect(parseChips('["How does caching work?", "Show an example"]')).toEqual([
      'How does caching work?',
      'Show an example',
    ]);
  });

  it('extracts the array out of prose and code fences', () => {
    expect(
      parseChips('Sure! Here you go:\n```json\n["One?", "Two?"]\n```\nHope that helps.'),
    ).toEqual(['One?', 'Two?']);
  });

  it('clamps to 3 chips and drops oversized or non-string entries', () => {
    const chips = parseChips(JSON.stringify(['a?', 'b?', 42, 'x'.repeat(100), 'c?', 'd?']));
    expect(chips).toEqual(['a?', 'b?', 'c?']);
  });

  it('returns empty on garbage', () => {
    expect(parseChips('no array here')).toEqual([]);
    expect(parseChips('[not json')).toEqual([]);
    expect(parseChips('{"an":"object"}')).toEqual([]);
  });
});

describe('sanitizeTitle', () => {
  it('strips quotes, markdown and trailing punctuation', () => {
    expect(sanitizeTitle('"Kubernetes Networking Basics."')).toBe('Kubernetes Networking Basics');
    expect(sanitizeTitle('**Valkey Cache Setup**')).toBe('Valkey Cache Setup');
  });

  it('collapses whitespace and clamps length', () => {
    expect(sanitizeTitle('A   title\nwith   gaps')).toBe('A title with gaps');
    expect(sanitizeTitle('x'.repeat(100)).length).toBeLessThanOrEqual(60);
  });

  it('returns empty for unusable output', () => {
    expect(sanitizeTitle('"`*#"')).toBe('');
  });
});
