import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  adsReport as adsAttributionReport,
  callBody,
  callInclude,
  callToDto,
  conversationInclude,
  conversationToDto,
  messageInclude,
  messageToDto,
  type TenantTx,
} from '@wacrm/db';
import {
  type AdsReportDto,
  AppError,
  type CallDto,
  type CallingSettingsDto,
  type CallingSettingsInput,
  type CallPermissionDto,
  type CatalogDto,
  type CreateGroupInput,
  type CreateQrCodeInput,
  ErrorCode,
  type GroupDto,
  type GroupJoinRequestDto,
  lastDays,
  type MessageDto,
  type QrCodeDto,
  type SendProductsInput,
} from '@wacrm/shared';
import { type WhatsAppError, WhatsAppClientFactory, type WhatsAppGateway } from '@wacrm/whatsapp';
import QRCode from 'qrcode';
import { AuditAction, AuditService } from '../audit/audit.service';
import type { RequestMeta } from '../common/request-meta';
import { RateLimiter } from '../infra/rate-limiter.service';
import { type InboxActor, InboxService } from '../inbox/inbox.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service';

export interface ModuleActor {
  userId: string;
  orgId: string;
  role: InboxActor['role'];
  meta?: RequestMeta;
}

const metaFailure = (err: WhatsAppError): AppError =>
  new AppError(ErrorCode.WHATSAPP_META_ERROR, err.message, {
    whatsappCode: err.code,
    metaCode: err.metaCode,
  });

/** Unwrap a gateway result, turning Meta's refusal into a clear error. */
async function meta<T>(
  call: Promise<{ data: T; error: null } | { data: null; error: WhatsAppError }>,
): Promise<T> {
  const res = await call;
  if (res.error) throw metaFailure(res.error);
  return res.data as T;
}

const MAX_CATALOG_PAGES = 20;

/**
 * Extended WhatsApp modules: QR codes and short links, catalog and product messages, groups,
 * calling and the ad attribution report. Calls to Meta happen outside transactions; what is
 * stored follows what Meta accepted.
 */
@Injectable()
export class WaModulesService {
  constructor(
    private readonly db: TenantPrismaService,
    private readonly factory: WhatsAppClientFactory,
    private readonly audit: AuditService,
    private readonly inbox: InboxService,
    private readonly realtime: RealtimeGateway,
    private readonly rateLimiter: RateLimiter,
  ) {}

  /** A connected number of this workspace, and its gateway. */
  private async number(orgId: string, phoneId: string) {
    const phone = await this.db.run((tx) =>
      tx.phoneNumber.findUnique({
        where: { id: phoneId },
        select: { id: true, phoneNumberId: true, status: true, wabaAccountId: true },
      }),
    );
    if (!phone) throw new AppError(ErrorCode.NOT_FOUND, 'Number not found');
    if (phone.status !== 'connected') {
      throw new AppError(ErrorCode.NUMBER_NOT_CONNECTED, 'This WhatsApp number is not connected');
    }
    const gateway = await this.factory.get({ orgId, phoneNumberId: phone.phoneNumberId });
    return { phone, gateway };
  }

  // ------------------------------------------------------------------ QR codes and short links

  async listQrCodes(): Promise<QrCodeDto[]> {
    const { rows, counts } = await this.db.run(async (tx) => {
      const rows = await tx.qrCode.findMany({
        where: { deletedAt: null },
        orderBy: { createdAt: 'desc' },
      });
      const counts = await tx.adReferral.groupBy({
        by: ['sourceId'],
        where: { sourceType: 'qr', sourceId: { in: rows.map((r) => r.id) } },
        _count: { conversationId: true },
      });
      return { rows, counts };
    });
    const started = new Map(counts.map((c) => [c.sourceId, c._count.conversationId]));
    return Promise.all(
      rows.map(async (r) => ({
        id: r.id,
        phoneId: r.phoneId,
        name: r.name,
        prefilledMessage: r.prefilledMessage,
        deepLinkUrl: r.deepLinkUrl,
        svg: await QRCode.toString(r.deepLinkUrl, {
          type: 'svg',
          margin: 1,
          errorCorrectionLevel: 'M',
        }),
        conversationsStarted: started.get(r.id) ?? 0,
        createdAt: r.createdAt.toISOString(),
      })),
    );
  }

