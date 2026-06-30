import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import Redis from 'ioredis';
import { PrismaModule } from '../prisma/prisma.module';
import { HealthController } from './health.controller';
import { VALKEY, StoreHealthService } from './store-health.service';

@Module({
  imports: [TerminusModule, PrismaModule],
  controllers: [HealthController],
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
    StoreHealthService,
  ],
})
export class HealthModule {}
