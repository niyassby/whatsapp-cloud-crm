import { Controller, Get } from '@nestjs/common';
import { buildHealth, type HealthResponse } from '@wacrm/shared';

@Controller('health')
export class HealthController {
  @Get()
  check(): HealthResponse {
    return buildHealth('api');
  }
}
