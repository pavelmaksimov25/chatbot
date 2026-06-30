import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ProfileGrpcController } from './profile-grpc.controller';
import { ProfileRepository } from './profile.repository';

@Module({
  imports: [PrismaModule],
  controllers: [ProfileGrpcController],
  providers: [ProfileRepository],
})
export class ProfileModule {}
