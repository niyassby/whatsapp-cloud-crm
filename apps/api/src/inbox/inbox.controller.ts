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
  ACCEPTED_MEDIA_TYPES,
  AppError,
  type CannedReplyDto,
  type ConversationDto,
  type CreateCannedReplyInput,
  createCannedReplySchema,
  createLabelSchema,
  type CursorPage,
  type CursorQuery,
  cursorQuerySchema,
  ErrorCode,
  type InboxTemplateDto,
  type LabelDto,
  type ListConversationsQuery,
  listConversationsSchema,
  MAX_UPLOAD_BYTES,
  type MediaUrlDto,
  type MessageDto,
  Permission,
  sendMediaFieldsSchema,
  type SendMessageParsed,
  sendMessageSchema,
  type SendNoteInput,
  sendNoteSchema,
  type SetConversationLabelsInput,
  setConversationLabelsSchema,
  type UpdateConversationInput,
  updateConversationSchema,
} from '@wacrm/shared';
import type { FastifyRequest } from 'fastify';
import { CurrentAuth, RequirePermission } from '../auth/decorators';
import { zod } from '../common/zod.pipe';
import type { AuthContext } from '../tenancy/request-context';
import { type InboxActor, InboxService } from './inbox.service';

function actor(auth: AuthContext): InboxActor {
  if (!auth.orgId || !auth.role) {
    throw new AppError(ErrorCode.TENANT_CONTEXT_MISSING, 'An organization context is required');
  }
  return { userId: auth.userId, orgId: auth.orgId, role: auth.role };
}

@Controller('inbox')
export class InboxController {
  constructor(private readonly inbox: InboxService) {}

  @Get('conversations')
  @RequirePermission(Permission.INBOX_READ)
  list(
    @CurrentAuth() auth: AuthContext,
    @Query(zod(listConversationsSchema)) query: ListConversationsQuery,
  ): Promise<CursorPage<ConversationDto>> {
    return this.inbox.listConversations(actor(auth), query);
  }

  @Get('conversations/:id')
  @RequirePermission(Permission.INBOX_READ)
  get(@Param('id', ParseUUIDPipe) id: string): Promise<ConversationDto> {
    return this.inbox.getConversation(id);
  }

  @Patch('conversations/:id')
  @RequirePermission(Permission.INBOX_REPLY)
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zod(updateConversationSchema)) body: UpdateConversationInput,
  ): Promise<ConversationDto> {
    return this.inbox.updateConversation(actor(auth), id, body);
  }

  @Post('conversations/:id/read')
  @HttpCode(200)
  @RequirePermission(Permission.INBOX_READ)
  read(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ConversationDto> {
    return this.inbox.markRead(actor(auth), id);
  }

  @Put('conversations/:id/labels')
  @RequirePermission(Permission.INBOX_REPLY)
  setLabels(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zod(setConversationLabelsSchema)) body: SetConversationLabelsInput,
  ): Promise<ConversationDto> {
    return this.inbox.setLabels(actor(auth), id, body.labelIds);
  }

  @Get('conversations/:id/messages')
  @RequirePermission(Permission.INBOX_READ)
  messages(
    @Param('id', ParseUUIDPipe) id: string,
    @Query(zod(cursorQuerySchema)) query: CursorQuery,
  ): Promise<CursorPage<MessageDto>> {
    return this.inbox.listMessages(id, query);
  }

  @Post('conversations/:id/messages')
  @RequirePermission(Permission.INBOX_REPLY)
  send(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zod(sendMessageSchema)) body: SendMessageParsed,
  ): Promise<MessageDto> {
    return this.inbox.sendMessage(actor(auth), id, body);
  }

  /** multipart/form-data with `clientMessageId`, optional `caption`, then `file` last. */
  @Post('conversations/:id/messages/media')
  @RequirePermission(Permission.INBOX_REPLY)
  async sendMedia(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: FastifyRequest,
  ): Promise<MessageDto> {
    const part = await req.file({ limits: { fileSize: MAX_UPLOAD_BYTES } }).catch(() => undefined);
    if (!part) throw new AppError(ErrorCode.VALIDATION_FAILED, 'A file is required');
    if (!ACCEPTED_MEDIA_TYPES.includes(part.mimetype)) {
      throw new AppError(ErrorCode.MEDIA_NOT_ALLOWED, 'WhatsApp does not accept this file type');
    }
    let bytes: Buffer;
    try {
      bytes = await part.toBuffer();
    } catch {
      throw new AppError(ErrorCode.MEDIA_NOT_ALLOWED, 'This file is too large');
    }
    const field = (name: string) => {
      const f = part.fields[name];
      return f && !Array.isArray(f) && f.type === 'field' ? String(f.value) : undefined;
    };
    const fields = zod(sendMediaFieldsSchema).transform({
      clientMessageId: field('clientMessageId'),
      caption: field('caption'),
    });
    return this.inbox.sendMedia(
      actor(auth),
      id,
      { bytes, mimeType: part.mimetype, filename: part.filename ?? null },
      fields,
    );
  }

  @Post('conversations/:id/notes')
  @RequirePermission(Permission.INBOX_REPLY)
  note(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zod(sendNoteSchema)) body: SendNoteInput,
  ): Promise<MessageDto> {
    return this.inbox.addNote(actor(auth), id, body);
  }

  @Get('conversations/:id/messages/:messageId/media')
  @RequirePermission(Permission.INBOX_READ)
  mediaUrl(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('messageId', ParseUUIDPipe) messageId: string,
  ): Promise<MediaUrlDto> {
    return this.inbox.mediaUrl(id, messageId);
  }

  @Get('conversations/:id/templates')
  @RequirePermission(Permission.TEMPLATES_READ)
  templates(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<InboxTemplateDto[]> {
    return this.inbox.listTemplates(actor(auth), id);
  }

  @Get('labels')
  @RequirePermission(Permission.INBOX_READ)
  labels(): Promise<LabelDto[]> {
    return this.inbox.listLabels();
  }

  @Post('labels')
  @RequirePermission(Permission.INBOX_ASSIGN)
  createLabel(
    @CurrentAuth() auth: AuthContext,
    @Body(zod(createLabelSchema)) body: ReturnType<typeof createLabelSchema.parse>,
  ): Promise<LabelDto> {
    return this.inbox.createLabel(actor(auth), body);
  }

  @Delete('labels/:id')
  @HttpCode(204)
  @RequirePermission(Permission.INBOX_ASSIGN)
  async deleteLabel(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.inbox.deleteLabel(id);
  }

  @Get('canned-replies')
  @RequirePermission(Permission.INBOX_READ)
  cannedReplies(): Promise<CannedReplyDto[]> {
    return this.inbox.listCannedReplies();
  }

  @Post('canned-replies')
  @RequirePermission(Permission.INBOX_ASSIGN)
  createCannedReply(
    @CurrentAuth() auth: AuthContext,
    @Body(zod(createCannedReplySchema)) body: CreateCannedReplyInput,
  ): Promise<CannedReplyDto> {
    return this.inbox.createCannedReply(actor(auth), body);
  }

  @Delete('canned-replies/:id')
  @HttpCode(204)
  @RequirePermission(Permission.INBOX_ASSIGN)
  async deleteCannedReply(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.inbox.deleteCannedReply(id);
  }
}
