import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  conversationInclude,
  conversationToDto,
  messageInclude,
  messageToDto,
  type Prisma,
  type TenantTx,
} from '@wacrm/db';
import {
  AppError,
  type CannedReplyDto,
  type ConversationDto,
  type CreateCannedReplyInput,
  createLabelSchema,
  type CursorPage,
  type CursorQuery,
  ErrorCode,
  hasPermission,
  type InboxTemplateDto,
  type LabelDto,
  type ListConversationsQuery,
  type MediaUrlDto,
  mediaRuleFor,
  type MessageDto,
  messagePreview,
  Permission,
  renderTemplateBody,
  type Role,
  type SendMessageParsed,
  type SendNoteInput,
  type UpdateConversationInput,
} from '@wacrm/shared';
import { mediaKey, type ObjectStorage } from '@wacrm/shared/server';
import { type MessageTemplate, WhatsAppClientFactory } from '@wacrm/whatsapp';
import { OBJECT_STORAGE } from '../infra/infra.tokens';
import { QueuesService } from '../infra/queues.service';
import { decodeCursor, encodeCursor } from '../orgs/cursor';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service';

export interface InboxActor {
  userId: string;
  orgId: string;
  role: Role;
}

const MEDIA_URL_TTL_SECONDS = 300;

interface OutboundDraft {
  clientMessageId: string;
  type: string;
  body: string | null;
  content?: Prisma.InputJsonValue;
  messageId?: string;
  media?: { key: string; mime: string; size: number; filename: string | null };
}

