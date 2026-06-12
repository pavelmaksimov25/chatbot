import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module';
import { ProfileGrpcController } from './profile-grpc.controller';
import { ProfileRepository } from './profile.repository';

@Module({
  imports: [DbModule],
  controllers: [ProfileGrpcController],
  providers: [ProfileRepository],
})
export class ProfileModule {}
