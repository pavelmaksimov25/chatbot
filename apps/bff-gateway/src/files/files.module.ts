import { Module } from '@nestjs/common';
import { FilesProxyController } from './files-proxy.controller';

@Module({
  controllers: [FilesProxyController],
})
export class FilesModule {}
