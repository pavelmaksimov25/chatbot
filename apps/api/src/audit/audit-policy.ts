/**
 * Holistic post-stream checks (see DECISIONS.md, slice 16). Deliberately thin
 * in v1 — the durable value is the async infrastructure around it; the policy
 * set is the seam that grows. The audit is a BACKSTOP: the primary security
 * control remains input-side context scoping, and the streaming sanitizer
 * already redacted what it could see through its window.
 */

export interface AuditVerdict {
  flagged: boolean;
  reasons: string[];
}

// Full-text pass over the assembled response — no window, no holdback.
const SECRET_PATTERNS: [string, RegExp][] = [
  ['anthropic-api-key', /(?<![A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]{8,}/],
  ['api-key', /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{20,}/],
  ['aws-access-key-id', /(?<![A-Za-z0-9_-])AKIA[0-9A-Z]{16}/],
  ['github-token', /(?<![A-Za-z0-9_-])gh[pousr]_[A-Za-z0-9]{36}/],
  ['private-key-block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];

/** Extra org-specific markers, comma-separated regexes via env. */
function denylist(): [string, RegExp][] {
  const raw = process.env.AUDIT_FLAG_PATTERNS;
  if (!raw) {
    return [];
  }
  return raw
    .split(',')
    .map((source, i): [string, RegExp] | null => {
      try {
        return [`denylist-${i}`, new RegExp(source.trim(), 'i')];
      } catch {
        return null; // a broken pattern must not kill the audit
      }
    })
    .filter((entry): entry is [string, RegExp] => entry !== null);
}

export function auditText(text: string): AuditVerdict {
  const reasons: string[] = [];
  for (const [reason, pattern] of [...SECRET_PATTERNS, ...denylist()]) {
    if (pattern.test(text)) {
      reasons.push(reason);
    }
  }
  return { flagged: reasons.length > 0, reasons };
}
