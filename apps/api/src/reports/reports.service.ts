import { Injectable } from '@nestjs/common';
import { buildReport, type TenantTx } from '@wacrm/db';
import {
  AppError,
  ErrorCode,
  hasPermission,
  lastDays,
  nextScheduleRun,
  Permission,
  type ReportDto,
  type ReportFormat,
  type ReportFrequency,
  type ReportKind,
  type ReportRange,
  reportRangeSchema,
  type ReportScheduleDto,
  type ReportScheduleInput,
  reportFileName,
  reportToCsv,
  type Role,
} from '@wacrm/shared';
import { renderReportPdf } from '@wacrm/shared/server';
import { AuditAction, AuditService } from '../audit/audit.service';
import type { RequestMeta } from '../common/request-meta';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service';

export interface ReportsActor {
  orgId: string;
  userId: string;
  meta?: RequestMeta;
}

type ScheduleRow = Awaited<ReturnType<TenantTx['reportSchedule']['findUniqueOrThrow']>>;

function toDto(s: ScheduleRow): ReportScheduleDto {
  return {
    id: s.id,
    name: s.name,
    report: s.report as ReportKind,
    frequency: s.frequency as ReportFrequency,
    format: s.format as ReportFormat,
    recipientIds: s.recipientIds,
    hour: s.hour,
    active: s.active,
    nextRunAt: s.nextRunAt.toISOString(),
    lastRunAt: s.lastRunAt?.toISOString() ?? null,
    lastError: s.lastError,
    createdAt: s.createdAt.toISOString(),
  };
}

/** Workspaces keep at most this many schedules. */
const MAX_SCHEDULES = 50;

@Injectable()
export class ReportsService {
  constructor(
    private readonly db: TenantPrismaService,
    private readonly audit: AuditService,
  ) {}

  /** The range asked for, or the last 30 days in the workspace's time zone. */
  private async range(
    tx: TenantTx,
    orgId: string,
    q: { from?: string; to?: string },
  ): Promise<ReportRange> {
    if (!q.from && !q.to) {
      const org = await tx.organization.findUniqueOrThrow({
        where: { id: orgId },
        select: { timezone: true },
      });
      return lastDays(30, org.timezone);
    }
    const parsed = reportRangeSchema.safeParse({ from: q.from ?? q.to, to: q.to ?? q.from });
    if (!parsed.success) {
      throw new AppError(
        ErrorCode.VALIDATION_FAILED,
        parsed.error.issues[0]?.message ?? 'Choose a valid range',
      );
    }
    return parsed.data;
  }

  report(orgId: string, kind: ReportKind, q: { from?: string; to?: string }): Promise<ReportDto> {
    return this.db.run(async (tx) => buildReport(tx, orgId, kind, await this.range(tx, orgId, q)), {
      timeout: 20_000,
    });
  }

  /** A report as a file. Exports are audited: they can leave the app. */
  async export(
    actor: ReportsActor,
    kind: ReportKind,
    format: ReportFormat,
    q: { from?: string; to?: string },
  ): Promise<{ filename: string; contentType: string; body: Buffer }> {
    const { report, workspace } = await this.db.run(
      async (tx) => {
        const report = await buildReport(
          tx,
          actor.orgId,
          kind,
          await this.range(tx, actor.orgId, q),
        );
        const org = await tx.organization.findUniqueOrThrow({
          where: { id: actor.orgId },
          select: { name: true },
        });
        await this.audit.record(tx, actor.orgId, {
          action: AuditAction.REPORT_EXPORTED,
          actorUserId: actor.userId,
          metadata: { report: kind, format, from: report.period.from, to: report.period.to },
          meta: actor.meta,
        });
        return { report, workspace: org.name };
      },
      { timeout: 20_000 },
    );
    return format === 'pdf'
      ? {
          filename: reportFileName(report, 'pdf'),
          contentType: 'application/pdf',
          body: await renderReportPdf(report, workspace),
        }
      : {
          filename: reportFileName(report, 'csv'),
          contentType: 'text/csv; charset=utf-8',
          // A byte order mark, so spreadsheet apps read non-English names correctly.
          body: Buffer.from(String.fromCharCode(0xfeff) + reportToCsv(report), 'utf8'),
        };
  }

  // ---------------------------------------------------------------- schedules

  async schedules(): Promise<ReportScheduleDto[]> {
    const rows = await this.db.run((tx) =>
      tx.reportSchedule.findMany({ orderBy: { createdAt: 'desc' } }),
    );
    return rows.map(toDto);
  }

