import { Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/** Replaces the old hand-rolled DbModule/PG_POOL — the single DB entrypoint. */
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
