import type { MessageRole } from '../../chat/conversation.repository';

/** What a renderer hands back: the bytes plus how to name and serve them. */
export interface RenderedExport {
  buffer: Buffer;
  filename: string;
  mime: string;
}

/** Human label for a turn's speaker, used as a heading in docx/pdf/csv. */
export function roleLabel(role: MessageRole): string {
  return role === 'assistant' ? 'Assistant' : 'You';
}

/**
 * Turn a title into a safe, lowercase filename stem: keep word characters,
 * collapse everything else to single hyphens, trim, and cap the length. Falls
 * back to "export" when nothing usable remains.
 */
export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return slug || 'export';
}
