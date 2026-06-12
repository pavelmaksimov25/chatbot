import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { HealthIndicatorService } from '@nestjs/terminus';
import type { HealthIndicatorResult } from '@nestjs/terminus';
import { Pool } from 'pg';
import Redis from 'ioredis';
import { PG_POOL } from '../db/db.module';

export { PG_POOL };
export const VALKEY = 'VALKEY';

@Injectable()
export class StoreHealthService implements OnModuleDestroy {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(VALKEY) private readonly valkeyClient: Redis,
    private readonly indicator: HealthIndicatorService,
  ) {}

  async onModuleDestroy(): Promise<void> {
    // The pool belongs to DbModule; only the valkey probe client is ours.
    await this.valkeyClient.quit().catch(() => undefined);
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
