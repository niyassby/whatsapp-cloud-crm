import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client';

export interface CreatePrismaClientOptions {
  /** Postgres connection string. Runtime code passes DATABASE_URL (the non-owner app role). */
  connectionString: string;
  /** Max pool size for this process. */
  max?: number;
}

/**
 * Every session runs in UTC. A Date bound into raw SQL reaches Postgres without a zone and is read
 * in the session's time zone; a server set to local time (a Windows install, Asia/Calcutta) then
 * moved every cutoff by hours, so stale sends, due SLAs and due flow runs were missed.
 */
const SESSION_OPTIONS = '-c TimeZone=UTC';

export function createPrismaClient({ connectionString, max }: CreatePrismaClientOptions) {
  const adapter = new PrismaPg({ connectionString, max, options: SESSION_OPTIONS });
  return new PrismaClient({ adapter });
}

export type DbClient = ReturnType<typeof createPrismaClient>;
