import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { LLM_PROVIDERS } from './llm-adapter';
import type { LlmAdapter, LlmProvider, StreamChatRequest } from './llm-adapter';
import { ProviderLimitsRegistry } from './provider-limits';

/** How long a provider may take to its first token before we move on. */
const FIRST_TOKEN_TIMEOUT_MS = (): number =>
  Number(process.env.LLM_FIRST_TOKEN_TIMEOUT_MS ?? 10_000);

/**
 * Availability-first fallback across providers, PRE-FIRST-TOKEN ONLY (see
 * DECISIONS.md, slice 11). Any failure before the first token — error,
 * timeout, bad key — moves to the next configured provider. Once a token has
 * been yielded the stream is committed: a later failure propagates to the
 * caller (SSE error + retry), never a mid-stream provider switch.
 */
@Injectable()
export class FallbackLlmAdapter implements LlmAdapter {
  constructor(
    @Inject(LLM_PROVIDERS) private readonly providers: LlmProvider[],
    private readonly logger: PinoLogger,
    private readonly limits: ProviderLimitsRegistry,
  ) {
    this.logger.setContext(FallbackLlmAdapter.name);
  }

  async *streamChat(request: StreamChatRequest): AsyncIterable<string> {
    const failures: string[] = [];

    for (const provider of this.providers) {
      if (!provider.isConfigured()) {
        continue;
      }
      if (!this.limits.mayAttempt(provider.name)) {
        failures.push(`${provider.name}: circuit open`);
        continue;
      }

      const iterator = provider.streamChat(request)[Symbol.asyncIterator]();
      let first: IteratorResult<string>;
      try {
        first = await this.firstTokenWithTimeout(iterator);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failures.push(`${provider.name}: ${message}`);
        this.logger.warn(
          { provider: provider.name, err: message },
          'provider failed before first token — falling back',
        );
        // Fire-and-forget: on a TIMED-OUT generator, return() would queue
        // behind the stuck next() and never resolve. The abandoned request
        // dies with its socket; we must not wait for it.
        void iterator.return?.(undefined)?.catch(() => undefined);
        continue;
      }

      // First token arrived: the stream is committed to this provider.
      if (first.done) {
        return; // an empty-but-clean stream is a valid (empty) answer
      }
      yield first.value;
      for (let result = await iterator.next(); !result.done; result = await iterator.next()) {
        yield result.value;
      }
      return;
    }

    throw new ServiceUnavailableException(
      failures.length > 0
        ? `all LLM providers failed (${failures.join('; ')})`
        : 'no LLM provider is configured',
    );
  }

  private async firstTokenWithTimeout(
    iterator: AsyncIterator<string>,
  ): Promise<IteratorResult<string>> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        iterator.next(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`no first token within ${FIRST_TOKEN_TIMEOUT_MS()}ms`)),
            FIRST_TOKEN_TIMEOUT_MS(),
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
