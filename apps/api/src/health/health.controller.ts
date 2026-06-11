import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import type { HealthCheckResult } from '@nestjs/terminus';
import { StoreHealthService } from './store-health.service';

const SERVICE_NAME = 'api';

export interface HealthStatus {
  status: 'ok';
  service: string;
}

@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly stores: StoreHealthService,
  ) {}

  // Liveness: the process is up. Never checks stores — a store outage must
  // not restart app pods.
  @Get()
  live(): HealthStatus {
    return { status: 'ok', service: SERVICE_NAME };
  }

  // Readiness: this service's OWN stores are reachable.
  @Get('ready')
  @HealthCheck()
  ready(): Promise<HealthCheckResult> {
    return this.health.check([
      () => this.stores.postgres(),
      () => this.stores.valkey(),
      () => this.stores.minio(),
      () => this.stores.vault(),
    ]);
  }
}
