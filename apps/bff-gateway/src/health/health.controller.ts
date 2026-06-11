import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import type { HealthCheckResult } from '@nestjs/terminus';
import { StoreHealthService } from './store-health.service';

const SERVICE_NAME = 'bff-gateway';

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

  // Readiness: this service's OWN store is reachable (session/rate-limit cache).
  @Get('ready')
  @HealthCheck()
  ready(): Promise<HealthCheckResult> {
    return this.health.check([() => this.stores.valkey()]);
  }
}
