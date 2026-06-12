import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module';
import { AuditProcessor } from './audit.processor';
import { AuditService, OUTPUT_AUDIT_QUEUE } from './audit.service';

@Module({
  imports: [
    // BullMQ rides the existing Valkey. maxRetriesPerRequest must be null
    // for blocking worker connections (BullMQ requirement). Async so env is
    // read at bootstrap, not at module-file import.
    BullModule.forRootAsync({
      useFactory: () => ({
        connection: {
          host: process.env.VALKEY_HOST ?? 'localhost',
          port: Number(process.env.VALKEY_PORT ?? 6379),
          password: process.env.VALKEY_PASSWORD || undefined,
          maxRetriesPerRequest: null,
        },
      }),
    }),
    BullModule.registerQueue({ name: OUTPUT_AUDIT_QUEUE }),
    DbModule,
  ],
  providers: [AuditService, AuditProcessor],
  exports: [AuditService],
})
export class AuditModule {}
