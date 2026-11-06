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
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  type AnalyticsRangeQuery,
  analyticsRangeSchema,
  AppError,
  campaignCsvOptionsSchema,
  type CampaignDto,
  type CampaignEstimateDto,
  type CampaignRecipientDto,
  type CampaignReportDto,
  type CreateCampaignParsed,
  createCampaignSchema,
  type CursorPage,
  type DashboardDto,
  type DripDto,
  type EnrollDripInput,
  enrollDripSchema,
  ErrorCode,
  type LaunchCampaignInput,
  launchCampaignSchema,
  type ListCampaignsQuery,
  listCampaignsSchema,
  type ListRecipientsQuery,
  listRecipientsSchema,
  MAX_CONTACT_IMPORT_BYTES,
  Permission,
  type SaveDripParsed,
  saveDripSchema,
  setDripStatusSchema,
  type UpdateCampaignInput,
  updateCampaignSchema,
} from '@wacrm/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { CurrentAuth, RequirePermission } from '../auth/decorators';
import { requestMeta } from '../common/request-meta';
import { zod } from '../common/zod.pipe';
import type { AuthContext } from '../tenancy/request-context';
import { AnalyticsService } from './analytics.service';
import { type CampaignActor, CampaignsService } from './campaigns.service';
import { DripsService } from './drips.service';

function actor(auth: AuthContext, req?: FastifyRequest): CampaignActor {
  if (!auth.orgId) {
    throw new AppError(ErrorCode.TENANT_CONTEXT_MISSING, 'An organization context is required');
  }
  return { userId: auth.userId, orgId: auth.orgId, meta: req ? requestMeta(req) : undefined };
}

@Controller('campaigns')
export class CampaignsController {
  constructor(private readonly campaigns: CampaignsService) {}

  @Get()
  @RequirePermission(Permission.CAMPAIGNS_MANAGE)
  list(@Query(zod(listCampaignsSchema)) q: ListCampaignsQuery): Promise<CursorPage<CampaignDto>> {
    return this.campaigns.list(q);
  }

