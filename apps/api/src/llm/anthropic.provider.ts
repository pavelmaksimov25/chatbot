import { Injectable } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import type { LlmProvider, StreamChatRequest } from './llm-adapter';
import { ProviderLimitsRegistry, headerNumber } from './provider-limits';
import { MAX_TOKENS, modelFor } from './tier-models';

/** Primary provider. Thinking off: TTFT ranks above reasoning depth here. */
@Injectable()
export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic';

  private client?: Anthropic;

  constructor(private readonly limits: ProviderLimitsRegistry) {}

  isConfigured(): boolean {
    return Boolean(process.env.ANTHROPIC_API_KEY);
  }

  async *streamChat(request: StreamChatRequest): AsyncIterable<string> {
    this.client ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const { data: stream, response } = await this.client.messages
      .create({
        model: modelFor('anthropic', request.tier),
        max_tokens: MAX_TOKENS(),
        system: request.system,
        messages: request.messages,
        stream: true,
      })
      .withResponse();

    // Seed the admission controller with the provider's own view of headroom.
    this.limits.recordHeaders(this.name, {
      requestsRemaining: headerNumber(response.headers, 'anthropic-ratelimit-requests-remaining'),
      tokensRemaining: headerNumber(response.headers, 'anthropic-ratelimit-tokens-remaining'),
    });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        yield event.delta.text;
      }
    }
  }
}
