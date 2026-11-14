import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import {
  AppError,
  ErrorCode,
  Permission,
  REPORT_FORMATS,
  REPORT_KINDS,
  type ReportDto,
  type ReportKind,
  type ReportScheduleDto,
  type ReportScheduleInput,
  reportScheduleSchema,
  updateReportScheduleSchema,
} from '@wacrm/shared';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { CurrentAuth, RequireFeature, RequirePermission } from '../auth/decorators';
import { Meta, type RequestMeta } from '../common/request-meta';
import { zod } from '../common/zod.pipe';
import type { AuthContext } from '../tenancy/request-context';
import { type ReportsActor, ReportsService } from './reports.service';

const rangeQuery = z.object({ from: z.string().optional(), to: z.string().optional() });
const exportQuery = rangeQuery.extend({ format: z.enum(REPORT_FORMATS).default('csv') });
const kindSchema = z.enum(REPORT_KINDS);

function actor(auth: AuthContext, meta?: RequestMeta): ReportsActor {
  if (!auth.orgId) {
    throw new AppError(ErrorCode.TENANT_CONTEXT_MISSING, 'An organization context is required');
  }
  return { orgId: auth.orgId, userId: auth.userId, meta };
}

function kindOf(value: string): ReportKind {
  const parsed = kindSchema.safeParse(value);
  if (!parsed.success) throw new AppError(ErrorCode.NOT_FOUND, 'No such report');
  return parsed.data;
}

/**
 * Reports, exports and scheduled emails (Phase 4.3). Owners and admins (`ANALYTICS_READ`), on
 * plans with `reports`. Every report reads the aggregates, never the messages table.
 */
@Controller('reports')
@RequirePermission(Permission.ANALYTICS_READ)
@RequireFeature('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  // Schedules first, so "schedules" is never read as a report name.
  @Get('schedules')
  schedules(): Promise<ReportScheduleDto[]> {
    return this.reports.schedules();
  }

  @Post('schedules')
  createSchedule(
    @CurrentAuth() auth: AuthContext,
    @Body(zod(reportScheduleSchema)) body: ReportScheduleInput,
    @Meta() meta: RequestMeta,
  ): Promise<ReportScheduleDto> {
    return this.reports.createSchedule(actor(auth, meta), body);
  }

  @Patch('schedules/:id')
  updateSchedule(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zod(updateReportScheduleSchema)) body: Partial<ReportScheduleInput>,
    @Meta() meta: RequestMeta,
  ): Promise<ReportScheduleDto> {
    return this.reports.updateSchedule(actor(auth, meta), id, body);
  }

  @Delete('schedules/:id')
  @HttpCode(204)
  deleteSchedule(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Meta() meta: RequestMeta,
  ): Promise<void> {
    return this.reports.deleteSchedule(actor(auth, meta), id);
  }

  @Post('schedules/:id/run')
  runNow(@Param('id', ParseUUIDPipe) id: string): Promise<ReportScheduleDto> {
    return this.reports.runNow(id);
  }

  @Get(':kind')
  report(
    @CurrentAuth() auth: AuthContext,
    @Param('kind') kind: string,
    @Query(zod(rangeQuery)) q: z.infer<typeof rangeQuery>,
  ): Promise<ReportDto> {
    return this.reports.report(actor(auth).orgId, kindOf(kind), q);
  }

  @Get(':kind/export')
  async export(
    @CurrentAuth() auth: AuthContext,
    @Param('kind') kind: string,
    @Query(zod(exportQuery)) q: z.infer<typeof exportQuery>,
    @Meta() meta: RequestMeta,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const file = await this.reports.export(actor(auth, meta), kindOf(kind), q.format, q);
    await reply
      .header('content-type', file.contentType)
      .header('content-disposition', `attachment; filename="${file.filename}"`)
      .header('cache-control', 'no-store')
      .send(file.body);
  }
}