  @Post()
  @RequirePermission(Permission.CAMPAIGNS_MANAGE)
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(zod(createCampaignSchema)) body: CreateCampaignParsed,
  ): Promise<CampaignDto> {
    return this.campaigns.create(actor(auth), body);
  }

  @Get(':id')
  @RequirePermission(Permission.CAMPAIGNS_MANAGE)
  report(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CampaignReportDto> {
    return this.campaigns.report(actor(auth), id);
  }

  @Patch(':id')
  @RequirePermission(Permission.CAMPAIGNS_MANAGE)
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zod(updateCampaignSchema)) body: UpdateCampaignInput,
  ): Promise<CampaignDto> {
    return this.campaigns.update(id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission(Permission.CAMPAIGNS_MANAGE)
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.campaigns.remove(id);
  }

  /** multipart/form-data with `options` (JSON), then `file` last. */
  @Post(':id/audience-csv')
  @HttpCode(200)
  @RequirePermission(Permission.CAMPAIGNS_MANAGE)
  async audienceCsv(
    @CurrentAuth() auth: AuthContext,
    @Req() req: FastifyRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CampaignDto> {
    const part = await req
      .file({ limits: { fileSize: MAX_CONTACT_IMPORT_BYTES } })
      .catch(() => undefined);
    if (!part) throw new AppError(ErrorCode.VALIDATION_FAILED, 'A CSV file is required');
    if (!part.filename?.toLowerCase().endsWith('.csv')) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'Please upload a .csv file');
    }
    let bytes: Buffer;
    try {
      bytes = await part.toBuffer();
    } catch {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'This file is over the 50 MB limit');
    }
    const field = part.fields.options;
    const raw = field && !Array.isArray(field) && field.type === 'field' ? field.value : undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(raw));
    } catch {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'Audience options are missing');
    }
    const options = zod(campaignCsvOptionsSchema).transform(parsed);
    return this.campaigns.setCsvAudience(
      actor(auth, req),
      id,
      { bytes, filename: part.filename ?? null },
      options,
    );
  }

  @Post(':id/estimate')
  @HttpCode(200)
  @RequirePermission(Permission.CAMPAIGNS_MANAGE)
  estimate(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CampaignEstimateDto> {
    return this.campaigns.estimate(actor(auth), id);
  }

  @Post(':id/launch')
  @HttpCode(200)
  @RequirePermission(Permission.CAMPAIGNS_MANAGE)
  launch(
    @CurrentAuth() auth: AuthContext,
    @Req() req: FastifyRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zod(launchCampaignSchema)) body: LaunchCampaignInput,
  ): Promise<CampaignDto> {
    return this.campaigns.launch(actor(auth, req), id, body);
  }

  @Post(':id/pause')
  @HttpCode(200)
  @RequirePermission(Permission.CAMPAIGNS_MANAGE)
  pause(
    @CurrentAuth() auth: AuthContext,
    @Req() req: FastifyRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CampaignDto> {
    return this.campaigns.pause(actor(auth, req), id);
  }

  @Post(':id/resume')
  @HttpCode(200)
  @RequirePermission(Permission.CAMPAIGNS_MANAGE)
  resume(
    @CurrentAuth() auth: AuthContext,
    @Req() req: FastifyRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CampaignDto> {
    return this.campaigns.resume(actor(auth, req), id);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @RequirePermission(Permission.CAMPAIGNS_MANAGE)
  cancel(
    @CurrentAuth() auth: AuthContext,
    @Req() req: FastifyRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CampaignDto> {
    return this.campaigns.cancel(actor(auth, req), id);
  }

  @Get(':id/recipients')
  @RequirePermission(Permission.CAMPAIGNS_MANAGE)
  recipients(
    @Param('id', ParseUUIDPipe) id: string,
    @Query(zod(listRecipientsSchema)) q: ListRecipientsQuery,
  ): Promise<CursorPage<CampaignRecipientDto>> {
    return this.campaigns.recipients(id, q);
  }

  @Get(':id/report.csv')
  @RequirePermission(Permission.CAMPAIGNS_MANAGE)
  async reportCsv(
    @Param('id', ParseUUIDPipe) id: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const csv = await this.campaigns.reportCsv(id);
    await reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', 'attachment; filename="campaign-report.csv"')
      .send(csv);
  }
}

@Controller('drips')
export class DripsController {
  constructor(private readonly drips: DripsService) {}

  @Get()
  @RequirePermission(Permission.CAMPAIGNS_MANAGE)
  list(): Promise<DripDto[]> {
    return this.drips.list();
  }

  @Post()
  @RequirePermission(Permission.CAMPAIGNS_MANAGE)
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(zod(saveDripSchema)) body: SaveDripParsed,
  ): Promise<DripDto> {
    return this.drips.create(actor(auth), body);
  }

  @Get(':id')
  @RequirePermission(Permission.CAMPAIGNS_MANAGE)
  get(@Param('id', ParseUUIDPipe) id: string): Promise<DripDto> {
    return this.drips.get(id);
  }

  @Put(':id')
  @RequirePermission(Permission.CAMPAIGNS_MANAGE)
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zod(saveDripSchema)) body: SaveDripParsed,
  ): Promise<DripDto> {
    return this.drips.update(actor(auth), id, body);
  }

  @Post(':id/status')
  @HttpCode(200)
  @RequirePermission(Permission.CAMPAIGNS_MANAGE)
  setStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zod(setDripStatusSchema)) body: z.infer<typeof setDripStatusSchema>,
  ): Promise<DripDto> {
    return this.drips.setStatus(id, body.status);
  }

  @Post(':id/enroll')
  @HttpCode(200)
  @RequirePermission(Permission.CAMPAIGNS_MANAGE)
  enroll(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zod(enrollDripSchema)) body: EnrollDripInput,
  ): Promise<{ enrolled: number }> {
    return this.drips.enroll(actor(auth), id, body);
  }
}

@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('dashboard')
  @RequirePermission(Permission.ANALYTICS_READ)
  dashboard(
    @CurrentAuth() auth: AuthContext,
    @Query(zod(analyticsRangeSchema)) q: AnalyticsRangeQuery,
  ): Promise<DashboardDto> {
    return this.analytics.dashboard(actor(auth).orgId, q.days);
  }
}
