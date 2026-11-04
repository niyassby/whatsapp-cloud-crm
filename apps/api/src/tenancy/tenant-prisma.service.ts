import { Injectable } from '@nestjs/common';
import { type TenantTx, type TransactionOptions, withDbContext, withTenant } from '@wacrm/db';
import { AppError, ErrorCode } from '@wacrm/shared';
import { PrismaService } from '../db/prisma.service';
import { requestContext } from './request-context';

/**
 * The only way app code should touch tenant tables.
 *
 * Each call opens a short transaction and applies SET LOCAL app.org_id / app.user_id from the
 * current request context, so Postgres RLS scopes every query (Prisma or raw) to the tenant.
 * Keep units of work small: never await external HTTP calls inside `run`.
 */
@Injectable()
export class TenantPrismaService {
  constructor(private readonly prisma: PrismaService) {}

  /** Run tenant-scoped work. Requires an organization in context. */
  run<T>(fn: (tx: TenantTx) => Promise<T>, options?: TransactionOptions): Promise<T> {
    const ctx = requestContext.get();
    if (!ctx?.orgId) {
      throw new AppError(ErrorCode.TENANT_CONTEXT_MISSING, 'An organization context is required');
    }
    return withTenant(
      this.prisma.client,
      { orgId: ctx.orgId, userId: ctx.userId, partnerId: ctx.partnerId },
      fn,
      options,
    );
  }

  /**
   * Run user-scoped work with no organization (e.g. listing the user's orgs for the switcher).
   * RLS only exposes the user's own rows.
   */
  runAsUser<T>(fn: (tx: TenantTx) => Promise<T>, options?: TransactionOptions): Promise<T> {
    const ctx = requestContext.get();
    if (!ctx?.userId) {
      throw new AppError(ErrorCode.UNAUTHENTICATED, 'An authenticated user is required');
    }
    return withDbContext(this.prisma.client, { userId: ctx.userId }, fn, options);
  }
}