  async createQrCode(actor: ModuleActor, input: CreateQrCodeInput): Promise<QrCodeDto[]> {
    const { gateway } = await this.number(actor.orgId, input.phoneId);
    const created = await meta(gateway.createQrCode(input.prefilledMessage));
    await this.db.run(async (tx) => {
      const row = await tx.qrCode.create({
        data: {
          orgId: actor.orgId,
          phoneId: input.phoneId,
          code: created.code,
          name: input.name,
          prefilledMessage: created.prefilledMessage,
          deepLinkUrl: created.deepLinkUrl,
          createdById: actor.userId,
        },
      });
      await this.audit.record(tx, actor.orgId, {
        action: AuditAction.QR_CODE_CHANGED,
        actorUserId: actor.userId,
        targetType: 'qr_code',
        targetId: row.id,
        metadata: { change: 'created', name: input.name },
        meta: actor.meta,
      });
    });
    return this.listQrCodes();
  }

  async updateQrCode(
    actor: ModuleActor,
    id: string,
    input: { name?: string; prefilledMessage?: string },
  ): Promise<QrCodeDto[]> {
    const row = await this.db.run((tx) => tx.qrCode.findFirst({ where: { id, deletedAt: null } }));
    if (!row) throw new AppError(ErrorCode.NOT_FOUND, 'QR code not found');
    let deepLinkUrl = row.deepLinkUrl;
    if (input.prefilledMessage && input.prefilledMessage !== row.prefilledMessage) {
      const { gateway } = await this.number(actor.orgId, row.phoneId);
      deepLinkUrl = (await meta(gateway.updateQrCode(row.code, input.prefilledMessage)))
        .deepLinkUrl;
    }
    await this.db.run(async (tx) => {
      await tx.qrCode.update({
        where: { id },
        data: {
          ...(input.name ? { name: input.name } : {}),
          ...(input.prefilledMessage ? { prefilledMessage: input.prefilledMessage } : {}),
          deepLinkUrl,
        },
      });
      await this.audit.record(tx, actor.orgId, {
        action: AuditAction.QR_CODE_CHANGED,
        actorUserId: actor.userId,
        targetType: 'qr_code',
        targetId: id,
        metadata: { change: 'updated', ...input },
        meta: actor.meta,
      });
    });
    return this.listQrCodes();
  }

  /** The link stops working at Meta. Its history in the report stays. */
  async deleteQrCode(actor: ModuleActor, id: string): Promise<void> {
    const row = await this.db.run((tx) => tx.qrCode.findFirst({ where: { id, deletedAt: null } }));
    if (!row) throw new AppError(ErrorCode.NOT_FOUND, 'QR code not found');
    const { gateway } = await this.number(actor.orgId, row.phoneId);
    await meta(gateway.deleteQrCode(row.code));
    await this.db.run(async (tx) => {
      await tx.qrCode.update({ where: { id }, data: { deletedAt: new Date() } });
      await this.audit.record(tx, actor.orgId, {
        action: AuditAction.QR_CODE_CHANGED,
        actorUserId: actor.userId,
        targetType: 'qr_code',
        targetId: id,
        metadata: { change: 'deleted', name: row.name },
        meta: actor.meta,
      });
    });
  }

  // ------------------------------------------------------------------ catalog

