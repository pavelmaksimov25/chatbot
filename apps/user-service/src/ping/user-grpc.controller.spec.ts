import { Test } from '@nestjs/testing';
import { PinoLogger } from 'nestjs-pino';
import { UserGrpcController } from './user-grpc.controller';

describe('UserGrpcController', () => {
  it('answers ping with the service name', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [UserGrpcController],
      providers: [
        { provide: PinoLogger, useValue: { info: jest.fn(), setContext: jest.fn() } },
      ],
    }).compile();
    const controller = moduleRef.get(UserGrpcController);
    expect(controller.ping()).toEqual({ service: 'user-service' });
  });
});
