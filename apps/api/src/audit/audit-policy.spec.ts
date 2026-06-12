import { auditText } from './audit-policy';

describe('auditText', () => {
  afterEach(() => {
    delete process.env.AUDIT_FLAG_PATTERNS;
  });

  it('passes ordinary answers', () => {
    expect(auditText('Valkey is a Redis-compatible key-value store.')).toEqual({
      flagged: false,
      reasons: [],
    });
  });

  it('flags a secret anywhere in the full text — no window to slip through', () => {
    const verdict = auditText(`${'padding '.repeat(500)}sk-ant-api03-abcdef1234567890`);
    expect(verdict.flagged).toBe(true);
    expect(verdict.reasons).toContain('anthropic-api-key');
  });

  it('collects every distinct reason', () => {
    const verdict = auditText('AKIAIOSFODNN7EXAMPLE and -----BEGIN RSA PRIVATE KEY-----');
    expect(verdict.reasons).toEqual(['aws-access-key-id', 'private-key-block']);
  });

  it('honours the env denylist seam', () => {
    process.env.AUDIT_FLAG_PATTERNS = 'project\\s+glasswing,internal-codename-\\d+';
    expect(auditText('mentioning Project Glasswing here').flagged).toBe(true);
    expect(auditText('about internal-codename-42').flagged).toBe(true);
    expect(auditText('a normal sentence').flagged).toBe(false);
  });

  it('survives a broken denylist pattern', () => {
    process.env.AUDIT_FLAG_PATTERNS = '([unclosed';
    expect(auditText('anything').flagged).toBe(false);
  });
});