  async catalog(phoneId: string): Promise<CatalogDto> {
    return this.db.run(async (tx) => {
      const phone = await tx.phoneNumber.findUnique({
        where: { id: phoneId },
        select: { wabaAccount: { select: { catalogId: true, catalogSyncedAt: true } } },
      });
      if (!phone) throw new AppError(ErrorCode.NOT_FOUND, 'Number not found');
      const { catalogId, catalogSyncedAt } = phone.wabaAccount;
      const products = catalogId
        ? await tx.catalogProduct.findMany({
            where: { catalogId },
            orderBy: { name: 'asc' },
            take: 1000,
          })
        : [];
      return {
        catalogId,
        syncedAt: catalogSyncedAt?.toISOString() ?? null,
        products: products.map((p) => ({
          retailerId: p.retailerId,
          name: p.name,
          description: p.description,
          price: p.price,
          imageUrl: p.imageUrl,
          availability: p.availability,
        })),
      };
    });
  }

  /**
   * Copy the connected catalog for the picker. Products gone from Meta are removed here. Reads
   * at most 2,000 products; a larger catalog is still sendable by SKU.
   */
  async syncCatalog(actor: ModuleActor, phoneId: string): Promise<CatalogDto> {
    const { phone, gateway } = await this.number(actor.orgId, phoneId);
    const connected = await meta(gateway.getConnectedCatalog());
    const products: Awaited<ReturnType<WhatsAppGateway['listProducts']>>['data'] extends infer T
      ? T extends { items: infer I }
        ? I
        : never
      : never = [];
    if (connected) {
      let after: string | undefined;
      for (let page = 0; page < MAX_CATALOG_PAGES; page++) {
        const res = await meta(gateway.listProducts(connected.id, after));
        products.push(...res.items);
        if (!res.nextCursor) break;
        after = res.nextCursor;
      }
    }
    const now = new Date();
    await this.db.run(
      async (tx) => {
        await tx.wabaAccount.update({
          where: { id: phone.wabaAccountId },
          data: { catalogId: connected?.id ?? null, catalogSyncedAt: now },
        });
        if (connected) {
          for (const p of products) {
            const data = {
              name: p.name.slice(0, 300),
              description: p.description?.slice(0, 2000) ?? null,
              price: p.price,
              currency: p.currency,
              imageUrl: p.imageUrl,
              availability: p.availability,
              syncedAt: now,
            };
            await tx.catalogProduct.upsert({
              where: {
                orgId_catalogId_retailerId: {
                  orgId: actor.orgId,
                  catalogId: connected.id,
                  retailerId: p.retailerId,
                },
              },
              create: {
                orgId: actor.orgId,
                catalogId: connected.id,
                retailerId: p.retailerId,
                ...data,
              },
              update: data,
            });
          }
        }
        await tx.catalogProduct.deleteMany({
          where: connected
            ? {
                OR: [
                  { catalogId: { not: connected.id } },
                  { catalogId: connected.id, syncedAt: { lt: now } },
                ],
              }
            : {},
        });
        await this.audit.record(tx, actor.orgId, {
          action: AuditAction.CATALOG_SYNCED,
          actorUserId: actor.userId,
          metadata: { catalogId: connected?.id ?? null, products: products.length },
          meta: actor.meta,
        });
      },
      { timeout: 60_000 },
    );
    return this.catalog(phoneId);
  }

  async sendProducts(
    actor: ModuleActor,
    conversationId: string,
    input: SendProductsInput,
  ): Promise<MessageDto> {
    const catalogId = await this.db.run(async (tx) => {
      const conversation = await tx.conversation.findUnique({
        where: { id: conversationId },
        select: { phone: { select: { wabaAccount: { select: { catalogId: true } } } } },
      });
      if (!conversation) throw new AppError(ErrorCode.NOT_FOUND, 'Conversation not found');
      return conversation.phone?.wabaAccount.catalogId ?? null;
    });
    if (!catalogId) {
      throw new AppError(
        ErrorCode.VALIDATION_FAILED,
        'No catalog is connected to this number. Sync the catalog in Settings > Catalog first.',
      );
    }
    return this.inbox.sendProducts(actor, conversationId, input, catalogId);
  }

  // ------------------------------------------------------------------ groups

