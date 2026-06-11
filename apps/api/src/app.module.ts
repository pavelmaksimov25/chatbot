import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { HealthModule } from './health/health.module';
import { MetricsModule } from './metrics/metrics.module';
import { PingModule } from './ping/ping.module';

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? 'info',
        autoLogging: {
          ignore: (req) => req.url === '/metrics' || (req.url ?? '').startsWith('/health'),
        },
      },
    }),
    HealthModule,
    MetricsModule,
    PingModule,
  ],
})
export class AppModule {}
