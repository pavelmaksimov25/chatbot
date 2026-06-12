import { Injectable } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { PinoLogger } from 'nestjs-pino';
import { Counter, register } from 'prom-client';
import type { ContentPart, LlmProvider, StreamChatRequest } from './llm-adapter';
import { ProviderLimitsRegistry, headerNumber } from './provider-limits';
import { MAX_TOKENS, modelFor } from './tier-models';

type AnthropicPart = Record<string, unknown>;

function toAnthropicParts(content: string | ContentPart[]): AnthropicPart[] {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  return content.map((part): AnthropicPart => {
    if (part.type === 'text') {
      return { type: 'text', text: part.text };
    }
    if (part.type === 'image') {
      return {
        type: 'image',
        source: { type: 'base64', media_type: part.mime, data: part.dataBase64 },
      };
    }
    return {
      type: 'document',
      source: { type: 'base64', media_type: part.mime, data: part.dataBase64 },
      ...(part.name && { title: part.name }),
    };
  });
}

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
        messages: request.messages.map((m, i) => {
          // Older string-only messages stay plain strings — byte-stable
          // prefix for the cache; multimodal and newest messages use parts.
          if (typeof m.content === 'string' && i !== lastIndex) {
            return { role: m.role, content: m.content };
          }
          const parts = toAnthropicParts(m.content);
          if (i === lastIndex) {
            parts[parts.length - 1] = {
              ...parts[parts.length - 1],
              cache_control: { type: 'ephemeral' },
            };
          }
          return { role: m.role, content: parts };
        }) as Anthropic.MessageParam[],
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
