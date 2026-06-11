import { of } from 'rxjs';
import type { ClientGrpc } from '@nestjs/microservices';
import { PingController } from './ping.controller';

describe('PingController', () => {
  it('hops to user-service over gRPC and wraps the reply', async () => {
    const client = {
      getService: () => ({ ping: () => of({ service: 'user-service' }) }),
    } as unknown as ClientGrpc;

    const controller = new PingController(client);
    controller.onModuleInit();

    await expect(controller.ping()).resolves.toEqual({
      service: 'api',
      upstream: { service: 'user-service' },
    });
  });
});
