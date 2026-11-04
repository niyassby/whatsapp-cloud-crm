import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client';

export interface CreatePrismaClientOptions {
  /** Postgres connection string. Runtime code passes DATABASE_URL (the non-owner app role). */
  connectionString: string;
  /** Max pool size for this process. */
  max?: number;
}

export function createPrismaClient({ connectionString, max }: CreatePrismaClientOptions) {
  const adapter = new PrismaPg({ connectionString, max });
  return new PrismaClient({ adapter });
}

export type DbClient = ReturnType<typeof createPrismaClient>;
