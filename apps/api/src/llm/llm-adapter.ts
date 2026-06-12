export interface ChatTurnMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Quality/cost tier, mapped per provider so a fallback never silently jumps
 * tiers: default = Sonnet / GPT mid / Gemini Pro; cheap = Haiku / GPT mini /
 * Gemini Flash.
 */
export type LlmTier = 'default' | 'cheap';

export interface StreamChatRequest {
  system: string;
  messages: ChatTurnMessage[];
  tier?: LlmTier;
}

/**
 * The provider seam. Everything above this interface is provider-agnostic;
 * tests fake it here (record/replay) and never reach a real API.
 */
export interface LlmAdapter {
  /** Yields sanitization-ready text deltas; throws on provider failure. */
  streamChat(request: StreamChatRequest): AsyncIterable<string>;
}

export const LLM_ADAPTER = 'LLM_ADAPTER';

/**
 * One upstream LLM vendor behind the adapter. The fallback adapter walks
 * these availability-first; unconfigured providers are skipped silently.
 */
export interface LlmProvider {
  readonly name: string;
  isConfigured(): boolean;
  streamChat(request: StreamChatRequest): AsyncIterable<string>;
}

export const LLM_PROVIDERS = 'LLM_PROVIDERS';
