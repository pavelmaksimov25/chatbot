import { Injectable } from '@nestjs/common';

export interface HeadroomSnapshot {
  requestsRemaining: number | null;
  tokensRemaining: number | null;
}

// Below these floors a provider is considered out of headroom — concurrency
// stays at DEFAULT instead of being raised toward MAX.
const LOW_REQUESTS = 2;
const LOW_TOKENS = 10_000;

// Header data older than this is unknown again — headroom requires FRESH
// positive evidence, never optimism.
const FRESHNESS_MS = 60_000;

const DEFAULT_COOLDOWN_MS = 30_000;

/**
 * Shared view of what each provider can take right now (see DECISIONS.md,
 * slice 12). Anthropic/OpenAI seed it from their rate-limit response headers;
 * Gemini has no reliable headers, so it gets a 429-tripped circuit breaker
 * honoring the returned retryDelay.
 */
@Injectable()
export class ProviderLimitsRegistry {
  private readonly headroom = new Map<string, HeadroomSnapshot & { at: number }>();
  private readonly circuitOpenUntil = new Map<string, number>();

  recordHeaders(provider: string, snapshot: HeadroomSnapshot): void {
    this.headroom.set(provider, { ...snapshot, at: Date.now() });
  }

  /** Fresh, positive headroom only — unknown or stale is NOT headroom. */
  hasHeadroom(provider: string): boolean {
    const snapshot = this.headroom.get(provider);
    if (!snapshot || Date.now() - snapshot.at > FRESHNESS_MS) {
      return false;
    }
    const requestsOk =
      snapshot.requestsRemaining === null || snapshot.requestsRemaining > LOW_REQUESTS;
    const tokensOk = snapshot.tokensRemaining === null || snapshot.tokensRemaining > LOW_TOKENS;
    // At least one signal must be present and positive.
    const hasSignal = snapshot.requestsRemaining !== null || snapshot.tokensRemaining !== null;
    return hasSignal && requestsOk && tokensOk;
  }

  trip(provider: string, cooldownMs = DEFAULT_COOLDOWN_MS): void {
    this.circuitOpenUntil.set(provider, Date.now() + cooldownMs);
  }

  /** False while the provider's circuit is open. */
  mayAttempt(provider: string): boolean {
    const until = this.circuitOpenUntil.get(provider);
    return until === undefined || Date.now() >= until;
  }

  snapshot(provider: string): HeadroomSnapshot | undefined {
    const entry = this.headroom.get(provider);
    return entry
      ? { requestsRemaining: entry.requestsRemaining, tokensRemaining: entry.tokensRemaining }
      : undefined;
  }
}

/** Parses Google's RetryInfo delay ("30s", "12.5s") out of a 429 error blob. */
export function parseRetryDelayMs(message: string): number | null {
  const match = /retryDelay['":\s]+['"]?([\d.]+)s/.exec(message);
  return match ? Math.round(parseFloat(match[1]) * 1000) : null;
}

export function headerNumber(headers: Headers, name: string): number | null {
  const raw = headers.get(name);
  if (raw === null) {
    return null;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}
