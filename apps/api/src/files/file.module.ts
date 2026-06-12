import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module';
import { FileController } from './file.controller';
import { FileRepository } from './file.repository';
import { FileService } from './file.service';
import { ObjectStoreService } from './object-store.service';
import { VaultTransitService } from './vault-transit.service';

@Module({
  imports: [DbModule],
  controllers: [FileController],
  providers: [FileService, FileRepository, ObjectStoreService, VaultTransitService],
  exports: [FileService],
})
export class FileModule {}
