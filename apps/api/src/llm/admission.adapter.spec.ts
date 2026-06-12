import { ServiceUnavailableException } from '@nestjs/common';
import { AdmissionControlledAdapter } from './admission.adapter';
import type { FallbackLlmAdapter } from './fallback.adapter';
import type { LlmProvider, StreamChatRequest } from './llm-adapter';
import { ProviderLimitsRegistry } from './provider-limits';

const REQUEST: StreamChatRequest = { system: 'sys', messages: [{ role: 'user', content: 'q' }] };

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Inner adapter whose streams only finish when the test says so. */
function gatedInner(): {
  inner: FallbackLlmAdapter;
  inFlight: () => number;
  peak: () => number;
  finishOne: () => void;
  failOne: () => void;
} {
  let inFlight = 0;
  let peak = 0;
  const gates: Array<(err?: Error) => void> = [];
  const inner = {
    async *streamChat(): AsyncIterable<string> {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      try {
        yield 'token';
        await new Promise<void>((resolve, reject) => {
          gates.push((err) => (err ? reject(err) : resolve()));
        });
        yield 'end';
      } finally {
        inFlight -= 1;
      }
    },
  } as unknown as FallbackLlmAdapter;
  return {
    inner,
    inFlight: () => inFlight,
    peak: () => peak,
    finishOne: () => gates.shift()?.(),
    failOne: () => gates.shift()?.(new Error('mid-stream death')),
  };
}

function provider(configured = true): LlmProvider {
  return {
    name: 'anthropic',
    isConfigured: () => configured,
    // eslint-disable-next-line require-yield
    async *streamChat(): AsyncIterable<string> {
      throw new Error('not used');
    },
  };
}

async function drain(iterable: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const chunk of iterable) {
    out.push(chunk);
  }
  return out;
}

describe('AdmissionControlledAdapter', () => {
  afterEach(() => {
    delete process.env.LLM_CONCURRENCY_DEFAULT;
    delete process.env.LLM_CONCURRENCY_MAX;
    delete process.env.LLM_QUEUE_MAX;
  });

  it('caps in-flight streams at DEFAULT and queues the rest (synthetic load)', async () => {
    process.env.LLM_CONCURRENCY_DEFAULT = '2';
    const { inner, peak, finishOne } = gatedInner();
    const adapter = new AdmissionControlledAdapter(
      inner,
      [provider()],
      new ProviderLimitsRegistry(),
    );

    const runs = Array.from({ length: 6 }, () => drain(adapter.streamChat(REQUEST)));
    await tick();
    expect(peak()).toBe(2);

    for (let i = 0; i < 6; i += 1) {
      finishOne();
      await tick();
      await tick();
    }
    const results = await Promise.all(runs);
    expect(results.every((r) => r.join('') === 'tokenend')).toBe(true);
    expect(peak()).toBe(2); // the cap held for the WHOLE run
  });

  it('rejects with 503 when the queue is full', async () => {
    process.env.LLM_CONCURRENCY_DEFAULT = '1';
    process.env.LLM_QUEUE_MAX = '1';
    const { inner, finishOne } = gatedInner();
    const adapter = new AdmissionControlledAdapter(
      inner,
      [provider()],
      new ProviderLimitsRegistry(),
    );

    const first = drain(adapter.streamChat(REQUEST));
    await tick();
    const second = drain(adapter.streamChat(REQUEST)); // queued
    await tick();

    await expect(drain(adapter.streamChat(REQUEST))).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );

    finishOne();
    await tick();
    finishOne();
    await Promise.all([first, second]);
  });

  it('admits up to MAX only when the lead provider shows fresh headroom', async () => {
    process.env.LLM_CONCURRENCY_DEFAULT = '1';
    process.env.LLM_CONCURRENCY_MAX = '3';
    const { inner, peak, finishOne } = gatedInner();
    const registry = new ProviderLimitsRegistry();
    const adapter = new AdmissionControlledAdapter(inner, [provider()], registry);

    // No header evidence yet → DEFAULT.
    const cold = Array.from({ length: 3 }, () => drain(adapter.streamChat(REQUEST)));
    await tick();
    expect(peak()).toBe(1);
    for (let i = 0; i < 3; i += 1) {
      finishOne();
      await tick();
      await tick();
    }
    await Promise.all(cold);

    // Fresh positive headroom → MAX.
    registry.recordHeaders('anthropic', { requestsRemaining: 100, tokensRemaining: 500_000 });
    const warm = Array.from({ length: 3 }, () => drain(adapter.streamChat(REQUEST)));
    await tick();
    expect(peak()).toBe(3);
    for (let i = 0; i < 3; i += 1) {
      finishOne();
      await tick();
      await tick();
    }
    await Promise.all(warm);
  });

  it('releases the slot when a stream dies mid-flight', async () => {
    process.env.LLM_CONCURRENCY_DEFAULT = '1';
    const { inner, finishOne, failOne } = gatedInner();
    const adapter = new AdmissionControlledAdapter(
      inner,
      [provider()],
      new ProviderLimitsRegistry(),
    );

    const doomed = drain(adapter.streamChat(REQUEST));
    await tick();
    const next = drain(adapter.streamChat(REQUEST)); // queued behind it
    await tick();

    failOne();
    await expect(doomed).rejects.toThrow('mid-stream death');
    await tick();
    finishOne();
    await expect(next).resolves.toEqual(['token', 'end']);
  });
});