  private toGroup(g: {
    id: string;
    phoneId: string;
    groupId: string | null;
    subject: string;
    description: string | null;
    joinApprovalMode: string;
    inviteLink: string | null;
    participantCount: number | null;
    status: string;
    createdAt: Date;
  }): GroupDto {
    return {
      id: g.id,
      phoneId: g.phoneId,
      groupId: g.groupId,
      subject: g.subject,
      description: g.description,
      joinApprovalMode: g.joinApprovalMode,
      inviteLink: g.inviteLink,
      participantCount: g.participantCount,
      status: g.status as GroupDto['status'],
      createdAt: g.createdAt.toISOString(),
    };
  }

  async listGroups(): Promise<GroupDto[]> {
    const rows = await this.db.run((tx) =>
      tx.waGroup.findMany({ where: { deletedAt: null }, orderBy: { createdAt: 'desc' } }),
    );
    return rows.map((r) => this.toGroup(r));
  }

  private async group(id: string) {
    const row = await this.db.run((tx) => tx.waGroup.findFirst({ where: { id, deletedAt: null } }));
    if (!row) throw new AppError(ErrorCode.NOT_FOUND, 'Group not found');
    return row;
  }

  private async liveGroup(orgId: string, id: string) {
    const row = await this.group(id);
    if (!row.groupId) {
      throw new AppError(
        ErrorCode.CONFLICT,
        'Meta is still creating this group. Try again shortly.',
      );
    }
    const { gateway } = await this.number(orgId, row.phoneId);
    return { row, groupId: row.groupId, gateway };
  }

  async createGroup(actor: ModuleActor, input: CreateGroupInput): Promise<GroupDto> {
    const { gateway } = await this.number(actor.orgId, input.phoneId);
    const mode = input.joinApprovalMode ?? 'approval_required';
    const created = await meta(
      gateway.createGroup({
        subject: input.subject,
        description: input.description,
        joinApprovalMode: mode,
      }),
    );
    // Meta may report the id now, or only in a group_lifecycle_update webhook.
    const invite = created.groupId
      ? await gateway.getGroupInviteLink(created.groupId)
      : { data: null, error: null };
    const row = await this.db.run(async (tx) => {
      const saved = await tx.waGroup.create({
        data: {
          orgId: actor.orgId,
          phoneId: input.phoneId,
          groupId: created.groupId,
          subject: input.subject,
          description: input.description ?? null,
          joinApprovalMode: mode,
          inviteLink: invite.data?.inviteLink ?? null,
          status: created.groupId ? 'active' : 'pending',
          createdById: actor.userId,
        },
      });
      await this.audit.record(tx, actor.orgId, {
        action: AuditAction.GROUP_CHANGED,
        actorUserId: actor.userId,
        targetType: 'wa_group',
        targetId: saved.id,
        metadata: { change: 'created', subject: input.subject },
        meta: actor.meta,
      });
      return saved;
    });
    return this.toGroup(row);
  }

  /** Read the group back from Meta: participants and invite link. */
  async refreshGroup(actor: ModuleActor, id: string): Promise<GroupDto> {
    const { groupId, gateway } = await this.liveGroup(actor.orgId, id);
    const info = await meta(gateway.getGroup(groupId));
    const invite = await gateway.getGroupInviteLink(groupId);
    const row = await this.db.run((tx) =>
      tx.waGroup.update({
        where: { id },
        data: {
          participantCount: info.participantCount,
          ...(info.subject ? { subject: info.subject } : {}),
          ...(invite.data ? { inviteLink: invite.data.inviteLink } : {}),
          status: 'active',
        },
      }),
    );
    return this.toGroup(row);
  }

  async joinRequests(actor: ModuleActor, id: string): Promise<GroupJoinRequestDto[]> {
    const { groupId, gateway } = await this.liveGroup(actor.orgId, id);
    const rows = await meta(gateway.listGroupJoinRequests(groupId));
    return rows.map((r) => ({ id: r.id, waId: r.waId, requestedAt: r.requestedAt.toISOString() }));
  }

