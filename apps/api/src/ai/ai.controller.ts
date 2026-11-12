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
  type AiLogDto,
  type AiSettingsDto,
  type AiSuggestionDto,
  type AiTextDto,
  AppError,
  type CreateKnowledgeTextInput,
  createKnowledgeTextSchema,
  type CursorPage,
  ErrorCode,
  KNOWLEDGE_MAX_FILE_BYTES,
  type KnowledgeDocumentDto,
  type KnowledgeHitDto,
  type ListAiLogQuery,
  listAiLogSchema,
  Permission,
  type RewriteInput,
  rewriteSchema,
  searchKnowledgeSchema,
  type UpdateAiSettingsInput,
  updateAiSettingsSchema,
} from '@wacrm/shared';
import type { FastifyRequest } from 'fastify';
import { CurrentAuth, RequireFeature, RequirePermission } from '../auth/decorators';
import { requestMeta } from '../common/request-meta';
import { zod } from '../common/zod.pipe';
import type { AuthContext } from '../tenancy/request-context';
import { type AiActor, AiService } from './ai.service';

function actor(auth: AuthContext, req?: FastifyRequest): AiActor {
  if (!auth.orgId) {
    throw new AppError(ErrorCode.TENANT_CONTEXT_MISSING, 'An organization context is required');
  }
  return { userId: auth.userId, orgId: auth.orgId, meta: req ? requestMeta(req) : undefined };
}

/**
 * AI settings, the knowledge base and inbox help. Anything that calls a model needs the plan's
 * `ai` feature; reading settings, documents and the log stays open after a downgrade.
 */
@Controller('ai')
export class AiController {
  constructor(private readonly ai: AiService) {}

  /** Agents read it too, to know whether to offer AI buttons. */
  @Get('settings')
  @RequirePermission(Permission.INBOX_READ)
  settings(): Promise<AiSettingsDto> {
    return this.ai.settings();
  }

  @Patch('settings')
  @RequirePermission(Permission.AI_MANAGE)
  @RequireFeature('ai')
  updateSettings(
    @CurrentAuth() auth: AuthContext,
    @Req() req: FastifyRequest,
    @Body(zod(updateAiSettingsSchema)) body: UpdateAiSettingsInput,
  ): Promise<AiSettingsDto> {
    return this.ai.updateSettings(actor(auth, req), body);
  }

  // ------------------------------------------------------------------ knowledge base

  @Get('knowledge')
  @RequirePermission(Permission.AI_MANAGE)
  documents(): Promise<KnowledgeDocumentDto[]> {
    return this.ai.listDocuments();
  }

  @Post('knowledge')
  @RequirePermission(Permission.AI_MANAGE)
  @RequireFeature('ai')
  addText(
    @CurrentAuth() auth: AuthContext,
    @Req() req: FastifyRequest,
    @Body(zod(createKnowledgeTextSchema)) body: CreateKnowledgeTextInput,
  ): Promise<KnowledgeDocumentDto> {
    return this.ai.addText(actor(auth, req), body);
  }

  @Post('knowledge/upload')
  @RequirePermission(Permission.AI_MANAGE)
  @RequireFeature('ai')
  async upload(
    @CurrentAuth() auth: AuthContext,
    @Req() req: FastifyRequest,
  ): Promise<KnowledgeDocumentDto> {
    const part = await req
      .file({ limits: { fileSize: KNOWLEDGE_MAX_FILE_BYTES } })
      .catch(() => undefined);
    if (!part) throw new AppError(ErrorCode.VALIDATION_FAILED, 'A file is required');
    let bytes: Buffer;
    try {
      bytes = await part.toBuffer();
    } catch {
      throw new AppError(ErrorCode.KNOWLEDGE_INVALID, 'Files can be up to 5 MB');
    }
    return this.ai.upload(actor(auth, req), {
      bytes,
      mimeType: part.mimetype,
      filename: part.filename ?? null,
    });
  }

  @Post('knowledge/search')
  @HttpCode(200)
  @RequirePermission(Permission.AI_MANAGE)
  @RequireFeature('ai')
  search(
    @CurrentAuth() auth: AuthContext,
    @Body(zod(searchKnowledgeSchema)) body: { query: string },
  ): Promise<KnowledgeHitDto[]> {
    return this.ai.search(actor(auth), body.query);
  }

  @Post('knowledge/:id/reindex')
  @HttpCode(200)
  @RequirePermission(Permission.AI_MANAGE)
  @RequireFeature('ai')
  reindex(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<KnowledgeDocumentDto> {
    return this.ai.reindex(actor(auth), id);
  }

  @Delete('knowledge/:id')
  @HttpCode(204)
  @RequirePermission(Permission.AI_MANAGE)
  async remove(
    @CurrentAuth() auth: AuthContext,
    @Req() req: FastifyRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.ai.deleteDocument(actor(auth, req), id);
  }

  // ------------------------------------------------------------------ inbox help

  @Post('conversations/:id/suggest')
  @HttpCode(200)
  @RequirePermission(Permission.INBOX_REPLY)
  @RequireFeature('ai')
  suggest(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AiSuggestionDto> {
    return this.ai.suggest(actor(auth), id);
  }

  @Post('conversations/:id/summarize')
  @HttpCode(200)
  @RequirePermission(Permission.INBOX_REPLY)
  @RequireFeature('ai')
  summarize(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AiTextDto> {
    return this.ai.summarize(actor(auth), id);
  }

  @Post('rewrite')
  @HttpCode(200)
  @RequirePermission(Permission.INBOX_REPLY)
  @RequireFeature('ai')
  rewrite(
    @CurrentAuth() auth: AuthContext,
    @Body(zod(rewriteSchema)) body: RewriteInput,
  ): Promise<AiTextDto> {
    return this.ai.rewrite(actor(auth), body);
  }

  // ------------------------------------------------------------------ the log

  @Get('log')
  @RequirePermission(Permission.AI_MANAGE)
  log(@Query(zod(listAiLogSchema)) q: ListAiLogQuery): Promise<CursorPage<AiLogDto>> {
    return this.ai.log(q);
  }
}
