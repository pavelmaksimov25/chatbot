import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { HealthIndicatorService } from '@nestjs/terminus';
import type { HealthIndicatorResult } from '@nestjs/terminus';
import Redis from 'ioredis';

export const VALKEY = 'VALKEY';

@Injectable()
export class StoreHealthService implements OnModuleDestroy {
  constructor(
    @Inject(VALKEY) private readonly valkeyClient: Redis,
    private readonly indicator: HealthIndicatorService,
  ) {}

  async onModuleDestroy(): Promise<void> {
    await this.valkeyClient.quit().catch(() => undefined);
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
