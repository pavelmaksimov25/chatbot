import { Module } from '@nestjs/common';
import { ProfileApiClient } from './api-client.service';
import { ProfileController } from './profile.controller';

@Module({
  controllers: [ProfileController],
  providers: [ProfileApiClient],
  exports: [ProfileApiClient],
})
export class ProfileModule {}
