import { Inject, Injectable, Module } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';

export const PG_POOL = 'PG_POOL';

/** Closes the pool on shutdown so the module, not its consumers, owns the connection. */
@Injectable()
class PoolLifecycle implements OnModuleDestroy {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async onModuleDestroy(): Promise<void> {
    await this.pool.end().catch(() => undefined);
  }
}

@Module({
  providers: [
    {
      provide: PG_POOL,
      useFactory: () =>
        new Pool({
          host: process.env.DB_HOST,
          port: Number(process.env.DB_PORT ?? 5432),
          user: process.env.DB_USER,
          password: process.env.DB_PASSWORD,
          database: process.env.DB_NAME,
          max: 5,
          connectionTimeoutMillis: 2000,
        }),
    },
    PoolLifecycle,
  ],
  exports: [PG_POOL],
})
export class DbModule {}
