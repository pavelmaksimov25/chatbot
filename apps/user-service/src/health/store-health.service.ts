import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { HealthIndicatorService } from '@nestjs/terminus';
import type { HealthIndicatorResult } from '@nestjs/terminus';
import Redis from 'ioredis';
import { PrismaService } from '../prisma/prisma.service';

export const VALKEY = 'VALKEY';

@Injectable()
export class StoreHealthService implements OnModuleDestroy {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(VALKEY) private readonly valkeyClient: Redis,
    private readonly indicator: HealthIndicatorService,
  ) {}

  async onModuleDestroy(): Promise<void> {
    // The Prisma connection belongs to PrismaModule; only the valkey probe
    // client is ours to close.
    await this.valkeyClient.quit().catch(() => undefined);
  }

  postgres(): Promise<HealthIndicatorResult> {
    return this.probe('postgres', async () => {
      await this.prisma.$queryRaw`SELECT 1`;
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
