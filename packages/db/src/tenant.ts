import { z } from 'zod';
import type { Prisma, PrismaClient } from './generated/prisma/client';

/** Transaction client handed to callbacks. All queries on it run under RLS context. */
export type TenantTx = Prisma.TransactionClient;

export interface DbContext {
  /** Current tenant. Required for anything that touches tenant tables. */
  orgId?: string;
  /** Authenticated user. Lets the user read their own memberships across orgs. */
  userId?: string;
  /** Reseller context: a partner acting on its own rows and its clients. */
  partnerId?: string;
  /**
   * Ask for platform-admin access. It only opens anything when `userId` also has a
   * platform_admins row, which Postgres checks; the flag alone does nothing.
   */
  platformAdmin?: boolean;
}

export interface TransactionOptions {
  maxWait?: number;
  timeout?: number;
  isolationLevel?: Prisma.TransactionIsolationLevel;
}

const contextSchema = z.object({
  orgId: z.uuid().optional(),
  userId: z.uuid().optional(),
  partnerId: z.uuid().optional(),
  platformAdmin: z.boolean().optional(),
});

export class InvalidDbContextError extends Error {
  readonly code = 'DB_INVALID_CONTEXT';
  constructor(message: string) {
    super(message);
    this.name = 'InvalidDbContextError';
  }
}

type TransactionCapable = Pick<PrismaClient, '$transaction'>;

/**
 * How long a transaction may wait for a free connection. Prisma's default of 2 seconds turned a
 * short burst of traffic into server errors, when waiting a little longer would have worked.
 */
const DEFAULT_MAX_WAIT_MS = 10_000;

/**
 * Run `fn` in a transaction with the given RLS context applied via
 * set_config(name, value, is_local => true), which is equivalent to SET LOCAL:
 * the settings vanish when the transaction ends, so pooled connections never leak a tenant.
 */
export async function withDbContext<T>(
  client: TransactionCapable,
  context: DbContext,
  fn: (tx: TenantTx) => Promise<T>,
  options?: TransactionOptions,
): Promise<T> {
  const parsed = contextSchema.safeParse(context);
  if (!parsed.success) {
    throw new InvalidDbContextError('DB context ids must be UUIDs');
  }
  const { orgId = '', userId = '', partnerId = '' } = parsed.data;
  const platformAdmin = parsed.data.platformAdmin ? 'on' : '';

  return client.$transaction(
    async (tx) => {
      await tx.$queryRaw`
      SELECT set_config('app.org_id', ${orgId}, true),
             set_config('app.user_id', ${userId}, true),
             set_config('app.partner_id', ${partnerId}, true),
             set_config('app.platform_admin', ${platformAdmin}, true)`;
      return fn(tx);
    },
    { maxWait: DEFAULT_MAX_WAIT_MS, ...options },
  );
}

/** Like withDbContext, but an org is mandatory. Use this for all tenant-scoped work. */
export async function withTenant<T>(
  client: TransactionCapable,
  context: DbContext & { orgId: string },
  fn: (tx: TenantTx) => Promise<T>,
  options?: TransactionOptions,
): Promise<T> {
  if (!context.orgId) {
    throw new InvalidDbContextError('withTenant requires an orgId');
  }
  return withDbContext(client, context, fn, options);
}
