import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { ChatModule } from './chat/chat.module';
import { FileModule } from './files/file.module';
import { HealthModule } from './health/health.module';
import { MetricsModule } from './metrics/metrics.module';
import { PingModule } from './ping/ping.module';
import { ProfileModule } from './profile/profile.module';

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
    ChatModule,
    FileModule,
    HealthModule,
    MetricsModule,
    PingModule,
    ProfileModule,
  ],
})
export class AppModule {}
