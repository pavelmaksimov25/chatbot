import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { FileController } from './file.controller';
import { FileRepository } from './file.repository';
import { FileService } from './file.service';
import { ObjectStoreService } from './object-store.service';
import { VaultTransitService } from './vault-transit.service';

@Module({
  imports: [PrismaModule],
  controllers: [FileController],
  providers: [FileService, FileRepository, ObjectStoreService, VaultTransitService],
  exports: [FileService],
})
export class FileModule {}