  async answerJoinRequests(
    actor: ModuleActor,
    id: string,
    input: { approve: string[]; reject: string[] },
  ): Promise<GroupJoinRequestDto[]> {
    const { groupId, gateway } = await this.liveGroup(actor.orgId, id);
    await meta(gateway.answerGroupJoinRequests(groupId, input));
    await this.db.run((tx) =>
      this.audit.record(tx, actor.orgId, {
        action: AuditAction.GROUP_CHANGED,
        actorUserId: actor.userId,
        targetType: 'wa_group',
        targetId: id,
        metadata: {
          change: 'join_requests',
          approved: input.approve.length,
          rejected: input.reject.length,
        },
        meta: actor.meta,
      }),
    );
    return this.joinRequests(actor, id);
  }

  async removeParticipants(actor: ModuleActor, id: string, users: string[]): Promise<void> {
    const { groupId, gateway } = await this.liveGroup(actor.orgId, id);
    await meta(gateway.removeGroupParticipants(groupId, users));
    await this.db.run((tx) =>
      this.audit.record(tx, actor.orgId, {
        action: AuditAction.GROUP_CHANGED,
        actorUserId: actor.userId,
        targetType: 'wa_group',
        targetId: id,
        metadata: { change: 'participants_removed', count: users.length },
        meta: actor.meta,
      }),
    );
  }

  /**
   * An announcement to the group. Sent directly rather than through the outbound queue: a group
   * message belongs to no conversation. Limited per group, and recorded in the audit log.
   */
  async sendGroupMessage(
    actor: ModuleActor,
    id: string,
    body: string,
  ): Promise<{ messageId: string }> {
    await this.rateLimiter.consume(`rl:group-message:${id}`, 20, 3600);
    const { groupId, gateway } = await this.liveGroup(actor.orgId, id);
    const sent = await meta(gateway.sendGroupText(groupId, body));
    await this.db.run((tx) =>
      this.audit.record(tx, actor.orgId, {
        action: AuditAction.GROUP_CHANGED,
        actorUserId: actor.userId,
        targetType: 'wa_group',
        targetId: id,
        metadata: { change: 'message_sent', wamid: sent.messageId, length: body.length },
        meta: actor.meta,
      }),
    );
    return { messageId: sent.messageId };
  }

  /** Removes everyone, including the business. Cannot be undone at Meta. */
  async deleteGroup(actor: ModuleActor, id: string): Promise<void> {
    const row = await this.group(id);
    if (row.groupId) {
      const { gateway } = await this.number(actor.orgId, row.phoneId);
      await meta(gateway.deleteGroup(row.groupId));
    }
    await this.db.run(async (tx) => {
      await tx.waGroup.update({
        where: { id },
        data: { status: 'deleted', deletedAt: new Date() },
      });
      await this.audit.record(tx, actor.orgId, {
        action: AuditAction.GROUP_CHANGED,
        actorUserId: actor.userId,
        targetType: 'wa_group',
        targetId: id,
        metadata: { change: 'deleted', subject: row.subject },
        meta: actor.meta,
      });
    });
  }

  // ------------------------------------------------------------------ calling

  async callingSettings(actor: ModuleActor, phoneId: string): Promise<CallingSettingsDto> {
    const { gateway } = await this.number(actor.orgId, phoneId);
    return meta(gateway.getCallingSettings());
  }

  /** Meta says changes can take up to 7 days to reach every WhatsApp app. */
  async updateCallingSettings(
    actor: ModuleActor,
    phoneId: string,
    input: CallingSettingsInput,
  ): Promise<CallingSettingsDto> {
    const { gateway } = await this.number(actor.orgId, phoneId);
    await meta(gateway.updateCallingSettings(input));
    await this.db.run((tx) =>
      this.audit.record(tx, actor.orgId, {
        action: AuditAction.CALLING_CHANGED,
        actorUserId: actor.userId,
        targetType: 'phone_number',
        targetId: phoneId,
        metadata: input,
        meta: actor.meta,
      }),
    );
    return input;
  }

