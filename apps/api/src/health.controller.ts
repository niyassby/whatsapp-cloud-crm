import { Controller, Get } from '@nestjs/common';
import { buildHealth, type HealthResponse } from '@wacrm/shared';
import { PrismaService } from './db/prisma.service';
import { SkipTenant } from './tenancy/skip-tenant.decorator';

@SkipTenant()
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  /** Liveness: the process is up. */
  @Get()
  check(): HealthResponse {
    return buildHealth('api');
  }

  /** Readiness: dependencies (database) are reachable. */
  @Get('ready')
  async ready(): Promise<HealthResponse> {
    await this.prisma.ping();
    return buildHealth('api');
  }
}
