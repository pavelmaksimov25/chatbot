import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { Pool } from 'pg';
import { CacheModule } from '../cache/cache.module';
import { HealthController } from './health.controller';
import { PG_POOL, StoreHealthService } from './store-health.service';

@Module({
  imports: [TerminusModule, CacheModule],
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
    StoreHealthService,
  ],
})
export class HealthModule {}
