import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { HealthIndicatorService } from '@nestjs/terminus';
import type { HealthIndicatorResult } from '@nestjs/terminus';
import { Pool } from 'pg';
import Redis from 'ioredis';
import { VALKEY } from '../cache/cache.module';

export const PG_POOL = 'PG_POOL';
export { VALKEY };

const PROBE_TIMEOUT_MS = 2000;

@Injectable()
export class StoreHealthService implements OnModuleDestroy {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(VALKEY) private readonly valkeyClient: Redis,
    private readonly indicator: HealthIndicatorService,
  ) {}

  async onModuleDestroy(): Promise<void> {
    // The valkey client belongs to CacheModule; only the pool is ours.
    await this.pool.end().catch(() => undefined);
  }

  postgres(): Promise<HealthIndicatorResult> {
    return this.probe('postgres', async () => {
      await this.pool.query('SELECT 1');
    });
  }

  valkey(): Promise<HealthIndicatorResult> {
    return this.probe('valkey', async () => {
      await this.valkeyClient.ping();
    });
  }

  minio(): Promise<HealthIndicatorResult> {
    return this.probe('minio', () =>
      this.httpOk(`${process.env.MINIO_ENDPOINT}/minio/health/ready`),
    );
  }

  vault(): Promise<HealthIndicatorResult> {
    return this.probe('vault', () => this.httpOk(`${process.env.VAULT_ADDR}/v1/sys/health`));
  }

  private async httpOk(url: string): Promise<void> {
    const res = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!res.ok) {
      throw new Error(`unexpected status ${res.status}`);
    }
  }

  private async probe(key: string, check: () => Promise<void>): Promise<HealthIndicatorResult> {
    const result = this.indicator.check(key);
    try {
      await check();
      return result.up();
    } catch (err) {
      return result.down({ message: err instanceof Error ? err.message : String(err) });
    }
  }
}
