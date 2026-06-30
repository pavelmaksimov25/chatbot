import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ExportRepository } from './export.repository';

/**
 * Slice 18a foundation: just the data-access layer for now. Later sub-issues
 * add the renderers (18b), the BullMQ job + HTTP endpoints (18c), and wire
 * FileService in to persist rendered bytes.
 */
@Module({
  imports: [PrismaModule],
  providers: [ExportRepository],
  exports: [ExportRepository],
})
export class ExportsModule {}
