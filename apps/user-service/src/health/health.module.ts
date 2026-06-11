import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { Pool } from 'pg';
import Redis from 'ioredis';
import { HealthController } from './health.controller';
import { PG_POOL, VALKEY, StoreHealthService } from './store-health.service';

@Module({
  imports: [TerminusModule],
  controllers: [HealthController],
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
          max: 2,
          connectionTimeoutMillis: 2000,
        }),
    },
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
    StoreHealthService,
  ],
})
export class HealthModule {}
