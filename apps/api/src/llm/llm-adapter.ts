export interface ChatTurnMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface StreamChatRequest {
  system: string;
  messages: ChatTurnMessage[];
}

/**
 * The provider seam. Everything above this interface is provider-agnostic;
 * tests fake it here (record/replay) and never reach a real API. Multi-
 * provider fallback (slice 11) plugs in behind it.
 */
export interface LlmAdapter {
  /** Yields sanitization-ready text deltas; throws on provider failure. */
  streamChat(request: StreamChatRequest): AsyncIterable<string>;
}

export const LLM_ADAPTER = 'LLM_ADAPTER';
