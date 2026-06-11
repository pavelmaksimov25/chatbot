import './telemetry';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  // Behind Caddy: respect X-Forwarded-Proto so secure cookies engage over TLS.
  app.set('trust proxy', 1);
  const logger = app.get(Logger);
  app.useLogger(logger);
  app.enableShutdownHooks();
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  logger.log(`bff-gateway listening on :${port}`);
}

void bootstrap();
