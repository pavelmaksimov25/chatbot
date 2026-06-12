import { Module } from '@nestjs/common';
import type { MiddlewareConsumer, NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { AuthModule } from './auth/auth.module';
import { CsrfGuard } from './auth/csrf.guard';
import { SessionService } from './auth/session.service';
import { ChatModule } from './chat/chat.module';
import { FilesModule } from './files/files.module';
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
    AuthModule,
    ChatModule,
    FilesModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: CsrfGuard }],
})
export class AppModule implements NestModule {
  constructor(private readonly sessionService: SessionService) {}

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(this.sessionService.middleware).forRoutes('{*splat}');
  }
}
