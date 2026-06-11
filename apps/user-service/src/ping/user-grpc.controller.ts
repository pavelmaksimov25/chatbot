import { Controller } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { PinoLogger } from 'nestjs-pino';

export interface PingReply {
  service: string;
}

@Controller()
export class UserGrpcController {
  constructor(private readonly logger: PinoLogger) {
    this.logger.setContext(UserGrpcController.name);
  }

  @GrpcMethod('UserService', 'Ping')
  ping(): PingReply {
    // pino-http only covers HTTP — log gRPC calls explicitly so they carry
    // the trace id too.
    this.logger.info('grpc ping');
    return { service: 'user-service' };
  }
}
