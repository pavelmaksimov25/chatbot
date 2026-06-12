import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import type { LlmAdapter, StreamChatRequest } from './llm-adapter';

// Sonnet with thinking off: time-to-first-token ranks above reasoning depth
// on the chat hot path (see DECISIONS.md, slice 7).
const DEFAULT_MODEL = 'claude-sonnet-4-6';
const DEFAULT_MAX_TOKENS = 1024;

@Injectable()
export class AnthropicAdapter implements LlmAdapter {
  private client?: Anthropic;

  async *streamChat(request: StreamChatRequest): AsyncIterable<string> {
    const stream = await this.getClient().messages.create({
      model: process.env.LLM_MODEL ?? DEFAULT_MODEL,
      max_tokens: Number(process.env.LLM_MAX_TOKENS ?? DEFAULT_MAX_TOKENS),
      system: request.system,
      messages: request.messages,
      stream: true,
    });
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        yield event.delta.text;
      }
    }
  }

  private getClient(): Anthropic {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new ServiceUnavailableException(
        'LLM is not configured — set ANTHROPIC_API_KEY and re-run the secrets bootstrap',
      );
    }
    this.client ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    return this.client;
  }
}
