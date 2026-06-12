import { ProviderLimitsRegistry, parseRetryDelayMs } from './provider-limits';

describe('ProviderLimitsRegistry', () => {
  let registry: ProviderLimitsRegistry;

  beforeEach(() => {
    registry = new ProviderLimitsRegistry();
    jest.useFakeTimers({ now: 1_000_000 });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('headroom', () => {
    it('is NOT assumed when nothing has been recorded', () => {
      expect(registry.hasHeadroom('anthropic')).toBe(false);
    });

    it('is granted on fresh positive header evidence', () => {
      registry.recordHeaders('anthropic', { requestsRemaining: 50, tokensRemaining: 80_000 });
      expect(registry.hasHeadroom('anthropic')).toBe(true);
    });

    it('is denied when requests run low', () => {
      registry.recordHeaders('anthropic', { requestsRemaining: 1, tokensRemaining: 80_000 });
      expect(registry.hasHeadroom('anthropic')).toBe(false);
    });

    it('is denied when tokens run low', () => {
      registry.recordHeaders('anthropic', { requestsRemaining: 50, tokensRemaining: 500 });
      expect(registry.hasHeadroom('anthropic')).toBe(false);
    });

    it('expires — stale evidence is unknown again', () => {
      registry.recordHeaders('anthropic', { requestsRemaining: 50, tokensRemaining: 80_000 });
      jest.advanceTimersByTime(61_000);
      expect(registry.hasHeadroom('anthropic')).toBe(false);
    });

    it('requires at least one concrete signal', () => {
      registry.recordHeaders('anthropic', { requestsRemaining: null, tokensRemaining: null });
      expect(registry.hasHeadroom('anthropic')).toBe(false);
    });
  });

  describe('circuit breaker', () => {
    it('allows attempts by default', () => {
      expect(registry.mayAttempt('gemini')).toBe(true);
    });

    it('blocks while tripped and recovers after the cooldown', () => {
      registry.trip('gemini', 5_000);
      expect(registry.mayAttempt('gemini')).toBe(false);
      jest.advanceTimersByTime(5_001);
      expect(registry.mayAttempt('gemini')).toBe(true);
    });
  });
});

describe('parseRetryDelayMs', () => {
  it('parses the RetryInfo delay out of a Google 429 blob', () => {
    const blob =
      '{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"30s"}]}}';
    expect(parseRetryDelayMs(blob)).toBe(30_000);
  });

  it('parses fractional seconds', () => {
    expect(parseRetryDelayMs('retryDelay: "12.5s"')).toBe(12_500);
  });

  it('returns null when no delay is present', () => {
    expect(parseRetryDelayMs('plain old overload message')).toBeNull();
  });
});
