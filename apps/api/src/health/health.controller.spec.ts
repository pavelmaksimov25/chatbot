import { Test } from '@nestjs/testing';
import { TerminusModule } from '@nestjs/terminus';
import type { HealthIndicatorResult } from '@nestjs/terminus';
import { HealthController } from './health.controller';
import { StoreHealthService } from './store-health.service';

const up = (key: string): Promise<HealthIndicatorResult> =>
  Promise.resolve({ [key]: { status: 'up' } });
const down = (key: string): Promise<HealthIndicatorResult> =>
  Promise.resolve({ [key]: { status: 'down', message: 'unreachable' } });

async function controllerWith(stores: Partial<StoreHealthService>): Promise<HealthController> {
  const moduleRef = await Test.createTestingModule({
    imports: [TerminusModule],
    controllers: [HealthController],
    providers: [{ provide: StoreHealthService, useValue: stores }],
  }).compile();
  return moduleRef.get(HealthController);
}

describe('HealthController', () => {
  it('liveness reports ok without touching stores', async () => {
    const controller = await controllerWith({});
    expect(controller.live()).toEqual({ status: 'ok', service: 'api' });
  });

  it('readiness is ok when all own stores are reachable', async () => {
    const controller = await controllerWith({
      postgres: () => up('postgres'),
      valkey: () => up('valkey'),
      minio: () => up('minio'),
      vault: () => up('vault'),
    });
    const result = await controller.ready();
    expect(result.status).toBe('ok');
    expect(Object.keys(result.info ?? {})).toEqual(
      expect.arrayContaining(['postgres', 'valkey', 'minio', 'vault']),
    );
  });

  it('readiness fails when a store is down', async () => {
    const controller = await controllerWith({
      postgres: () => down('postgres'),
      valkey: () => up('valkey'),
      minio: () => up('minio'),
      vault: () => up('vault'),
    });
    await expect(controller.ready()).rejects.toMatchObject({
      response: expect.objectContaining({ status: 'error' }),
    });
  });
});
