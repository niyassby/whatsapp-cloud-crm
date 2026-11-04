import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { createPrismaClient, type DbClient } from '@wacrm/db';
import { API_ENV, type ApiEnv } from '../env';

/**
 * Owns the process-wide Prisma client (app role, RLS applies).
 * Do not query tenant tables on `client` directly; use TenantPrismaService.
 */
@Injectable()
export class PrismaService implements OnModuleDestroy {
  readonly client: DbClient;

  constructor(@Inject(API_ENV) env: ApiEnv) {
    this.client = createPrismaClient({
      connectionString: env.DATABASE_URL,
      max: env.DATABASE_POOL_MAX,
    });
  }

  /** Liveness of the database connection. Touches no tables. */
  async ping(): Promise<void> {
    await this.client.$queryRaw`SELECT 1`;
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
  }
}
