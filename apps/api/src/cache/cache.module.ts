import { Inject, Injectable, Module } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

export const VALKEY = 'VALKEY';

/** Closes the client on shutdown so the module, not its consumers, owns the connection. */
@Injectable()
class ValkeyLifecycle implements OnModuleDestroy {
  constructor(@Inject(VALKEY) private readonly valkey: Redis) {}

  async onModuleDestroy(): Promise<void> {
    await this.valkey.quit().catch(() => undefined);
  }
}

@Module({
  providers: [
    {
      provide: VALKEY,
      useFactory: () =>
        new Redis({
          host: process.env.VALKEY_HOST,
          port: Number(process.env.VALKEY_PORT ?? 6379),
          password: process.env.VALKEY_PASSWORD,
          lazyConnect: true,
          maxRetriesPerRequest: 1,
        }),
    },
    ValkeyLifecycle,
  ],
  exports: [VALKEY],
})
export class CacheModule {}
