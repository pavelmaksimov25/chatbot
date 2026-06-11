import { Module } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import { collectDefaultMetrics, register } from 'prom-client';
import { MetricsController } from './metrics.controller';

@Module({
  controllers: [MetricsController],
})
export class MetricsModule implements OnModuleInit {
  onModuleInit(): void {
    // Guard against double registration (watch-mode restarts, test reuse).
    if (register.getSingleMetric('process_cpu_user_seconds_total') === undefined) {
      collectDefaultMetrics();
    }
  }
}
