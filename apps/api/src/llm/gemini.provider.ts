import { Injectable } from '@nestjs/common';
import { GoogleGenAI } from '@google/genai';
import type { LlmProvider, StreamChatRequest } from './llm-adapter';
import { ProviderLimitsRegistry, parseRetryDelayMs } from './provider-limits';
import { MAX_TOKENS, modelFor } from './tier-models';

/**
 * Last fallback. Roles normalized: assistant → model; system via config.
 * Gemini exposes no reliable headroom headers, so overload handling is a
 * circuit breaker: a 429 RESOURCE_EXHAUSTED trips it for the server-returned
 * retryDelay (default cooldown when absent).
 */
@Injectable()
export class GeminiProvider implements LlmProvider {
  readonly name = 'gemini';

  private client?: GoogleGenAI;

  constructor(private readonly limits: ProviderLimitsRegistry) {}

  isConfigured(): boolean {
    return Boolean(process.env.GEMINI_API_KEY);
  }

  async *streamChat(request: StreamChatRequest): AsyncIterable<string> {
    this.client ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    try {
      const stream = await this.client.models.generateContentStream({
        model: modelFor('gemini', request.tier),
        contents: request.messages.map((m) => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }],
        })),
        config: {
          systemInstruction: request.system,
          maxOutputTokens: MAX_TOKENS(),
        },
      });
      for await (const chunk of stream) {
        if (chunk.text) {
          yield chunk.text;
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = (err as { status?: number }).status;
      if (status === 429 || message.includes('RESOURCE_EXHAUSTED')) {
        this.limits.trip(this.name, parseRetryDelayMs(message) ?? undefined);
      }
      throw err;
    }
  }
}