  /** Reports only go to people in the workspace who may read them. */
  private async checkRecipients(tx: TenantTx, orgId: string, ids: string[]): Promise<void> {
    const members = await tx.membership.findMany({
      where: { orgId, userId: { in: ids }, status: 'active' },
      select: { userId: true, role: true },
    });
    const allowed = new Set(
      members
        .filter((m) => hasPermission(m.role as Role, Permission.ANALYTICS_READ))
        .map((m) => m.userId),
    );
    if (ids.some((id) => !allowed.has(id))) {
      throw new AppError(
        ErrorCode.VALIDATION_FAILED,
        'Reports can only be sent to owners and admins of this workspace',
      );
    }
  }

  async createSchedule(
    actor: ReportsActor,
    input: ReportScheduleInput,
  ): Promise<ReportScheduleDto> {
    const row = await this.db.run(async (tx) => {
      if ((await tx.reportSchedule.count()) >= MAX_SCHEDULES) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, `At most ${MAX_SCHEDULES} schedules`);
      }
      const recipientIds = [...new Set(input.recipientIds)];
      await this.checkRecipients(tx, actor.orgId, recipientIds);
      const org = await tx.organization.findUniqueOrThrow({
        where: { id: actor.orgId },
        select: { timezone: true },
      });
      const created = await tx.reportSchedule.create({
        data: {
          orgId: actor.orgId,
          name: input.name,
          report: input.report,
          frequency: input.frequency,
          format: input.format,
          recipientIds,
          hour: input.hour,
          active: input.active,
          nextRunAt: nextScheduleRun(input.frequency, input.hour, org.timezone, new Date()),
          createdById: actor.userId,
        },
      });
      await this.audit.record(tx, actor.orgId, {
        action: AuditAction.REPORT_SCHEDULE_CHANGED,
        actorUserId: actor.userId,
        targetType: 'report_schedule',
        targetId: created.id,
        metadata: { change: 'created', report: input.report, frequency: input.frequency },
        meta: actor.meta,
      });
      return created;
    });
    return toDto(row);
  }

  async updateSchedule(
    actor: ReportsActor,
    id: string,
    input: Partial<ReportScheduleInput>,
  ): Promise<ReportScheduleDto> {
    const row = await this.db.run(async (tx) => {
      const current = await tx.reportSchedule.findUnique({ where: { id } });
      if (!current) throw new AppError(ErrorCode.NOT_FOUND, 'Schedule not found');
      const recipientIds = input.recipientIds ? [...new Set(input.recipientIds)] : undefined;
      if (recipientIds) await this.checkRecipients(tx, actor.orgId, recipientIds);
      const frequency = (input.frequency ?? current.frequency) as ReportFrequency;
      const hour = input.hour ?? current.hour;
      const timing = input.frequency !== undefined || input.hour !== undefined;
      const org = await tx.organization.findUniqueOrThrow({
        where: { id: actor.orgId },
        select: { timezone: true },
      });
      const updated = await tx.reportSchedule.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.report !== undefined ? { report: input.report } : {}),
          ...(input.format !== undefined ? { format: input.format } : {}),
          ...(input.active !== undefined ? { active: input.active } : {}),
          ...(recipientIds ? { recipientIds } : {}),
          frequency,
          hour,
          // Turning a schedule back on or changing its timing starts from now, never sends a
          // backlog.
          ...(timing || (input.active && !current.active)
            ? { nextRunAt: nextScheduleRun(frequency, hour, org.timezone, new Date()) }
            : {}),
        },
      });
      await this.audit.record(tx, actor.orgId, {
        action: AuditAction.REPORT_SCHEDULE_CHANGED,
        actorUserId: actor.userId,
        targetType: 'report_schedule',
        targetId: id,
        metadata: { change: 'updated', fields: Object.keys(input) },
        meta: actor.meta,
      });
      return updated;
    });
    return toDto(row);
  }

  async deleteSchedule(actor: ReportsActor, id: string): Promise<void> {
    await this.db.run(async (tx) => {
      const deleted = await tx.reportSchedule.deleteMany({ where: { id } });
      if (deleted.count === 0) throw new AppError(ErrorCode.NOT_FOUND, 'Schedule not found');
      await this.audit.record(tx, actor.orgId, {
        action: AuditAction.REPORT_SCHEDULE_CHANGED,
        actorUserId: actor.userId,
        targetType: 'report_schedule',
        targetId: id,
        metadata: { change: 'deleted' },
        meta: actor.meta,
      });
    });
  }

  /** Send now: the worker picks it up within a minute, then the usual timing carries on. */
  async runNow(id: string): Promise<ReportScheduleDto> {
    const row = await this.db.run(async (tx) => {
      const current = await tx.reportSchedule.findUnique({ where: { id } });
      if (!current) throw new AppError(ErrorCode.NOT_FOUND, 'Schedule not found');
      if (!current.active) throw new AppError(ErrorCode.VALIDATION_FAILED, 'Turn it on first');
      return tx.reportSchedule.update({
        where: { id },
        data: { nextRunAt: new Date(), lastError: null },
      });
    });
    return toDto(row);
  }
}
