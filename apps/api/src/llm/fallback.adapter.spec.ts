import { ServiceUnavailableException } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { FallbackLlmAdapter } from './fallback.adapter';
import type { LlmProvider, StreamChatRequest } from './llm-adapter';
import { ProviderLimitsRegistry } from './provider-limits';

const REQUEST: StreamChatRequest = { system: 'sys', messages: [{ role: 'user', content: 'q' }] };

interface FakeProviderOptions {
  configured?: boolean;
  chunks?: string[];
  failBeforeFirst?: boolean;
  failAfter?: number;
  hangForever?: boolean;
}

function fakeProvider(
  name: string,
  options: FakeProviderOptions = {},
): LlmProvider & {
  calls: number;
} {
  const {
    configured = true,
    chunks = [],
    failBeforeFirst = false,
    failAfter,
    hangForever = false,
  } = options;
  const provider = {
    name,
    calls: 0,
    isConfigured: () => configured,
    async *streamChat(): AsyncIterable<string> {
      provider.calls += 1;
      if (failBeforeFirst) {
        throw new Error(`${name} exploded`);
      }
      if (hangForever) {
        await new Promise(() => undefined); // never resolves
      }
      let emitted = 0;
      for (const chunk of chunks) {
        if (failAfter !== undefined && emitted >= failAfter) {
          throw new Error(`${name} died mid-stream`);
        }
        emitted += 1;
        yield chunk;
        await new Promise((resolve) => setImmediate(resolve));
      }
    },
  };
  return provider;
}

async function collect(iterable: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const chunk of iterable) {
    out.push(chunk);
  }
  return out;
}

let registry: ProviderLimitsRegistry;

function adapterWith(...providers: LlmProvider[]): FallbackLlmAdapter {
  const logger = { setContext: jest.fn(), warn: jest.fn() } as unknown as PinoLogger;
  registry = new ProviderLimitsRegistry();
  return new FallbackLlmAdapter(providers, logger, registry);
}

describe('FallbackLlmAdapter', () => {
  afterEach(() => {
    delete process.env.LLM_FIRST_TOKEN_TIMEOUT_MS;
  });

  it('streams from the primary when it works — no fallback call', async () => {
    const primary = fakeProvider('anthropic', { chunks: ['a', 'b'] });
    const backup = fakeProvider('openai', { chunks: ['nope'] });

    await expect(collect(adapterWith(primary, backup).streamChat(REQUEST))).resolves.toEqual([
      'a',
      'b',
    ]);
    expect(backup.calls).toBe(0);
  });

  it('falls back when the primary fails before the first token', async () => {
    const primary = fakeProvider('anthropic', { failBeforeFirst: true });
    const backup = fakeProvider('openai', { chunks: ['plan', ' b'] });

    await expect(collect(adapterWith(primary, backup).streamChat(REQUEST))).resolves.toEqual([
      'plan',
      ' b',
    ]);
  });

  it('skips unconfigured providers without calling them', async () => {
    const primary = fakeProvider('anthropic', { configured: false });
    const backup = fakeProvider('openai', { chunks: ['only me'] });

    await expect(collect(adapterWith(primary, backup).streamChat(REQUEST))).resolves.toEqual([
      'only me',
    ]);
    expect(primary.calls).toBe(0);
  });

  it('walks the whole chain: anthropic dead, openai dead, gemini answers', async () => {
    const a = fakeProvider('anthropic', { failBeforeFirst: true });
    const o = fakeProvider('openai', { failBeforeFirst: true });
    const g = fakeProvider('gemini', { chunks: ['last resort'] });

    await expect(collect(adapterWith(a, o, g).streamChat(REQUEST))).resolves.toEqual([
      'last resort',
    ]);
  });

  it('throws 503 naming every failure when all providers fail', async () => {
    const a = fakeProvider('anthropic', { failBeforeFirst: true });
    const o = fakeProvider('openai', { failBeforeFirst: true });

    const error = await collect(adapterWith(a, o).streamChat(REQUEST)).catch((err) => err);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as Error).message).toContain('anthropic: anthropic exploded');
    expect((error as Error).message).toContain('openai: openai exploded');
  });

  it('throws 503 when no provider is configured at all', async () => {
    const a = fakeProvider('anthropic', { configured: false });
    const error = await collect(adapterWith(a).streamChat(REQUEST)).catch((err) => err);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as Error).message).toContain('no LLM provider is configured');
  });

  it('NEVER switches provider after the first token — mid-stream failure propagates', async () => {
    const primary = fakeProvider('anthropic', { chunks: ['one', 'two', 'three'], failAfter: 2 });
    const backup = fakeProvider('openai', { chunks: ['should never run'] });

    const received: string[] = [];
    const error = await (async () => {
      try {
        for await (const chunk of adapterWith(primary, backup).streamChat(REQUEST)) {
          received.push(chunk);
        }
        return null;
      } catch (err) {
        return err;
      }
    })();

    expect(received).toEqual(['one', 'two']);
    expect((error as Error).message).toContain('died mid-stream');
    expect(backup.calls).toBe(0);
  });

  it('skips a provider whose circuit is open without calling it', async () => {
    const primary = fakeProvider('gemini', { chunks: ['should be skipped'] });
    const backup = fakeProvider('openai', { chunks: ['served instead'] });
    const adapter = adapterWith(primary, backup);
    registry.trip('gemini', 60_000);

    await expect(collect(adapter.streamChat(REQUEST))).resolves.toEqual(['served instead']);
    expect(primary.calls).toBe(0);
  });

  it('names the open circuit in the 503 when nothing else is available', async () => {
    const only = fakeProvider('gemini', { chunks: ['unreachable'] });
    const adapter = adapterWith(only);
    registry.trip('gemini', 60_000);

    const error = await collect(adapter.streamChat(REQUEST)).catch((err) => err);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as Error).message).toContain('gemini: circuit open');
  });

  it('falls back when the primary never produces a first token (timeout)', async () => {
    process.env.LLM_FIRST_TOKEN_TIMEOUT_MS = '50';
    const primary = fakeProvider('anthropic', { hangForever: true });
    const backup = fakeProvider('openai', { chunks: ['woke up'] });

    await expect(collect(adapterWith(primary, backup).streamChat(REQUEST))).resolves.toEqual([
      'woke up',
    ]);
  });
});
