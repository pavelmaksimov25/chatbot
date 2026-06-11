import { join } from 'node:path';
import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { PingController, USER_SERVICE_GRPC } from './ping.controller';

@Module({
  imports: [
    ClientsModule.register([
      {
        name: USER_SERVICE_GRPC,
        transport: Transport.GRPC,
        options: {
          package: 'user.v1',
          protoPath: join(__dirname, '../proto/user.proto'),
          url: process.env.USER_SERVICE_GRPC_URL ?? 'localhost:50051',
        },
      },
    ]),
  ],
  controllers: [PingController],
})
export class PingModule {}
