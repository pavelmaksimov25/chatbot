import { BadGatewayException } from '@nestjs/common';
import { PingController } from './ping.controller';

describe('PingController', () => {
  const controller = new PingController();

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('hops to api over HTTP and wraps the reply', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ service: 'api', upstream: { service: 'user-service' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(controller.ping()).resolves.toEqual({
      service: 'bff-gateway',
      upstream: { service: 'api', upstream: { service: 'user-service' } },
    });
  });

  it('translates an upstream failure into 502', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response('nope', { status: 500 }));

    await expect(controller.ping()).rejects.toBeInstanceOf(BadGatewayException);
  });
});
