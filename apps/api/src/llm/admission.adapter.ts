import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { Gauge, register } from 'prom-client';
import { FallbackLlmAdapter } from './fallback.adapter';
import { LLM_PROVIDERS } from './llm-adapter';
import type { LlmAdapter, LlmProvider, StreamChatRequest } from './llm-adapter';
import { ProviderLimitsRegistry } from './provider-limits';
import { QueueFullError, Semaphore } from './semaphore';

const DEFAULT_CONCURRENCY = (): number => Number(process.env.LLM_CONCURRENCY_DEFAULT ?? 4);
const MAX_CONCURRENCY = (): number => Number(process.env.LLM_CONCURRENCY_MAX ?? 16);
const QUEUE_MAX = (): number => Number(process.env.LLM_QUEUE_MAX ?? 100);

function gauge(name: string, help: string, labelNames: string[] = []): Gauge {
  return (register.getSingleMetric(name) as Gauge) ?? new Gauge({ name, help, labelNames });
}

/**
 * Admission control around the whole LLM call (see DECISIONS.md, slice 12):
 * a slot is held from dispatch until the stream finishes, the queue gives
 * backpressure, and concurrency rises from DEFAULT toward MAX only while the
 * lead provider's rate-limit headers show fresh headroom.
 */
@Injectable()
export class AdmissionControlledAdapter implements LlmAdapter {
  private readonly semaphore = new Semaphore(DEFAULT_CONCURRENCY(), QUEUE_MAX());

  private readonly inFlightGauge = gauge('llm_in_flight', 'In-flight LLM requests');
  private readonly queuedGauge = gauge('llm_queued', 'LLM requests waiting for a slot');
  private readonly limitGauge = gauge('llm_concurrency_limit', 'Current admission limit');
  private readonly headroomGauge = gauge(
    'llm_provider_requests_remaining',
    'Provider-reported requests remaining (rate-limit headers)',
    ['provider'],
  );

  constructor(
    private readonly inner: FallbackLlmAdapter,
    @Inject(LLM_PROVIDERS) private readonly providers: LlmProvider[],
    private readonly limits: ProviderLimitsRegistry,
  ) {}

  async *streamChat(request: StreamChatRequest): AsyncIterable<string> {
    this.semaphore.setLimit(this.effectiveLimit());
    this.observe();

    let release: () => void;
    try {
      release = await this.semaphore.acquire();
    } catch (err) {
      if (err instanceof QueueFullError) {
        throw new ServiceUnavailableException('the assistant is at capacity — try again shortly');
      }
      throw err;
    }
    this.observe();

    try {
      yield* this.inner.streamChat(request);
    } finally {
      release();
      this.observe();
    }
  }

  /** MAX needs fresh positive header evidence from the lead provider. */
  private effectiveLimit(): number {
    const lead = this.providers.find((p) => p.isConfigured());
    return lead && this.limits.hasHeadroom(lead.name) ? MAX_CONCURRENCY() : DEFAULT_CONCURRENCY();
  }

  private observe(): void {
    this.inFlightGauge.set(this.semaphore.inFlight);
    this.queuedGauge.set(this.semaphore.queued);
    this.limitGauge.set(this.semaphore.currentLimit);
    for (const provider of this.providers) {
      const snapshot = this.limits.snapshot(provider.name);
      if (snapshot?.requestsRemaining !== null && snapshot?.requestsRemaining !== undefined) {
        this.headroomGauge.set({ provider: provider.name }, snapshot.requestsRemaining);
      }
    }
  }
}
