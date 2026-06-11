import { Controller, Get } from '@nestjs/common';

const SERVICE_NAME = 'user-service';

export interface HealthStatus {
  status: 'ok';
  service: string;
}

@Controller('health')
export class HealthController {
  @Get()
  health(): HealthStatus {
    return { status: 'ok', service: SERVICE_NAME };
  }
}
