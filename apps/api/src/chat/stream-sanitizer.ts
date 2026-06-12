const REPLACEMENT = '[redacted]';

// Secret-shaped output only (see DECISIONS.md, slice 7) — PII redaction is
// deliberately out of v1. The lookbehind keeps triggers from firing inside
// ordinary words ("task-…", "risk-…").
const PATTERNS = [
  /(?<![A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]{8,}/,
  /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{20,}/,
  /(?<![A-Za-z0-9_-])AKIA[0-9A-Z]{16}/,
  /(?<![A-Za-z0-9_-])gh[pousr]_[A-Za-z0-9]{36}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

const COMBINED = new RegExp(PATTERNS.map((p) => `(?:${p.source})`).join('|'), 'g');

// Released text always trails the stream by this much, so a secret split
// across chunk boundaries (or a half-arrived trigger) can never leak.
const TAIL_GUARD = 64;

// A "secret" still growing past this length is redacted immediately and the
// rest of it swallowed — bounds memory against a pathological stream.
const MAX_HELD_MATCH = 1024;

const SECRET_BODY = /^[A-Za-z0-9_-]+/;

/**
 * Incremental sliding-window redactor for streamed model output. Feed chunks
 * through push() and forward only what it returns; call flush() at stream end.
 */
export class StreamSanitizer {
  private pending = '';
  private swallowing = false;

  push(chunk: string): string {
    let text = chunk;
    if (this.swallowing) {
      const swallowed = SECRET_BODY.exec(text);
      if (swallowed) {
        text = text.slice(swallowed[0].length);
      }
      if (text.length === 0) {
        return '';
      }
      this.swallowing = false;
    }
    this.pending += text;
    return this.drain(false);
  }

  flush(): string {
    const released = this.drain(true);
    this.pending = '';
    return released;
  }

  private drain(final: boolean): string {
    let processed = '';
    let cursor = 0;
    let heldMatchStart = -1;
    COMBINED.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = COMBINED.exec(this.pending)) !== null) {
      const touchesEnd = match.index + match[0].length === this.pending.length;
      if (touchesEnd && !final) {
        if (match[0].length > MAX_HELD_MATCH) {
          // Cap a never-ending "secret": redact now, swallow its remainder.
          processed += this.pending.slice(cursor, match.index) + REPLACEMENT;
          cursor = this.pending.length;
          this.swallowing = true;
          break;
        }
        heldMatchStart = match.index;
        break;
      }
      processed += this.pending.slice(cursor, match.index) + REPLACEMENT;
      cursor = match.index + match[0].length;
    }

    if (heldMatchStart >= 0) {
      processed += this.pending.slice(cursor, heldMatchStart);
      const raw = this.pending.slice(heldMatchStart);
      const releaseUpTo = Math.max(0, processed.length - TAIL_GUARD);
      const released = processed.slice(0, releaseUpTo);
      this.pending = processed.slice(releaseUpTo) + raw;
      return released;
    }

    processed += this.pending.slice(cursor);
    if (final) {
      this.pending = '';
      return processed;
    }
    const releaseUpTo = Math.max(0, processed.length - TAIL_GUARD);
    this.pending = processed.slice(releaseUpTo);
    return processed.slice(0, releaseUpTo);
  }
}
