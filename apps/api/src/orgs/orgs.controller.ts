import { randomUUID } from 'node:crypto';
import { Body, Controller, Get, Logger, Patch, Post, Query, Res } from '@nestjs/common';
import { withTenant, startTrial } from '@wacrm/db';
import {
  type AuditLogDto,
  type CreateOrgInput,
  createOrgSchema,
  AUDIT_EXPORT_MAX_ROWS,
  type AuditExportQuery,
  auditDateBounds,
  auditExportSchema,
  type AuditQuery,
  auditQuerySchema,
  auditToCsv,
  type CursorPage,
  type OrgSummary,
  Permission,
  type UpdateOrgInput,
  updateOrgSchema,
} from '@wacrm/shared';
import type { FastifyReply } from 'fastify';
import { AuditAction, AuditService } from '../audit/audit.service';
import { slugify } from '../auth/auth.service';
import { CurrentAuth, RequirePermission } from '../auth/decorators';
import { Meta, type RequestMeta } from '../common/request-meta';
import { zod } from '../common/zod.pipe';
import { PrismaService } from '../db/prisma.service';
import { QueuesService } from '../infra/queues.service';
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
    private readonly queues: QueuesService,
  ) {}

  private readonly logger = new Logger(OrgsController.name);

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
    let timezoneChanged = false;
    const org = await this.db.run(async (tx) => {
      const before = await tx.organization.findUniqueOrThrow({
        where: { id: auth.orgId },
        select: { timezone: true },
      });
      const updated = await tx.organization.update({ where: { id: auth.orgId }, data: body });
      timezoneChanged = before.timezone !== updated.timezone;
      await this.audit.record(tx, updated.id, {
        action: AuditAction.ORG_UPDATED,
        actorUserId: auth.userId,
        metadata: body,
        meta,
      });
      return updated;
    });
    if (timezoneChanged) {
      // Report hours are local hours, so a new time zone means rebuilding them. Reports keep
      // working meanwhile, a day at a time from the most recent.
      await this.queues
        .enqueueAnalyticsRebuild(org.id, 400)
        .catch((err: unknown) => this.logger.error(`could not queue a rebuild: ${String(err)}`));
    }
    return toOrgDto(org);
  }

  /** Newest first, keyset (cursor) pagination, with filters (Phase 4.4). */
  @Get('current/audit-logs')
  @RequirePermission(Permission.AUDIT_READ)
  async auditLogs(
    @Query(zod(auditQuerySchema)) query: AuditQuery,
  ): Promise<CursorPage<AuditLogDto>> {
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    const rows = await this.db.run((tx) =>
      tx.auditLog.findMany({
        where: {
          AND: [
            auditFilter(query),
            cursor
              ? {
                  OR: [
                    { createdAt: { lt: cursor.createdAt } },
                    { createdAt: cursor.createdAt, id: { lt: cursor.id } },
                  ],
                }
              : {},
          ],
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
        include: { actorUser: { select: { name: true } } },
      }),
    );
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      items: page.map(toAuditDto),
      nextCursor: rows.length > query.limit && last ? encodeCursor(last) : null,
    };
  }

  /** The filtered log as CSV, newest first. Recorded itself: the log can leave the app this way. */
  @Get('current/audit-logs/export')
  @RequirePermission(Permission.AUDIT_READ)
  async exportAuditLogs(
    @CurrentAuth() auth: AuthContext,
    @Query(zod(auditExportSchema)) query: AuditExportQuery,
    @Meta() meta: RequestMeta,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const rows = await this.db.run(
      async (tx) => {
        const found = await tx.auditLog.findMany({
          where: auditFilter(query),
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: AUDIT_EXPORT_MAX_ROWS,
          include: { actorUser: { select: { name: true } } },
        });
        // Not @SkipTenant: the guard has already required an org.
        await this.audit.record(tx, auth.orgId as string, {
          action: AuditAction.AUDIT_EXPORTED,
          actorUserId: auth.userId,
          metadata: { ...query, rows: found.length },
          meta,
        });
        return found;
      },
      { timeout: 30_000 },
    );
    await reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', 'attachment; filename="audit-log.csv"')
      .send(Buffer.from(String.fromCharCode(0xfeff) + auditToCsv(rows.map(toAuditDto)), 'utf8'));
  }
}

/** The where clause for a filter: a whole action or a group, a person, and UTC days. */
function auditFilter(q: AuditExportQuery) {
  const created = auditDateBounds(q);
  return {
    ...(q.action
      ? q.action.includes('.')
        ? { action: q.action }
        : { action: { startsWith: `${q.action}.` } }
      : {}),
    ...(q.actorUserId ? { actorUserId: q.actorUserId } : {}),
    ...(created.gte || created.lt ? { createdAt: created } : {}),
  };
}

function toAuditDto(r: {
  id: string;
  action: string;
  actorUserId: string | null;
  actorUser: { name: string } | null;
  targetType: string | null;
  targetId: string | null;
  metadata: unknown;
  ip: string | null;
  impersonationId: string | null;
  createdAt: Date;
}): AuditLogDto {
  return {
    id: r.id,
    action: r.action,
    actorUserId: r.actorUserId,
    actorName: r.actorUser?.name ?? null,
    targetType: r.targetType,
    targetId: r.targetId,
    metadata: r.metadata,
    ip: r.ip,
    impersonated: r.impersonationId !== null,
    createdAt: r.createdAt.toISOString(),
  };
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
