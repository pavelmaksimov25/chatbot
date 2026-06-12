import { Controller, Get, Inject } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import type { ClientGrpc } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';
import type { Observable } from 'rxjs';
import { USER_SERVICE_GRPC } from '../grpc/user-service-client.module';

export interface PingReply {
  service: string;
}

interface UserServiceClient {
  ping(request: Record<string, never>): Observable<PingReply>;
}

export interface PingResult {
  service: string;
  upstream: PingReply;
}

@Controller('ping')
export class PingController implements OnModuleInit {
  private userService!: UserServiceClient;

  constructor(@Inject(USER_SERVICE_GRPC) private readonly client: ClientGrpc) {}

  onModuleInit(): void {
    this.userService = this.client.getService<UserServiceClient>('UserService');
  }

  @Get()
  async ping(): Promise<PingResult> {
    const upstream = await firstValueFrom(this.userService.ping({}));
    return { service: 'api', upstream };
  }
}