/** What can be sent from the picker today: body variables only. */
function toInboxTemplate(t: MessageTemplate): InboxTemplateDto | null {
  const parts = t.components as {
    type?: string;
    format?: string;
    text?: string;
    buttons?: unknown;
  }[];
  const body = parts.find((c) => c.type === 'BODY')?.text;
  if (!body || /\{\{\s*[^\d\s}]/.test(body)) return null;
  const header = parts.find((c) => c.type === 'HEADER');
  if (header && (header.format !== 'TEXT' || header.text?.includes('{{'))) return null;
  const buttons = parts.find((c) => c.type === 'BUTTONS');
  if (JSON.stringify(buttons?.buttons ?? []).includes('{{')) return null;
  return {
    name: t.name,
    language: t.language,
    category: t.category,
    body,
    paramCount: renderTemplateBody(body, []).paramCount,
  };
}

@Injectable()
export class InboxService {
  private readonly logger = new Logger(InboxService.name);

  constructor(
    private readonly db: TenantPrismaService,
    private readonly queues: QueuesService,
    private readonly realtime: RealtimeGateway,
    private readonly whatsapp: WhatsAppClientFactory,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  // ------------------------------------------------------------------ conversations

  async listConversations(
    actor: InboxActor,
    q: ListConversationsQuery,
  ): Promise<CursorPage<ConversationDto>> {
    const cursor = q.cursor ? decodeCursor(q.cursor) : null;
    const where: Prisma.ConversationWhereInput = {
      ...(q.status === 'any' ? {} : { status: q.status }),
      ...(q.filter === 'mine' ? { assigneeId: actor.userId } : {}),
      ...(q.filter === 'unassigned' ? { assigneeId: null } : {}),
      ...(cursor
        ? {
            OR: [
              { lastMessageAt: { lt: cursor.createdAt } },
              { lastMessageAt: cursor.createdAt, id: { lt: cursor.id } },
            ],
          }
        : {}),
    };
    const rows = await this.db.run((tx) =>
      tx.conversation.findMany({
        where,
        orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
        take: q.limit + 1,
        include: conversationInclude,
      }),
    );
    const page = rows.slice(0, q.limit);
    const last = page.at(-1);
    return {
      items: page.map(conversationToDto),
      nextCursor:
        rows.length > q.limit && last?.lastMessageAt
          ? encodeCursor({ createdAt: last.lastMessageAt, id: last.id })
          : null,
    };
  }

  private async loadConversation(tx: TenantTx, id: string) {
    const row = await tx.conversation.findUnique({ where: { id }, include: conversationInclude });
    if (!row) throw new AppError(ErrorCode.NOT_FOUND, 'Conversation not found');
    return row;
  }

  async getConversation(id: string): Promise<ConversationDto> {
    return conversationToDto(await this.db.run((tx) => this.loadConversation(tx, id)));
  }

  async updateConversation(
    actor: InboxActor,
    id: string,
    input: UpdateConversationInput,
  ): Promise<ConversationDto> {
    const updated = await this.db.run(async (tx) => {
      const current = await this.loadConversation(tx, id);
      if (input.assigneeId !== undefined) {
        const canAssign = hasPermission(actor.role, Permission.INBOX_ASSIGN);
        // Without the permission: take an unassigned conversation, or release your own.
        const selfService =
          (input.assigneeId === actor.userId && !current.assigneeId) ||
          (input.assigneeId === null && current.assigneeId === actor.userId);
        if (!canAssign && !selfService) {
          throw new AppError(ErrorCode.FORBIDDEN, 'You cannot reassign this conversation');
        }
        if (input.assigneeId) {
          const member = await tx.membership.findUnique({
            where: { orgId_userId: { orgId: actor.orgId, userId: input.assigneeId } },
            select: { status: true },
          });
          if (member?.status !== 'active') {
            throw new AppError(ErrorCode.VALIDATION_FAILED, 'Assignee is not in this workspace');
          }
        }
      }
      return tx.conversation.update({
        where: { id },
        data: {
          ...(input.status ? { status: input.status } : {}),
          ...(input.assigneeId !== undefined ? { assigneeId: input.assigneeId } : {}),
        },
        include: conversationInclude,
      });
    });
    return this.publishConversation(actor.orgId, updated);
  }

  async markRead(actor: InboxActor, id: string): Promise<ConversationDto> {
    const updated = await this.db.run(async (tx) => {
      await this.loadConversation(tx, id);
      return tx.conversation.update({
        where: { id },
        data: { unreadCount: 0 },
        include: conversationInclude,
      });
    });
    return this.publishConversation(actor.orgId, updated);
  }

  async setLabels(actor: InboxActor, id: string, labelIds: string[]): Promise<ConversationDto> {
    const updated = await this.db.run(async (tx) => {
      await this.loadConversation(tx, id);
      // Under RLS, so another org's label ids simply do not match.
      const labels = await tx.label.findMany({
        where: { id: { in: labelIds } },
        select: { id: true },
      });
      if (labels.length !== new Set(labelIds).size) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, 'Unknown label');
      }
      await tx.conversationLabel.deleteMany({ where: { conversationId: id } });
      await tx.conversationLabel.createMany({
        data: labels.map((l) => ({ orgId: actor.orgId, conversationId: id, labelId: l.id })),
      });
      return this.loadConversation(tx, id);
    });
    return this.publishConversation(actor.orgId, updated);
  }

  private publishConversation(
    orgId: string,
    row: Parameters<typeof conversationToDto>[0],
  ): ConversationDto {
    const conversation = conversationToDto(row);
    this.realtime.emit(orgId, 'conversation:updated', { conversation });
    return conversation;
  }

  // ------------------------------------------------------------------ messages

  /** Newest first. Pages by (created_at, id): never offset, on a partitioned table. */
  async listMessages(id: string, q: CursorQuery): Promise<CursorPage<MessageDto>> {
    const cursor = q.cursor ? decodeCursor(q.cursor) : null;
    const rows = await this.db.run(async (tx) => {
      await this.loadConversation(tx, id);
      return tx.message.findMany({
        where: {
          conversationId: id,
          ...(cursor
            ? {
                OR: [
                  { createdAt: { lt: cursor.createdAt } },
                  { createdAt: cursor.createdAt, id: { lt: cursor.id } },
                ],
              }
            : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: q.limit + 1,
        include: messageInclude,
      });
    });
    const page = rows.slice(0, q.limit);
    const last = page.at(-1);
    return {
      items: page.map(messageToDto),
      nextCursor:
        rows.length > q.limit && last
          ? encodeCursor({ createdAt: last.createdAt, id: last.id })
          : null,
    };
  }

  /** Checks shared by every outbound send. The server is the authority on the 24-hour window. */
  private async loadForSend(id: string, needsWindow: boolean) {
    const conversation = await this.db.run((tx) =>
      tx.conversation.findUnique({
        where: { id },
        select: {
          windowExpiresAt: true,
          phone: { select: { phoneNumberId: true, status: true } },
        },
      }),
    );
    if (!conversation) throw new AppError(ErrorCode.NOT_FOUND, 'Conversation not found');
    if (conversation.phone.status !== 'connected') {
      throw new AppError(ErrorCode.NUMBER_NOT_CONNECTED, 'This WhatsApp number is not connected');
    }
    if (needsWindow) {
      const open = conversation.windowExpiresAt && conversation.windowExpiresAt > new Date();
      if (!open) {
        throw new AppError(
          ErrorCode.WINDOW_CLOSED,
          'The 24-hour window has closed. Send an approved template instead.',
          { windowExpiresAt: conversation.windowExpiresAt?.toISOString() ?? null },
        );
      }
    }
    return conversation;
  }

  async sendMessage(
    actor: InboxActor,
    conversationId: string,
    input: SendMessageParsed,
  ): Promise<MessageDto> {
    if (input.type === 'text') {
      await this.loadForSend(conversationId, true);
      return this.createOutbound(actor, conversationId, {
        clientMessageId: input.clientMessageId,
        type: 'text',
        body: input.body,
      });
    }

    const { phone } = await this.loadForSend(conversationId, false);
    const template = await this.findTemplate(actor, phone.phoneNumberId, input);
    const { paramCount, text } = renderTemplateBody(template.body, input.bodyParams);
    if (paramCount !== input.bodyParams.length) {
      throw new AppError(
        ErrorCode.TEMPLATE_NOT_SENDABLE,
        `This template needs ${paramCount} value(s)`,
      );
    }
    return this.createOutbound(actor, conversationId, {
      clientMessageId: input.clientMessageId,
      type: 'template',
      body: text,
      content: {
        templateName: input.templateName,
        language: input.language,
        bodyParams: input.bodyParams,
      },
    });
  }

  async sendMedia(
    actor: InboxActor,
    conversationId: string,
    file: { bytes: Buffer; mimeType: string; filename: string | null },
    fields: { clientMessageId: string; caption?: string },
  ): Promise<MessageDto> {
    const existing = await this.findByClientId(fields.clientMessageId);
    if (existing) return existing;

    const rule = mediaRuleFor(file.mimeType);
    if (!rule) {
      throw new AppError(ErrorCode.MEDIA_NOT_ALLOWED, 'WhatsApp does not accept this file type');
    }
    if (file.bytes.length > rule.maxBytes) {
      const mb = Math.round(rule.maxBytes / (1024 * 1024));
      throw new AppError(ErrorCode.MEDIA_NOT_ALLOWED, `This file is over the ${mb} MB limit`);
    }
    await this.loadForSend(conversationId, true);

    const messageId = randomUUID();
    const key = mediaKey(actor.orgId, messageId);
    await this.storage.put(key, file.bytes, rule.mimeType);
    return this.createOutbound(actor, conversationId, {
      clientMessageId: fields.clientMessageId,
      messageId,
      type: rule.kind,
      body: fields.caption || null,
      media: {
        key,
        mime: rule.mimeType,
        size: file.bytes.length,
        filename: file.filename?.slice(0, 200) ?? null,
      },
    });
  }

  private async findByClientId(clientMessageId: string): Promise<MessageDto | null> {
    const row = await this.db.run(async (tx) => {
      const ref = await tx.messageRef.findFirst({
        where: { kind: 'client', ref: clientMessageId },
      });
      if (!ref) return null;
      return tx.message.findUnique({
        where: { id_createdAt: { id: ref.messageId, createdAt: ref.messageCreatedAt } },
        include: messageInclude,
      });
    });
    return row ? messageToDto(row) : null;
  }

  /** Save as queued and hand to the worker. The same clientMessageId never sends twice. */
  private async createOutbound(
    actor: InboxActor,
    conversationId: string,
    draft: OutboundDraft,
  ): Promise<MessageDto> {
    const messageId = draft.messageId ?? randomUUID();
    const createdAt = new Date();
    const preview = messagePreview(draft.type, draft.body);

    const saved = await this.db.run(async (tx) => {
      const claim = await tx.messageRef.createMany({
        data: {
          orgId: actor.orgId,
          kind: 'client',
          ref: draft.clientMessageId,
          messageId,
          messageCreatedAt: createdAt,
        },
        skipDuplicates: true,
      });
      if (claim.count === 0) return null;
      const message = await tx.message.create({
        data: {
          id: messageId,
          createdAt,
          orgId: actor.orgId,
          conversationId,
          direction: 'outbound',
          type: draft.type,
          status: 'queued',
          body: draft.body,
          content: draft.content,
          senderUserId: actor.userId,
          ...(draft.media
            ? {
                mediaKey: draft.media.key,
                mediaMime: draft.media.mime,
                mediaSize: draft.media.size,
                mediaFilename: draft.media.filename,
                mediaStatus: 'stored' as const,
              }
            : {}),
        },
        include: messageInclude,
      });
      const conversation = await tx.conversation.update({
        where: { id: conversationId },
        data: { lastMessageAt: createdAt, lastMessagePreview: preview, status: 'open' },
        include: conversationInclude,
      });
      return { message, conversation };
    });
    if (!saved) {
      const existing = await this.findByClientId(draft.clientMessageId);
      if (!existing) throw new AppError(ErrorCode.INTERNAL, 'Could not load the message');
      return existing;
    }

    let dto = messageToDto(saved.message);
    this.realtime.emit(actor.orgId, 'message:new', { message: dto });
    this.publishConversation(actor.orgId, saved.conversation);

    try {
      await this.queues.enqueueOutbound({
        orgId: actor.orgId,
        messageId,
        createdAt: createdAt.toISOString(),
      });
    } catch (err) {
      // Never leave a message stuck as "queued": show the agent it did not go out.
      this.logger.error(`could not queue a message: ${String(err)}`);
      const failed = await this.db.run((tx) =>
        tx.message.update({
          where: { id_createdAt: { id: messageId, createdAt } },
          data: {
            status: 'failed',
            errorCode: ErrorCode.INTERNAL,
            errorMessage: 'Could not queue this message. Please try again.',
            failedAt: new Date(),
          },
          include: messageInclude,
        }),
      );
      dto = messageToDto(failed);
      this.realtime.emit(actor.orgId, 'message:updated', { message: dto });
    }
    return dto;
  }

  /** Internal notes stay in the thread. They never reach the customer or the queue. */
  async addNote(
    actor: InboxActor,
    conversationId: string,
    input: SendNoteInput,
  ): Promise<MessageDto> {
    const messageId = randomUUID();
    const createdAt = new Date();
    const row = await this.db.run(async (tx) => {
      await this.loadConversation(tx, conversationId);
      const claim = await tx.messageRef.createMany({
        data: {
          orgId: actor.orgId,
          kind: 'client',
          ref: input.clientMessageId,
          messageId,
          messageCreatedAt: createdAt,
        },
        skipDuplicates: true,
      });
      if (claim.count === 0) return null;
      return tx.message.create({
        data: {
          id: messageId,
          createdAt,
          orgId: actor.orgId,
          conversationId,
          direction: 'internal',
          type: 'note',
          status: 'sent',
          body: input.body,
          senderUserId: actor.userId,
        },
        include: messageInclude,
      });
    });
    if (!row) {
      const existing = await this.findByClientId(input.clientMessageId);
      if (!existing) throw new AppError(ErrorCode.INTERNAL, 'Could not load the note');
      return existing;
    }
    const message = messageToDto(row);
    this.realtime.emit(actor.orgId, 'message:new', { message });
    return message;
  }

  async mediaUrl(conversationId: string, messageId: string): Promise<MediaUrlDto> {
    const row = await this.db.run((tx) =>
      tx.message.findFirst({
        where: { id: messageId, conversationId },
        select: { mediaKey: true, mediaStatus: true, mediaMime: true, mediaFilename: true },
      }),
    );
    if (!row?.mediaKey || row.mediaStatus !== 'stored') {
      throw new AppError(ErrorCode.NOT_FOUND, 'Media is not available');
    }
    const inline = /^(image\/(jpeg|png|webp)|video\/|audio\/)/.test(row.mediaMime ?? '');
    return {
      url: await this.storage.signedUrl(row.mediaKey, {
        expiresIn: MEDIA_URL_TTL_SECONDS,
        filename: row.mediaFilename,
        inline,
      }),
      expiresIn: MEDIA_URL_TTL_SECONDS,
    };
  }

  // ------------------------------------------------------------------ templates

  private gatewayFailure(message: string): AppError {
    return new AppError(ErrorCode.WHATSAPP_META_ERROR, message);
  }

  async listTemplates(actor: InboxActor, conversationId: string): Promise<InboxTemplateDto[]> {
    const { phone } = await this.loadForSend(conversationId, false);
    const gateway = await this.whatsapp.get({
      orgId: actor.orgId,
      phoneNumberId: phone.phoneNumberId,
    });
    const res = await gateway.listTemplates({ status: 'APPROVED', limit: 100 });
    if (res.error) throw this.gatewayFailure(res.error.message);
    return res.data.items
      .filter((t) => t.status === 'APPROVED')
      .map(toInboxTemplate)
      .filter((t): t is InboxTemplateDto => t !== null);
  }

  private async findTemplate(
    actor: InboxActor,
    phoneNumberId: string,
    input: { templateName: string; language: string },
  ): Promise<InboxTemplateDto> {
    const gateway = await this.whatsapp.get({ orgId: actor.orgId, phoneNumberId });
    const res = await gateway.listTemplates({ name: input.templateName, limit: 100 });
    if (res.error) throw this.gatewayFailure(res.error.message);
    const match = res.data.items.find(
      (t) =>
        t.name === input.templateName && t.language === input.language && t.status === 'APPROVED',
    );
    const template = match ? toInboxTemplate(match) : null;
    if (!template) {
      throw new AppError(
        ErrorCode.TEMPLATE_NOT_SENDABLE,
        'This template is not approved, or cannot be sent from the inbox yet',
      );
    }
    return template;
  }

  // ------------------------------------------------------------------ labels and canned replies

  async listLabels(): Promise<LabelDto[]> {
    return this.db.run((tx) =>
      tx.label.findMany({
        orderBy: { name: 'asc' },
        select: { id: true, name: true, color: true },
      }),
    );
  }

  async createLabel(actor: InboxActor, input: ReturnType<typeof createLabelSchema.parse>) {
    return this.uniqueGuard('A label with this name already exists', () =>
      this.db.run((tx) =>
        tx.label.create({
          data: { orgId: actor.orgId, name: input.name, color: input.color },
          select: { id: true, name: true, color: true },
        }),
      ),
    );
  }

  async deleteLabel(id: string): Promise<void> {
    const res = await this.db.run((tx) => tx.label.deleteMany({ where: { id } }));
    if (res.count === 0) throw new AppError(ErrorCode.NOT_FOUND, 'Label not found');
  }

  async listCannedReplies(): Promise<CannedReplyDto[]> {
    return this.db.run((tx) =>
      tx.cannedReply.findMany({
        orderBy: { shortcut: 'asc' },
        select: { id: true, shortcut: true, body: true },
      }),
    );
  }

  async createCannedReply(actor: InboxActor, input: CreateCannedReplyInput) {
    return this.uniqueGuard('This shortcut is already in use', () =>
      this.db.run((tx) =>
        tx.cannedReply.create({
          data: {
            orgId: actor.orgId,
            shortcut: input.shortcut,
            body: input.body,
            createdById: actor.userId,
          },
          select: { id: true, shortcut: true, body: true },
        }),
      ),
    );
  }

  async deleteCannedReply(id: string): Promise<void> {
    const res = await this.db.run((tx) => tx.cannedReply.deleteMany({ where: { id } }));
    if (res.count === 0) throw new AppError(ErrorCode.NOT_FOUND, 'Canned reply not found');
  }

  private async uniqueGuard<T>(message: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        throw new AppError(ErrorCode.CONFLICT, message);
      }
      throw err;
    }
  }
}
