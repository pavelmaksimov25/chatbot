import './telemetry';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { Transport } from '@nestjs/microservices';
import type { MicroserviceOptions } from '@nestjs/microservices';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const logger = app.get(Logger);
  app.useLogger(logger);
  app.enableShutdownHooks();

  const grpcPort = Number(process.env.GRPC_PORT ?? 50051);
  app.connectMicroservice<MicroserviceOptions>(
    {
      transport: Transport.GRPC,
      options: {
        package: 'user.v1',
        protoPath: join(__dirname, 'proto/user.proto'),
        url: `0.0.0.0:${grpcPort}`,
      },
    },
    { inheritAppConfig: true },
  );
  await app.startAllMicroservices();

  const port = Number(process.env.PORT ?? 3002);
  await app.listen(port);
  logger.log(`user-service listening on :${port} (gRPC on :${grpcPort})`);
}

void bootstrap();
