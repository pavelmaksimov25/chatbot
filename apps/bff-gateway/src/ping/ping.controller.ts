import { BadGatewayException, Controller, Get } from '@nestjs/common';

const SERVICE_NAME = 'bff-gateway';

export interface PingResult {
  service: string;
  upstream?: PingResult;
}

@Controller('ping')
export class PingController {
  @Get()
  async ping(): Promise<PingResult> {
    const apiUrl = process.env.API_URL ?? 'http://localhost:3001';
    const res = await fetch(`${apiUrl}/ping`);
    if (!res.ok) {
      throw new BadGatewayException(`api ping returned ${res.status}`);
    }
    const upstream = (await res.json()) as PingResult;
    return { service: SERVICE_NAME, upstream };
  }
}
