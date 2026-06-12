import type { PinoLogger } from 'nestjs-pino';
import { register } from 'prom-client';
import { AnthropicProvider } from './anthropic.provider';
import { ProviderLimitsRegistry } from './provider-limits';

const createMock = jest.fn();

jest.mock('@anthropic-ai/sdk', () => ({
  __esModule: true,
  default: class FakeAnthropic {
    messages = { create: createMock };
  },
}));

interface StreamEvent {
  type: string;
  [key: string]: unknown;
}

function armSdk(events: StreamEvent[], headers: Record<string, string> = {}): void {
  createMock.mockReturnValue({
    withResponse: () =>
      Promise.resolve({
        data: (async function* () {
          for (const event of events) {
            yield event;
          }
        })(),
        response: { headers: new Headers(headers) },
      }),
  });
}

const MESSAGE_START: StreamEvent = {
  type: 'message_start',
  message: {
    usage: { input_tokens: 12, cache_read_input_tokens: 2048, cache_creation_input_tokens: 130 },
  },
};

const DELTA: StreamEvent = {
  type: 'content_block_delta',
  delta: { type: 'text_delta', text: 'hello' },
};

describe('AnthropicProvider prompt caching', () => {
  let provider: AnthropicProvider;
  let logged: Record<string, unknown>[];

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    createMock.mockReset();
    logged = [];
    const logger = {
      setContext: jest.fn(),
      info: (payload: Record<string, unknown>) => logged.push(payload),
    } as unknown as PinoLogger;
    provider = new AnthropicProvider(new ProviderLimitsRegistry(), logger);
  });

  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  async function run(messages: { role: 'user' | 'assistant'; content: string }[]) {
    armSdk([MESSAGE_START, DELTA]);
    const out: string[] = [];
    for await (const chunk of provider.streamChat({ system: 'stable prefix', messages })) {
      out.push(chunk);
    }
    return out;
  }

  it('places cache_control on the system block and ONLY the newest message', async () => {
    await run([
      { role: 'user', content: 'turn one' },
      { role: 'assistant', content: 'answer one' },
      { role: 'user', content: 'turn two' },
    ]);

    const params = createMock.mock.calls[0][0];
    expect(params.system).toEqual([
      { type: 'text', text: 'stable prefix', cache_control: { type: 'ephemeral' } },
    ]);
    // Older messages stay plain strings — byte-stable prefix for the cache.
    expect(params.messages[0]).toEqual({ role: 'user', content: 'turn one' });
    expect(params.messages[1]).toEqual({ role: 'assistant', content: 'answer one' });
    expect(params.messages[2]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'turn two', cache_control: { type: 'ephemeral' } }],
    });
  });

  it('streams text deltas while swallowing bookkeeping events', async () => {
    await expect(run([{ role: 'user', content: 'q' }])).resolves.toEqual(['hello']);
  });

  it('surfaces cache effectiveness in the log line and prometheus counters', async () => {
    await run([{ role: 'user', content: 'q' }]);

    expect(logged[0]).toMatchObject({
      cacheReadTokens: 2048,
      cacheCreationTokens: 130,
      inputTokens: 12,
    });

    const metrics = await register.metrics();
    expect(metrics).toMatch(/llm_cache_read_tokens_total\{provider="anthropic"\} \d+/);
    expect(metrics).toMatch(/llm_cache_creation_tokens_total\{provider="anthropic"\} \d+/);
  });
});
