import { Injectable } from '@nestjs/common';
import OpenAI from 'openai';
import type { LlmProvider, StreamChatRequest } from './llm-adapter';
import { ProviderLimitsRegistry, headerNumber } from './provider-limits';
import { MAX_TOKENS, modelFor } from './tier-models';

/** First fallback. Message shape normalized: system prompt becomes a system message. */
@Injectable()
export class OpenAiProvider implements LlmProvider {
  readonly name = 'openai';

  private client?: OpenAI;

  constructor(private readonly limits: ProviderLimitsRegistry) {}

  isConfigured(): boolean {
    return Boolean(process.env.OPENAI_API_KEY);
  }

  async *streamChat(request: StreamChatRequest): AsyncIterable<string> {
    this.client ??= new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const { data: stream, response } = await this.client.chat.completions
      .create({
        model: modelFor('openai', request.tier),
        max_completion_tokens: MAX_TOKENS(),
        stream: true,
        messages: [
          { role: 'system' as const, content: request.system },
          ...request.messages.map((m) => ({ role: m.role, content: m.content })),
        ],
      })
      .withResponse();

    this.limits.recordHeaders(this.name, {
      requestsRemaining: headerNumber(response.headers, 'x-ratelimit-remaining-requests'),
      tokensRemaining: headerNumber(response.headers, 'x-ratelimit-remaining-tokens'),
    });

    for await (const part of stream) {
      const delta = part.choices[0]?.delta?.content;
      if (delta) {
        yield delta;
      }
    }
  }
}
