import { Injectable } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { PinoLogger } from 'nestjs-pino';
import { Counter, register } from 'prom-client';
import type { LlmProvider, StreamChatRequest } from './llm-adapter';
import { ProviderLimitsRegistry, headerNumber } from './provider-limits';
import { MAX_TOKENS, modelFor } from './tier-models';

function counter(name: string, help: string): Counter {
  return (
    (register.getSingleMetric(name) as Counter) ??
    new Counter({ name, help, labelNames: ['provider'] })
  );
}

/**
 * Primary provider. Thinking off: TTFT ranks above reasoning depth here.
 *
 * Prompt caching (see DECISIONS.md, slice 13): two cache_control breakpoints
 * — the stable system block and the newest message — so each turn re-reads
 * the prior turns from cache and extends the entry. Prefix discipline is
 * enforced upstream (deterministic system prompt + constant welcome trigger).
 * Anthropic silently skips caching below its ~1024-token minimum prefix.
 */
@Injectable()
export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic';

  private client?: Anthropic;

  private readonly cacheReadTokens = counter(
    'llm_cache_read_tokens_total',
    'Prompt tokens served from the provider prompt cache',
  );
  private readonly cacheCreationTokens = counter(
    'llm_cache_creation_tokens_total',
    'Prompt tokens written to the provider prompt cache',
  );
  private readonly inputTokens = counter(
    'llm_input_tokens_total',
    'Uncached prompt tokens billed at the full input price',
  );

  constructor(
    private readonly limits: ProviderLimitsRegistry,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(AnthropicProvider.name);
  }

  isConfigured(): boolean {
    return Boolean(process.env.ANTHROPIC_API_KEY);
  }

  async *streamChat(request: StreamChatRequest): AsyncIterable<string> {
    this.client ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const lastIndex = request.messages.length - 1;
    const { data: stream, response } = await this.client.messages
      .create({
        model: modelFor('anthropic', request.tier),
        max_tokens: MAX_TOKENS(),
        system: [{ type: 'text', text: request.system, cache_control: { type: 'ephemeral' } }],
        messages: request.messages.map((m, i) => ({
          role: m.role,
          content:
            i === lastIndex
              ? [
                  {
                    type: 'text' as const,
                    text: m.content,
                    cache_control: { type: 'ephemeral' as const },
                  },
                ]
              : m.content,
        })),
        stream: true,
      })
      .withResponse();

    // Seed the admission controller with the provider's own view of headroom.
    this.limits.recordHeaders(this.name, {
      requestsRemaining: headerNumber(response.headers, 'anthropic-ratelimit-requests-remaining'),
      tokensRemaining: headerNumber(response.headers, 'anthropic-ratelimit-tokens-remaining'),
    });

    for await (const event of stream) {
      if (event.type === 'message_start') {
        this.recordUsage(event.message.usage);
      } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        yield event.delta.text;
      }
    }
  }

  private recordUsage(usage: Anthropic.Usage): void {
    const cacheRead = usage.cache_read_input_tokens ?? 0;
    const cacheCreation = usage.cache_creation_input_tokens ?? 0;
    this.cacheReadTokens.inc({ provider: this.name }, cacheRead);
    this.cacheCreationTokens.inc({ provider: this.name }, cacheCreation);
    this.inputTokens.inc({ provider: this.name }, usage.input_tokens);
    this.logger.info(
      {
        cacheReadTokens: cacheRead,
        cacheCreationTokens: cacheCreation,
        inputTokens: usage.input_tokens,
      },
      'anthropic prompt usage',
    );
  }
}
