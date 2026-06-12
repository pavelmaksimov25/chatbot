import { StreamSanitizer } from './stream-sanitizer';

/** Push chunks through a sanitizer and collect everything it releases. */
function run(chunks: string[]): string {
  const sanitizer = new StreamSanitizer();
  let out = '';
  for (const chunk of chunks) {
    out += sanitizer.push(chunk);
  }
  return out + sanitizer.flush();
}

describe('StreamSanitizer', () => {
  it('passes ordinary text through unchanged', () => {
    expect(run(['Hello, ', 'how can I help', ' you today?'])).toBe(
      'Hello, how can I help you today?',
    );
  });

  it('never releases the held tail before more text or flush', () => {
    const sanitizer = new StreamSanitizer();
    const released = sanitizer.push('short');
    expect(released).toBe('');
    expect(sanitizer.flush()).toBe('short');
  });

  it('redacts an Anthropic API key inside a single chunk', () => {
    expect(run(['the key is sk-ant-api03-abcdef1234567890 — keep it safe'])).toBe(
      'the key is [redacted] — keep it safe',
    );
  });

  it('redacts a secret split across chunk boundaries', () => {
    expect(run(['my key: sk-an', 't-api03-abcdef123', '4567890, done'])).toBe(
      'my key: [redacted], done',
    );
  });

  it('redacts a secret that ends exactly at the end of the stream', () => {
    expect(run(['use sk-ant-api03-abcdef1234567890'])).toBe('use [redacted]');
  });

  it('redacts an OpenAI-style key', () => {
    expect(run(['sk-proj4abcdefghijklmnopqrstuv999 is the token'])).toBe('[redacted] is the token');
  });

  it('redacts an AWS access key id', () => {
    expect(run(['creds: AKIA', 'IOSFODNN7EXAMPLE end'])).toBe('creds: [redacted] end');
  });

  it('redacts GitHub tokens', () => {
    expect(run([`token ghp_${'a1B2'.repeat(9)} here`])).toBe('token [redacted] here');
  });

  it('redacts a PEM private-key header even when split', () => {
    expect(run(['-----BEGIN RSA PRIV', 'ATE KEY-----\nMIIE...'])).toBe('[redacted]\nMIIE...');
  });

  it('redacts multiple secrets in one stream', () => {
    expect(run(['a AKIAIOSFODNN7EXAMPLE b sk-ant-abcdefgh12345678 c'])).toBe(
      'a [redacted] b [redacted] c',
    );
  });

  it('does not fire inside ordinary words containing the trigger', () => {
    const text = 'the task-abcdefghijklmnopqrstuvwxyz012 label and some risk-free text';
    expect(run([text])).toBe(text);
  });

  it('does not hold an unbounded amount of a never-ending secret', () => {
    const sanitizer = new StreamSanitizer();
    let released = sanitizer.push('leak sk-ant-');
    for (let i = 0; i < 200; i += 1) {
      released += sanitizer.push('abcdefghij1234567890');
    }
    released += sanitizer.flush();
    expect(released).toBe('leak [redacted]');
    expect(released.length).toBeLessThan(100);
  });

  it('handles many tiny chunks (one char at a time)', () => {
    expect(run([...'psst sk-ant-api03-abcdef1234567890 ok'])).toBe('psst [redacted] ok');
  });
});
