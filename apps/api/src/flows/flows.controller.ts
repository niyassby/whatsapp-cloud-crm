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
} from '@nestjs/common';
import {
  AppError,
  type CreateFlowInput,
  createFlowSchema,
  type CursorPage,
  ErrorCode,
  type FlowDto,
  type FlowRunDto,
  type FlowRunStepDto,
  type FlowVersionDto,
  type ListFlowRunsQuery,
  listFlowRunsSchema,
  Permission,
  setFlowActiveSchema,
  startFlowRunSchema,
  type UpdateFlowInput,
  updateFlowSchema,
} from '@wacrm/shared';
import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { CurrentAuth, RequireFeature, RequirePermission } from '../auth/decorators';
import { requestMeta } from '../common/request-meta';
import { zod } from '../common/zod.pipe';
import type { AuthContext } from '../tenancy/request-context';
import { type FlowActor, FlowsService } from './flows.service';

function actor(auth: AuthContext, req?: FastifyRequest): FlowActor {
  if (!auth.orgId) {
    throw new AppError(ErrorCode.TENANT_CONTEXT_MISSING, 'An organization context is required');
  }
  return { userId: auth.userId, orgId: auth.orgId, meta: req ? requestMeta(req) : undefined };
}

const MAX_UPLOAD = 16 * 1024 * 1024;

/**
 * Flows and their runs. Reading stays open after a plan drops, so past runs stay visible; making
 * or changing a flow needs the plan's `flows` feature.
 */
@Controller('flows')
export class FlowsController {
  constructor(private readonly flows: FlowsService) {}

  @Get()
  @RequirePermission(Permission.FLOWS_MANAGE)
  list(): Promise<FlowDto[]> {
    return this.flows.list();
  }

  @Post()
  @RequirePermission(Permission.FLOWS_MANAGE)
  @RequireFeature('flows')
  create(
    @CurrentAuth() auth: AuthContext,
    @Req() req: FastifyRequest,
    @Body(zod(createFlowSchema)) body: CreateFlowInput,
  ): Promise<FlowDto> {
    return this.flows.create(actor(auth, req), body);
  }

  /** Files for media steps. Returns the key to put in the step. */
  @Post('media')
  @HttpCode(200)
  @RequirePermission(Permission.FLOWS_MANAGE)
  @RequireFeature('flows')
  async media(@CurrentAuth() auth: AuthContext, @Req() req: FastifyRequest) {
    const part = await req.file({ limits: { fileSize: MAX_UPLOAD } }).catch(() => undefined);
    if (!part) throw new AppError(ErrorCode.VALIDATION_FAILED, 'A file is required');
    let bytes: Buffer;
    try {
      bytes = await part.toBuffer();
    } catch {
      throw new AppError(ErrorCode.MEDIA_NOT_ALLOWED, 'This file is too large');
    }
    return this.flows.uploadMedia(actor(auth, req), {
      bytes,
      mimeType: part.mimetype,
      filename: part.filename ?? null,
    });
  }

  @Get('runs/:runId')
  @RequirePermission(Permission.FLOWS_MANAGE)
  run(
    @Param('runId', ParseUUIDPipe) runId: string,
  ): Promise<FlowRunDto & { history: FlowRunStepDto[] }> {
    return this.flows.run(runId);
  }

  @Post('runs/:runId/cancel')
  @HttpCode(200)
  @RequirePermission(Permission.FLOWS_MANAGE)
  cancelRun(
    @CurrentAuth() auth: AuthContext,
    @Param('runId', ParseUUIDPipe) runId: string,
  ): Promise<FlowRunDto> {
    return this.flows.cancelRun(actor(auth), runId);
  }

  @Get(':id')
  @RequirePermission(Permission.FLOWS_MANAGE)
  get(@Param('id', ParseUUIDPipe) id: string): Promise<FlowDto> {
    return this.flows.get(id);
  }

  @Put(':id')
  @RequirePermission(Permission.FLOWS_MANAGE)
  @RequireFeature('flows')
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zod(updateFlowSchema)) body: UpdateFlowInput,
  ): Promise<FlowDto> {
    return this.flows.update(actor(auth), id, body);
  }

  @Post(':id/publish')
  @HttpCode(200)
  @RequirePermission(Permission.FLOWS_MANAGE)
  @RequireFeature('flows')
  publish(
    @CurrentAuth() auth: AuthContext,
    @Req() req: FastifyRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<FlowDto> {
    return this.flows.publish(actor(auth, req), id);
  }

  @Patch(':id/active')
  @RequirePermission(Permission.FLOWS_MANAGE)
  @RequireFeature('flows')
  setActive(
    @CurrentAuth() auth: AuthContext,
    @Req() req: FastifyRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zod(setFlowActiveSchema)) body: z.infer<typeof setFlowActiveSchema>,
  ): Promise<FlowDto> {
    return this.flows.setActive(actor(auth, req), id, body.active);
  }

  @Get(':id/versions')
  @RequirePermission(Permission.FLOWS_MANAGE)
  versions(@Param('id', ParseUUIDPipe) id: string): Promise<FlowVersionDto[]> {
    return this.flows.versions(id);
  }

  @Get(':id/runs')
  @RequirePermission(Permission.FLOWS_MANAGE)
  runs(
    @Param('id', ParseUUIDPipe) id: string,
    @Query(zod(listFlowRunsSchema)) q: ListFlowRunsQuery,
  ): Promise<CursorPage<FlowRunDto>> {
    return this.flows.runs(id, q);
  }

  @Post(':id/runs')
  @HttpCode(202)
  @RequirePermission(Permission.FLOWS_MANAGE)
  @RequireFeature('flows')
  async start(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zod(startFlowRunSchema)) body: z.infer<typeof startFlowRunSchema>,
  ): Promise<{ queued: true }> {
    await this.flows.start(actor(auth), id, body.contactId);
    return { queued: true };
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission(Permission.FLOWS_MANAGE)
  async remove(
    @CurrentAuth() auth: AuthContext,
    @Req() req: FastifyRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.flows.remove(actor(auth, req), id);
  }
}
