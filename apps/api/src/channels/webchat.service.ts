import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  conversationToDto,
  hasFeature,
  messageInclude,
  messageToDto,
  recordInbound,
  type TenantTx,
  toWebchatMessage,
  withTenant,
} from '@wacrm/db';
import {
  AppError,
  ErrorCode,
  type WebchatConfig,
  webchatConfigSchema,
  type WebchatMessageDto,
  type WebchatMessageInput,
  type WebchatSessionDto,
} from '@wacrm/shared';
import { PrismaService } from '../db/prisma.service';
import { API_ENV, type ApiEnv } from '../env';
import { QueuesService } from '../infra/queues.service';
import { RateLimiter } from '../infra/rate-limiter.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';

interface WidgetChannel {
  id: string;
  orgId: string;
  name: string;
  config: WebchatConfig;
}

const HISTORY = 50;

/**
 * The website chat widget's side of the API. Public: a visitor proves who they are with a token
 * the API signed for this channel. Nothing here reads an org until the widget key has found its
 * channel through a definer function, and every query then runs in that org's context.
 */
@Injectable()
export class WebchatService {
  constructor(
    @Inject(API_ENV) private readonly env: ApiEnv,
    private readonly prisma: PrismaService,
    private readonly rateLimiter: RateLimiter,
    private readonly queues: QueuesService,
    private readonly realtime: RealtimeGateway,
  ) {}

  // ------------------------------------------------------------------ visitor tokens

  /** `<visitorId>.<HMAC of channel and visitor>`: a token for one widget cannot open another. */
  private sign(channelId: string, visitorId: string): string {
    const mac = createHmac('sha256', this.env.JWT_REFRESH_SECRET)
      .update(`webchat:${channelId}:${visitorId}`)
      .digest('base64url');
    return `${visitorId}.${mac}`;
  }

  /** The visitor id in a valid token, or null. */
  verify(channelId: string, token: string | undefined): string | null {
    const [visitorId] = (token ?? '').split('.');
    if (!visitorId || !/^[A-Za-z0-9_-]{16,40}$/.test(visitorId)) return null;
    const given = Buffer.from(token ?? '');
    const expected = Buffer.from(this.sign(channelId, visitorId));
    return given.length === expected.length && timingSafeEqual(given, expected) ? visitorId : null;
  }

  // ------------------------------------------------------------------ the widget

  /** Find the widget by its public key. Unknown, disconnected or not on the plan reads the same. */
  async channel(key: string): Promise<WidgetChannel> {
    const unavailable = new AppError(ErrorCode.NOT_FOUND, 'This chat is not available');
    if (!/^wc_[A-Za-z0-9_-]{20,40}$/.test(key)) throw unavailable;
    // Reviewed raw SQL: a definer function keyed by the public widget key.
    const [row] = await this.prisma.client.$queryRaw<
      { id: string; org_id: string; name: string; config: unknown }[]
    >`SELECT id, org_id, name, config FROM webchat_channel_lookup(${key})`;
    if (!row) throw unavailable;
    const allowed = await withTenant(this.prisma.client, { orgId: row.org_id }, async (tx) => {
      const org = await tx.organization.findUnique({
        where: { id: row.org_id },
        select: { status: true, deletedAt: true },
      });
      if (!org || org.deletedAt || org.status !== 'active') return false;
      return hasFeature(tx, row.org_id, 'webchat');
    });
    if (!allowed) throw unavailable;
    return {
      id: row.id,
      orgId: row.org_id,
      name: row.name,
      config: webchatConfigSchema.parse(row.config ?? {}),
    };
  }

  /**
   * Start or resume a visitor. An empty list of allowed sites allows any; otherwise the page
   * embedding the widget must be one of them. The browser reports that page, so this keeps
   * casual copies off other sites rather than stopping a determined script.
   */
  async session(
    key: string,
    input: { token?: string; origin?: string },
    ip: string | null,
  ): Promise<WebchatSessionDto> {
    await this.rateLimiter.consume(`rl:webchat:session:ip:${ip}`, 120, 3600);
    const channel = await this.channel(key);
    const allowed = channel.config.allowedOrigins;
    const origin = (input.origin ?? '').replace(/\/$/, '');
    if (allowed.length > 0 && !allowed.includes(origin)) {
      throw new AppError(ErrorCode.FORBIDDEN, 'This chat is not available on this site');
    }
    const visitorId = this.verify(channel.id, input.token) ?? randomBytes(16).toString('base64url');
    const started = await withTenant(this.prisma.client, { orgId: channel.orgId }, (tx) =>
      tx.contactIdentity.count({ where: { channelId: channel.id, externalId: visitorId } }),
    );
    const { color, title, greeting, askDetails } = channel.config;
    return {
      token: this.sign(channel.id, visitorId),
      channel: { name: channel.name, color, title, greeting, askDetails },
      started: started > 0,
    };
  }

