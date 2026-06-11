import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  const port = Number(process.env.PORT ?? 3002);
  await app.listen(port);
  console.log(`user-service listening on :${port}`);
}

void bootstrap();