  private async callConversation(conversationId: string) {
    const conversation = await this.db.run((tx) =>
      tx.conversation.findUnique({
        where: { id: conversationId },
        select: {
          id: true,
          contactId: true,
          phone: { select: { id: true } },
          contact: { select: { waId: true } },
        },
      }),
    );
    if (!conversation) throw new AppError(ErrorCode.NOT_FOUND, 'Conversation not found');
    if (!conversation.phone || !conversation.contact.waId) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'Calls are only on WhatsApp');
    }
    return {
      ...conversation,
      phoneId: conversation.phone.id,
      waId: conversation.contact.waId,
    };
  }

  async callPermission(actor: ModuleActor, conversationId: string): Promise<CallPermissionDto> {
    const conv = await this.callConversation(conversationId);
    const { gateway } = await this.number(actor.orgId, conv.phoneId);
    return meta(gateway.getCallPermission(conv.waId));
  }

  async requestCallPermission(
    actor: ModuleActor,
    conversationId: string,
    clientMessageId: string,
  ): Promise<MessageDto> {
    return this.inbox.sendCallPermissionRequest(
      actor,
      conversationId,
      clientMessageId,
      'We would like to call you about your conversation with us. Is that all right?',
    );
  }

  /**
   * Call a customer who gave permission. The browser made the SDP offer; Meta answers by webhook,
   * which reaches the browser over the socket as `call:updated` with `answer`.
   */
  async startCall(actor: ModuleActor, conversationId: string, sdp: string): Promise<CallDto> {
    await this.rateLimiter.consume(`rl:call:user:${actor.userId}`, 30, 3600);
    const conv = await this.callConversation(conversationId);
    const { gateway } = await this.number(actor.orgId, conv.phoneId);
    const started = await meta(gateway.connectCall(conv.waId, sdp));
    if (!started.callId)
      throw new AppError(ErrorCode.WHATSAPP_META_ERROR, 'Meta returned no call id');
    const messageId = randomUUID();
    const createdAt = new Date();
    const { call, message, conversation } = await this.db.run(async (tx) => {
      const message = await tx.message.create({
        data: {
          id: messageId,
          createdAt,
          orgId: actor.orgId,
          conversationId,
          direction: 'outbound',
          type: 'call',
          status: 'sent',
          body: callBody('ringing', null),
          content: { callId: started.callId, direction: 'outbound', status: 'ringing' },
          senderUserId: actor.userId,
        },
        include: messageInclude,
      });
      const call = await tx.call.create({
        data: {
          orgId: actor.orgId,
          conversationId,
          contactId: conv.contactId,
          metaCallId: started.callId,
          direction: 'outbound',
          status: 'ringing',
          answeredById: actor.userId,
          startedAt: createdAt,
          messageId,
          messageCreatedAt: createdAt,
        },
        include: callInclude,
      });
      const conversation = await tx.conversation.update({
        where: { id: conversationId },
        data: { lastMessageAt: createdAt, lastMessagePreview: callBody('ringing', null) },
        include: conversationInclude,
      });
      return { call, message, conversation };
    });
    this.publish(actor.orgId, message, conversation);
    const dto = callToDto(call);
    this.realtime.emit(actor.orgId, 'call:updated', { call: dto });
    return dto;
  }

  private async callRow(tx: TenantTx, id: string) {
    const call = await tx.call.findUnique({ where: { id }, include: callInclude });
    if (!call) throw new AppError(ErrorCode.NOT_FOUND, 'Call not found');
    return call;
  }

  private async phoneOfCall(orgId: string, callId: string) {
    const call = await this.db.run((tx) => this.callRow(tx, callId));
    const conv = await this.callConversation(call.conversationId);
    const { gateway } = await this.number(orgId, conv.phoneId);
    return { call, gateway };
  }

  /** Answer a ringing call with the browser's SDP answer. The first agent to answer gets it. */
  async acceptCall(actor: ModuleActor, callId: string, sdp: string): Promise<CallDto> {
    const { call, gateway } = await this.phoneOfCall(actor.orgId, callId);
    if (call.status !== 'ringing' || call.direction !== 'inbound') {
      throw new AppError(ErrorCode.CONFLICT, 'This call is no longer ringing');
    }
    // Claim before Meta, so two agents cannot both answer.
    const claimed = await this.db.run((tx) =>
      tx.call.updateMany({
        where: { id: callId, status: 'ringing', answeredById: null },
        data: { answeredById: actor.userId },
      }),
    );
    if (claimed.count !== 1) throw new AppError(ErrorCode.CONFLICT, 'Someone else answered');
    const accepted = await gateway.acceptCall(call.metaCallId, sdp);
    if (accepted.error) {
      await this.db.run((tx) =>
        tx.call.update({ where: { id: callId }, data: { answeredById: null } }),
      );
      throw metaFailure(accepted.error);
    }
    return this.setCallStatus(actor.orgId, callId, 'connected');
  }

  async rejectCall(actor: ModuleActor, callId: string): Promise<CallDto> {
    const { call, gateway } = await this.phoneOfCall(actor.orgId, callId);
    if (call.status !== 'ringing')
      throw new AppError(ErrorCode.CONFLICT, 'This call is not ringing');
    await meta(gateway.rejectCall(call.metaCallId));
    return this.setCallStatus(actor.orgId, callId, 'rejected');
  }

  /** Hang up. The final status and duration come with Meta's terminate webhook. */
  async terminateCall(actor: ModuleActor, callId: string): Promise<void> {
    const { call, gateway } = await this.phoneOfCall(actor.orgId, callId);
    if (['ended', 'missed', 'rejected', 'failed'].includes(call.status)) return;
    await meta(gateway.terminateCall(call.metaCallId));
  }

  private async setCallStatus(
    orgId: string,
    callId: string,
    status: 'connected' | 'rejected',
  ): Promise<CallDto> {
    const now = new Date();
    const { call, message, conversation } = await this.db.run(async (tx) => {
      const call = await tx.call.update({
        where: { id: callId },
        data: status === 'connected' ? { status, connectedAt: now } : { status, endedAt: now },
        include: callInclude,
      });
      const message = await tx.message.update({
        where: { id_createdAt: { id: call.messageId, createdAt: call.messageCreatedAt } },
        data: {
          body: callBody(status, null),
          content: { callId: call.metaCallId, direction: call.direction, status },
        },
        include: messageInclude,
      });
      const conversation = await tx.conversation.update({
        where: { id: call.conversationId },
        data: { lastMessagePreview: callBody(status, null) },
        include: conversationInclude,
      });
      return { call, message, conversation };
    });
    this.publish(orgId, message, conversation);
    const dto = callToDto(call);
    this.realtime.emit(orgId, 'call:updated', { call: dto });
    return dto;
  }

  async recentCalls(): Promise<CallDto[]> {
    const rows = await this.db.run((tx) =>
      tx.call.findMany({ orderBy: { startedAt: 'desc' }, take: 50, include: callInclude }),
    );
    return rows.map(callToDto);
  }

  private publish(
    orgId: string,
    message: Parameters<typeof messageToDto>[0],
    conversation: Parameters<typeof conversationToDto>[0],
  ) {
    this.realtime.emit(orgId, 'message:updated', { message: messageToDto(message) });
    this.realtime.emit(orgId, 'conversation:updated', {
      conversation: conversationToDto(conversation),
    });
  }

  // ------------------------------------------------------------------ ad attribution

  /**
   * Click-to-WhatsApp (and Instagram) ads over the last `days`: how many messages each brought,
   * in how many conversations, how many were new people, how many got a reply from the team, and
   * what they bought. From the referrals and the Phase 4.3 records, never the messages table.
   */
  async adsReport(orgId: string, days: number): Promise<AdsReportDto> {
    const report = await this.db.run(async (tx) => {
      const org = await tx.organization.findUniqueOrThrow({
        where: { id: orgId },
        select: { timezone: true },
      });
      return adsAttributionReport(tx, orgId, lastDays(days, org.timezone));
    });
    return { days, currency: report.currency, rows: report.rows };
  }
}
