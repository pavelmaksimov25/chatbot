import { Module } from '@nestjs/common';
import { UserServiceClientModule } from '../grpc/user-service-client.module';
import { PingController } from './ping.controller';

@Module({
  imports: [UserServiceClientModule],
  controllers: [PingController],
})
export class PingModule {}
