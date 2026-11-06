import { randomUUID } from 'node:crypto';
import { Body, Controller, Get, Patch, Post, Query } from '@nestjs/common';
import { withTenant, startTrial } from '@wacrm/db';
import {
  type AuditLogDto,
  type CreateOrgInput,
  createOrgSchema,
  type CursorPage,
  type CursorQuery,
  cursorQuerySchema,
  type OrgSummary,
  Permission,
  type UpdateOrgInput,
  updateOrgSchema,
} from '@wacrm/shared';
import { AuditAction, AuditService } from '../audit/audit.service';
import { slugify } from '../auth/auth.service';
import { CurrentAuth, RequirePermission } from '../auth/decorators';
import { Meta, type RequestMeta } from '../common/request-meta';
import { zod } from '../common/zod.pipe';
import { PrismaService } from '../db/prisma.service';
import type { AuthContext } from '../tenancy/request-context';
import { SkipTenant } from '../tenancy/skip-tenant.decorator';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service';
import { decodeCursor, encodeCursor } from './cursor';

export interface OrgDto {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  createdAt: string;
}

@Controller('orgs')
export class OrgsController {
  constructor(
    private readonly db: TenantPrismaService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Create another workspace; the caller becomes its owner. Switch to it with /auth/switch-org. */
  @SkipTenant()
  @Post()
  async create(
    @CurrentAuth() auth: AuthContext,
    @Body(zod(createOrgSchema)) body: CreateOrgInput,
    @Meta() meta: RequestMeta,
  ): Promise<OrgSummary> {
    const orgId = randomUUID();
    return withTenant(this.prisma.client, { orgId, userId: auth.userId }, async (tx) => {
      const org = await tx.organization.create({
        data: { id: orgId, name: body.name, slug: slugify(body.name) },
      });
      await tx.membership.create({ data: { orgId, userId: auth.userId, role: 'owner' } });
      await startTrial(tx, orgId);
      await this.audit.record(tx, orgId, {
        action: AuditAction.ORG_CREATED,
        actorUserId: auth.userId,
        meta,
      });
      return { id: org.id, name: org.name, slug: org.slug, role: 'owner' as const };
    });
  }

  @Get('current')
  @RequirePermission(Permission.ORG_READ)
  async current(@CurrentAuth() auth: AuthContext): Promise<OrgDto> {
    const org = await this.db.run((tx) =>
      tx.organization.findUniqueOrThrow({ where: { id: auth.orgId } }),
    );
    return toOrgDto(org);
  }

  @Patch('current')
  @RequirePermission(Permission.ORG_UPDATE)
  async update(
    @CurrentAuth() auth: AuthContext,
    @Body(zod(updateOrgSchema)) body: UpdateOrgInput,
    @Meta() meta: RequestMeta,
  ): Promise<OrgDto> {
    const org = await this.db.run(async (tx) => {
      const updated = await tx.organization.update({ where: { id: auth.orgId }, data: body });
      await this.audit.record(tx, updated.id, {
        action: AuditAction.ORG_UPDATED,
        actorUserId: auth.userId,
        metadata: body,
        meta,
      });
      return updated;
    });
    return toOrgDto(org);
  }

  /** Newest first, keyset (cursor) pagination. */
  @Get('current/audit-logs')
  @RequirePermission(Permission.AUDIT_READ)
  async auditLogs(
    @Query(zod(cursorQuerySchema)) query: CursorQuery,
  ): Promise<CursorPage<AuditLogDto>> {
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    const rows = await this.db.run((tx) =>
      tx.auditLog.findMany({
        where: cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }
          : undefined,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
        include: { actorUser: { select: { name: true } } },
      }),
    );
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      items: page.map((r) => ({
        id: r.id,
        action: r.action,
        actorUserId: r.actorUserId,
        actorName: r.actorUser?.name ?? null,
        targetType: r.targetType,
        targetId: r.targetId,
        metadata: r.metadata,
        ip: r.ip,
        createdAt: r.createdAt.toISOString(),
      })),
      nextCursor: rows.length > query.limit && last ? encodeCursor(last) : null,
    };
  }
}

function toOrgDto(o: {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  createdAt: Date;
}): OrgDto {
  return {
    id: o.id,
    name: o.name,
    slug: o.slug,
    timezone: o.timezone,
    createdAt: o.createdAt.toISOString(),
  };
}
