import { Module } from '@nestjs/common';
import { UserGrpcController } from './user-grpc.controller';

@Module({
  controllers: [UserGrpcController],
})
export class PingModule {}
