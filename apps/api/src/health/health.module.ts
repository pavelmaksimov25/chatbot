import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { CacheModule } from '../cache/cache.module';
import { PrismaModule } from '../prisma/prisma.module';
import { HealthController } from './health.controller';
import { StoreHealthService } from './store-health.service';

@Module({
  imports: [TerminusModule, CacheModule, PrismaModule],
  controllers: [HealthController],
  providers: [StoreHealthService],
})
export class HealthModule {}
