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
  Req,
} from '@nestjs/common';
import {
  AppError,
  type CreateTemplateParsed,
  createTemplateSchema,
  type CursorPage,
  ErrorCode,
  type ListTemplatesQuery,
  listTemplatesSchema,
  type MediaUrlDto,
  Permission,
  type TemplateDto,
  type TemplateWabaDto,
  type UpdateTemplateParsed,
  updateTemplateSchema,
} from '@wacrm/shared';
import type { FastifyRequest } from 'fastify';
import { CurrentAuth, RequirePermission } from '../auth/decorators';
import { requestMeta } from '../common/request-meta';
import { zod } from '../common/zod.pipe';
import type { AuthContext } from '../tenancy/request-context';
import { type TemplateActor, TemplatesService } from './templates.service';

const MAX_HEADER_BYTES = 25 * 1024 * 1024;

function actor(auth: AuthContext, req?: FastifyRequest): TemplateActor {
  if (!auth.orgId) {
    throw new AppError(ErrorCode.TENANT_CONTEXT_MISSING, 'An organization context is required');
  }
  return { userId: auth.userId, orgId: auth.orgId, meta: req ? requestMeta(req) : undefined };
}

@Controller('templates')
export class TemplatesController {
  constructor(private readonly templates: TemplatesService) {}

  @Get()
  @RequirePermission(Permission.TEMPLATES_READ)
  list(
    @Query(zod(listTemplatesSchema)) query: ListTemplatesQuery,
  ): Promise<CursorPage<TemplateDto>> {
    return this.templates.list(query);
  }

  @Get('accounts')
  @RequirePermission(Permission.TEMPLATES_READ)
  accounts(): Promise<TemplateWabaDto[]> {
    return this.templates.listWabas();
  }

  @Post()
  @RequirePermission(Permission.TEMPLATES_MANAGE)
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(zod(createTemplateSchema)) body: CreateTemplateParsed,
  ): Promise<TemplateDto> {
    return this.templates.create(actor(auth), body);
  }

  /** Compare with Meta now, rather than waiting for the hourly job. */
  @Post('sync')
  @HttpCode(200)
  @RequirePermission(Permission.TEMPLATES_MANAGE)
  sync(@CurrentAuth() auth: AuthContext): Promise<{ changed: number }> {
    return this.templates.syncAll(actor(auth));
  }

  @Get(':id')
  @RequirePermission(Permission.TEMPLATES_READ)
  get(@Param('id', ParseUUIDPipe) id: string): Promise<TemplateDto> {
    return this.templates.get(id);
  }

  @Patch(':id')
  @RequirePermission(Permission.TEMPLATES_MANAGE)
  update(
    @CurrentAuth() auth: AuthContext,
    @Req() req: FastifyRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zod(updateTemplateSchema)) body: UpdateTemplateParsed,
  ): Promise<TemplateDto> {
    return this.templates.update(actor(auth, req), id, body);
  }

  @Post(':id/submit')
  @HttpCode(200)
  @RequirePermission(Permission.TEMPLATES_MANAGE)
  submit(
    @CurrentAuth() auth: AuthContext,
    @Req() req: FastifyRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<TemplateDto> {
    return this.templates.submit(actor(auth, req), id);
  }

  /** multipart/form-data with `file`. */
  @Post(':id/header-media')
  @HttpCode(200)
  @RequirePermission(Permission.TEMPLATES_MANAGE)
  async headerMedia(
    @CurrentAuth() auth: AuthContext,
    @Req() req: FastifyRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<TemplateDto> {
    const part = await req.file({ limits: { fileSize: MAX_HEADER_BYTES } }).catch(() => undefined);
    if (!part) throw new AppError(ErrorCode.VALIDATION_FAILED, 'A file is required');
    let bytes: Buffer;
    try {
      bytes = await part.toBuffer();
    } catch {
      throw new AppError(ErrorCode.MEDIA_NOT_ALLOWED, 'This file is too large');
    }
    return this.templates.setHeaderMedia(actor(auth, req), id, {
      bytes,
      mimeType: part.mimetype,
      filename: part.filename ?? null,
    });
  }

  @Get(':id/header-media')
  @RequirePermission(Permission.TEMPLATES_READ)
  headerMediaUrl(@Param('id', ParseUUIDPipe) id: string): Promise<MediaUrlDto> {
    return this.templates.headerMediaUrl(id);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission(Permission.TEMPLATES_MANAGE)
  async remove(
    @CurrentAuth() auth: AuthContext,
    @Req() req: FastifyRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.templates.remove(actor(auth, req), id);
  }
}
