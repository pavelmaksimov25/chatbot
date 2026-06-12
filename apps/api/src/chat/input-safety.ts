import { BadRequestException } from '@nestjs/common';

export const MAX_INPUT_CHARS = 8000;

// Everything below 0x20 except \t and \n, plus DEL. \r is stripped so CRLF
// input normalizes to \n.
// eslint-disable-next-line no-control-regex -- stripping control chars is the point
const CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F]/g;

/**
 * v1 input-safety check (see DECISIONS.md, slice 7): structural validation
 * only. The real input-side defense is per-user context scoping — only the
 * caller's own active chain is ever assembled into a prompt.
 */
export function checkInput(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new BadRequestException('content must be a string');
  }
  const cleaned = raw.replace(CONTROL_CHARS, '').trim();
  if (cleaned.length === 0) {
    throw new BadRequestException('content must not be empty');
  }
  if (cleaned.length > MAX_INPUT_CHARS) {
    throw new BadRequestException(`content must be at most ${MAX_INPUT_CHARS} characters`);
  }
  return cleaned;
}