  private async visitor(key: string, token: string) {
    const channel = await this.channel(key);
    const visitorId = this.verify(channel.id, token);
    if (!visitorId) throw new AppError(ErrorCode.UNAUTHENTICATED, 'Start a new chat');
    return { channel, visitorId };
  }

  /** The visitor's own conversation, newest last. Internal notes never leave the server. */
  async messages(key: string, token: string): Promise<WebchatMessageDto[]> {
    const { channel, visitorId } = await this.visitor(key, token);
    const rows = await withTenant(this.prisma.client, { orgId: channel.orgId }, async (tx) => {
      const conversationId = await this.conversationOf(tx, channel.orgId, channel.id, visitorId);
      if (!conversationId) return [];
      return tx.message.findMany({
        where: { conversationId, direction: { in: ['inbound', 'outbound'] } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: HISTORY,
        include: messageInclude,
      });
    });
    return rows
      .reverse()
      .map(toWebchatMessage)
      .filter((m): m is WebchatMessageDto => m !== null);
  }

  /** The conversation id of this visitor on this widget, for their socket room. */
  async conversationFor(key: string, token: string): Promise<{ conversationId: string | null }> {
    const { channel, visitorId } = await this.visitor(key, token);
    const conversationId = await withTenant(this.prisma.client, { orgId: channel.orgId }, (tx) =>
      this.conversationOf(tx, channel.orgId, channel.id, visitorId),
    );
    return { conversationId };
  }

  private async conversationOf(
    tx: TenantTx,
    orgId: string,
    channelId: string,
    visitorId: string,
  ): Promise<string | null> {
    const identity = await tx.contactIdentity.findUnique({
      where: { channelId_externalId: { channelId, externalId: visitorId } },
      select: { contact: { select: { id: true, mergedIntoId: true } } },
    });
    if (!identity) return null;
    const contactId = identity.contact.mergedIntoId ?? identity.contact.id;
    const conversation = await tx.conversation.findUnique({
      where: { orgId_channelId_contactId: { orgId, channelId, contactId } },
      select: { id: true },
    });
    return conversation?.id ?? null;
  }

  /**
   * A visitor's message. The same pipeline as WhatsApp and Instagram: saved once per client id,
   * then the rules and flows run in the worker.
   */
  async send(
    key: string,
    input: WebchatMessageInput,
    ip: string | null,
  ): Promise<WebchatMessageDto> {
    const { channel, visitorId } = await this.visitor(key, input.token);
    await this.rateLimiter.consume(`rl:webchat:visitor:${visitorId}`, 30, 60);
    await this.rateLimiter.consume(`rl:webchat:ip:${ip}`, 120, 60);
    const messageId = randomUUID();
    const createdAt = new Date();
    const saved = await withTenant(this.prisma.client, { orgId: channel.orgId }, (tx) =>
      recordInbound(tx, {
        orgId: channel.orgId,
        channel: { id: channel.id, kind: 'webchat', phoneId: null },
        sender: {
          externalId: visitorId,
          name: input.name ?? null,
          email: input.email ?? null,
        },
        ref: { kind: 'webchat', id: input.clientMessageId },
        sentAt: createdAt,
        messageId,
        createdAt,
        type: input.replyId ? 'interactive' : 'text',
        body: input.body,
        content: input.replyId
          ? { reply: { kind: 'button_reply', id: input.replyId, title: input.body } }
          : undefined,
      }),
    );
    if (!saved) throw new AppError(ErrorCode.INTERNAL, 'The message was not saved');
    if (saved.kind === 'duplicate') {
      const row = await withTenant(this.prisma.client, { orgId: channel.orgId }, (tx) =>
        tx.message.findUniqueOrThrow({
          where: { id_createdAt: { id: saved.messageId, createdAt: saved.messageCreatedAt } },
          include: messageInclude,
        }),
      );
      return toWebchatMessage(row)!;
    }
    this.realtime.emit(channel.orgId, 'message:new', { message: messageToDto(saved.message) });
    this.realtime.emit(channel.orgId, 'conversation:updated', {
      conversation: conversationToDto(saved.conversation),
    });
    await this.queues.enqueueAutomation({
      orgId: channel.orgId,
      messageId: saved.message.id,
      createdAt: saved.message.createdAt.toISOString(),
    });
    return toWebchatMessage(saved.message)!;
  }
}
