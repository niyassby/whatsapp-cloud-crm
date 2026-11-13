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

  /**
   * Run as the partner or platform admin of the current request (@PartnerRoute /
   * @PlatformAdminRoute). RLS shows the partner its own rows and its clients' workspaces, and a
   * platform admin everything those policies name. Tenant tables stay closed: no org is set.
   */
  runAsOperator<T>(fn: (tx: TenantTx) => Promise<T>, options?: TransactionOptions): Promise<T> {
    return withDbContext(this.prisma.client, this.operator(), fn, options);
  }

  /**
   * Run inside one workspace on behalf of the partner or platform admin of the current request.
   * The workspace is checked first, in the same transaction and under RLS: a partner only finds
   * its own clients, so naming someone else's workspace is NOT_FOUND before anything is read.
   */
  runInWorkspace<T>(
    orgId: string,
    fn: (tx: TenantTx) => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T> {
    const operator = this.operator();
    return withTenant(
      this.prisma.client,
      { ...operator, orgId },
      async (tx) => {
        const org = await tx.organization.findFirst({
          where: {
            id: orgId,
            deletedAt: null,
            ...(operator.platformAdmin ? {} : { partnerId: operator.partnerId }),
          },
          select: { id: true },
        });
        if (!org) throw new AppError(ErrorCode.NOT_FOUND, 'Workspace not found');
        return fn(tx);
      },
      options,
    );
  }

  private operator(): { userId: string; partnerId?: string; platformAdmin?: boolean } {
    const ctx = requestContext.get();
    if (!ctx?.userId || (!ctx.partnerId && !ctx.platformAdmin)) {
      throw new AppError(ErrorCode.FORBIDDEN, 'A partner or platform admin is required');
    }
    return ctx.platformAdmin
      ? { userId: ctx.userId, platformAdmin: true }
      : { userId: ctx.userId, partnerId: ctx.partnerId };
  }
}
