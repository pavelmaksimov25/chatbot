import { join } from 'node:path';
import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';

export const USER_SERVICE_GRPC = 'USER_SERVICE_GRPC';

/** Single gRPC channel to user-service, shared by every consumer module. */
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
  exports: [ClientsModule],
})
export class UserServiceClientModule {}
