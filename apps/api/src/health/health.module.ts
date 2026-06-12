import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { CacheModule } from '../cache/cache.module';
import { DbModule } from '../db/db.module';
import { HealthController } from './health.controller';
import { StoreHealthService } from './store-health.service';

@Module({
  imports: [TerminusModule, CacheModule, DbModule],
  controllers: [HealthController],
  providers: [StoreHealthService],
})
export class HealthModule {}
