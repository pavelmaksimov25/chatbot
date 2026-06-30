export interface ChatMessage {
  id?: string;
  role: 'user' | 'assistant';
  content: string;
  /** Attachment count from history; names known only for local sends. */
  attachments?: string[];
}

export interface ConversationItem {
  id: string;
  title: string | null;
  preview: string | null;
}

export interface Suggestions {
  forMessageId: string | null;
  suggestions: string[];
}
