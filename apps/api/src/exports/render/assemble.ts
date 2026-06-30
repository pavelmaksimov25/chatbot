import type { MessageRole } from '../../chat/conversation.repository';

/** One flattened turn in an export — no ids, no metadata, just speaker + text. */
export interface ExportMessage {
  role: MessageRole;
  content: string;
}

/** The neutral model every renderer consumes — decoupled from the DB shape. */
export interface ExportDocument {
  title: string;
  rows: ExportMessage[];
}

/** A loaded turn; only the fields the export cares about (a MessageRecord fits). */
export interface SourceMessage {
  role: MessageRole;
  content: string;
}

export type AssembleInput =
  | { scope: 'conversation'; title: string | null; messages: SourceMessage[] }
  | { scope: 'answer'; title: string | null; message: SourceMessage };

const DEFAULT_CONVERSATION_TITLE = 'Conversation';
const DEFAULT_ANSWER_TITLE = 'Answer';

/**
 * Flatten a conversation's active chain or a single assistant answer into the
 * neutral export model. A null/blank title falls back to a scope-appropriate
 * default so renderers always have something to put on the page and in the
 * filename.
 */
export function assemble(input: AssembleInput): ExportDocument {
  if (input.scope === 'answer') {
    return {
      title: cleanTitle(input.title, DEFAULT_ANSWER_TITLE),
      rows: [{ role: input.message.role, content: input.message.content }],
    };
  }
  return {
    title: cleanTitle(input.title, DEFAULT_CONVERSATION_TITLE),
    rows: input.messages.map((m) => ({ role: m.role, content: m.content })),
  };
}

function cleanTitle(title: string | null, fallback: string): string {
  const trimmed = title?.trim();
  return trimmed ? trimmed : fallback;
}
