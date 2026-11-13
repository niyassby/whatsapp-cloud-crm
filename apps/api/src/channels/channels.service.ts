import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma, withTenant } from '@wacrm/db';
import {
  AppError,
  type ChannelDto,
  type ChannelKind,
  type CreateWebchatInput,
  createWebchatSchema,
  ErrorCode,
  type InstagramStartDto,
  type UpdateChannelInput,
  webchatConfigSchema,
} from '@wacrm/shared';
import { channelCredentialsAad, SecretBox } from '@wacrm/shared/server';
import {
  type InstagramAccount,
  type InstagramClient,
  InstagramError,
  type InstagramToken,
} from '@wacrm/whatsapp';
import type { Redis } from 'ioredis';
import { AuditAction, AuditService } from '../audit/audit.service';
import type { RequestMeta } from '../common/request-meta';
import { PrismaService } from '../db/prisma.service';
import { API_ENV, type ApiEnv } from '../env';
import { REDIS } from '../infra/infra.tokens';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service';
import { INSTAGRAM } from './channels.tokens';

export interface ChannelActor {
  userId: string;
  orgId: string;
  meta?: RequestMeta;
}

const STATE_TTL_S = 600;
const stateKey = (state: string) =>
  `instagram:state:${createHash('sha256').update(state).digest('hex')}`;

const channelSelect = {
  id: true,
  kind: true,
  name: true,
  status: true,
  externalId: true,
  config: true,
  tokenExpiresAt: true,
  createdAt: true,
  phone: { select: { displayPhoneNumber: true } },
} satisfies Prisma.ChannelSelect;

type ChannelRow = Prisma.ChannelGetPayload<{ select: typeof channelSelect }>;

/** Whitelist mapping: credentials never leave the server. */
export function toChannelDto(c: ChannelRow): ChannelDto {
  const config = (c.config ?? {}) as Record<string, unknown>;
  const kind = c.kind as ChannelKind;
  return {
    id: c.id,
    kind,
    name: c.name,
    status: c.status,
    detail:
      kind === 'whatsapp'
        ? (c.phone?.displayPhoneNumber ?? null)
        : kind === 'instagram' && typeof config.username === 'string'
          ? `@${config.username}`
          : null,
    widgetKey: kind === 'webchat' ? c.externalId : null,
    config: kind === 'webchat' ? webchatConfigSchema.parse(config) : {},
    tokenExpiresAt: c.tokenExpiresAt?.toISOString() ?? null,
    createdAt: c.createdAt.toISOString(),
  };
}

@Injectable()
export class ChannelsService {
  private readonly logger = new Logger(ChannelsService.name);

  constructor(
    @Inject(API_ENV) private readonly env: ApiEnv,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(INSTAGRAM) private readonly instagram: InstagramClient | null,
    private readonly db: TenantPrismaService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly secrets: SecretBox,
    private readonly realtime: RealtimeGateway,
  ) {}

  async list(): Promise<ChannelDto[]> {
    const rows = await this.db.run((tx) =>
      tx.channel.findMany({
        orderBy: [{ kind: 'asc' }, { createdAt: 'asc' }],
        select: channelSelect,
      }),
    );
    return rows.map(toChannelDto);
  }

  private async findOrThrow(id: string): Promise<ChannelRow> {
    const row = await this.db.run((tx) =>
      tx.channel.findUnique({ where: { id }, select: channelSelect }),
    );
    if (!row) throw new AppError(ErrorCode.NOT_FOUND, 'Channel not found');
    return row;
  }

  // ------------------------------------------------------------------ website chat

  async createWebchat(actor: ChannelActor, input: CreateWebchatInput): Promise<ChannelDto> {
    const parsed = createWebchatSchema.parse(input);
    const config = webchatConfigSchema.parse(parsed.config);
    // Public, since it is in every page that embeds the widget; unguessable, so it cannot be listed.
    const key = `wc_${randomBytes(18).toString('base64url')}`;
    const row = await this.db.run(async (tx) => {
      const created = await tx.channel.create({
        data: {
          orgId: actor.orgId,
          kind: 'webchat',
          name: parsed.name,
          externalId: key,
          config,
          connectedById: actor.userId,
        },
        select: channelSelect,
      });
      await this.audit.record(tx, actor.orgId, {
        action: AuditAction.CHANNEL_CHANGED,
        actorUserId: actor.userId,
        targetType: 'channel',
        targetId: created.id,
        metadata: { kind: 'webchat', change: 'created', name: parsed.name },
        meta: actor.meta,
      });
      return created;
    });
    this.realtime.emit(actor.orgId, 'channel:updated', { channelId: row.id });
    return toChannelDto(row);
  }

  async update(actor: ChannelActor, id: string, input: UpdateChannelInput): Promise<ChannelDto> {
    const current = await this.findOrThrow(id);
    if (input.config && current.kind !== 'webchat') {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'Only website chat has settings here');
    }
    const config = input.config
      ? webchatConfigSchema.parse({ ...(current.config as object), ...input.config })
      : undefined;
    const row = await this.db.run(async (tx) => {
      const updated = await tx.channel.update({
        where: { id },
        data: {
          ...(input.name ? { name: input.name } : {}),
          ...(config ? { config } : {}),
        },
        select: channelSelect,
      });
      await this.audit.record(tx, actor.orgId, {
        action: AuditAction.CHANNEL_CHANGED,
        actorUserId: actor.userId,
        targetType: 'channel',
        targetId: id,
        metadata: { change: 'updated', name: input.name, config: input.config },
        meta: actor.meta,
      });
      return updated;
    });
    this.realtime.emit(actor.orgId, 'channel:updated', { channelId: id });
    return toChannelDto(row);
  }

  /**
   * Stop a channel. History stays, credentials go. WhatsApp numbers are disconnected from
   * Settings > WhatsApp, which also tells Meta.
   */
  async disconnect(actor: ChannelActor, id: string): Promise<void> {
    const current = await this.findOrThrow(id);
    if (current.kind === 'whatsapp') {
      throw new AppError(
        ErrorCode.CONFLICT,
        'Disconnect WhatsApp numbers from Settings > WhatsApp',
      );
    }
    await this.db.run(async (tx) => {
      await tx.channel.update({
        where: { id },
        data: {
          status: 'disconnected',
          credentialsEnc: null,
          tokenExpiresAt: null,
          disconnectedAt: new Date(),
        },
      });
      await this.audit.record(tx, actor.orgId, {
        action: AuditAction.CHANNEL_CHANGED,
        actorUserId: actor.userId,
        targetType: 'channel',
        targetId: id,
        metadata: { kind: current.kind, change: 'disconnected' },
        meta: actor.meta,
      });
    });
    this.realtime.emit(actor.orgId, 'channel:updated', { channelId: id });
  }

  // ------------------------------------------------------------------ Instagram

  private client(): InstagramClient {
    if (!this.instagram) {
      throw new AppError(
        ErrorCode.INTEGRATION_NOT_AVAILABLE,
        'Instagram is not set up on this installation (INSTAGRAM_APP_ID and INSTAGRAM_APP_SECRET)',
      );
    }
    return this.instagram;
  }

  private redirectUri(): string {
    return `${this.env.API_PUBLIC_URL.replace(/\/$/, '')}/channels/instagram/callback`;
  }

  /** Where to send the browser to log in with Instagram. The state is good for one use. */
  async instagramStart(actor: ChannelActor): Promise<InstagramStartDto> {
    const client = this.client();
    const state = randomBytes(24).toString('base64url');
    await this.redis.set(
      stateKey(state),
      JSON.stringify({ orgId: actor.orgId, userId: actor.userId }),
      'EX',
      STATE_TTL_S,
    );
    return { url: client.authorizeUrl({ redirectUri: this.redirectUri(), state }) };
  }

  /** Instagram sends the browser back here. Always answers with a page to go to. */
  async instagramCallback(query: {
    code?: string;
    state?: string;
    error?: string;
  }): Promise<string> {
    const back = (result: string) =>
      `${this.env.WEB_URL}/settings/channels?instagram=${encodeURIComponent(result)}`;
    if (!query.state) return back('error');
    const raw = await this.redis.getdel(stateKey(query.state));
    if (!raw) return back('expired');
    if (query.error || !query.code) return back('cancelled');
    const { orgId, userId } = JSON.parse(raw) as { orgId: string; userId: string };
    try {
      const client = this.client();
      const token = await client.exchangeCode({
        code: query.code,
        redirectUri: this.redirectUri(),
      });
      await this.connectInstagram({ orgId, userId }, token);
      return back('connected');
    } catch (err) {
      this.logger.warn(`Instagram connect failed: ${err instanceof Error ? err.message : err}`);
      return back(err instanceof AppError && err.code === ErrorCode.CONFLICT ? 'taken' : 'error');
    }
  }

  /** Connect with a long-lived token directly: for testing, like manual WhatsApp connect. */
  async instagramWithToken(actor: ChannelActor, accessToken: string): Promise<ChannelDto> {
    if (!(this.env.ALLOW_MANUAL_CONNECT ?? this.env.NODE_ENV !== 'production')) {
      throw new AppError(ErrorCode.FORBIDDEN, 'Use Instagram login to connect an account');
    }
    return this.connectInstagram(actor, {
      accessToken,
      expiresAt: new Date(Date.now() + 60 * 86_400_000),
    });
  }

  /**
   * Read the account with the token (proves access), subscribe it to our webhook, then save.
   * Nothing is stored unless the subscription succeeds. Reconnecting the same account in this
   * workspace refreshes it; one live in another workspace is refused.
   */
  private async connectInstagram(actor: ChannelActor, token: InstagramToken): Promise<ChannelDto> {
    const client = this.client();
    let account: InstagramAccount;
    try {
      account = await client.me(token.accessToken);
      await client.subscribe(token.accessToken);
    } catch (err) {
      if (err instanceof InstagramError) {
        throw new AppError(ErrorCode.WHATSAPP_META_ERROR, `Instagram: ${err.message}`);
      }
      throw err;
    }
    const config = { username: account.username, accountName: account.name };
    const name = account.username ? `@${account.username}` : (account.name ?? 'Instagram');

    const row = await withTenant(
      this.prisma.client,
      { orgId: actor.orgId, userId: actor.userId },
      async (tx) => {
        const existing = await tx.channel.findFirst({
          where: { kind: 'instagram', externalId: account.userId },
          orderBy: { createdAt: 'desc' },
        });
        const id = existing?.id ?? randomUUID();
        const credentialsEnc = this.secrets.encrypt(
          JSON.stringify({ accessToken: token.accessToken }),
          channelCredentialsAad(id),
        );
        const data = {
          name,
          status: 'active' as const,
          config,
          credentialsEnc,
          tokenExpiresAt: token.expiresAt,
          connectedById: actor.userId,
          disconnectedAt: null,
        };
        let saved: ChannelRow;
        try {
          saved = existing
            ? await tx.channel.update({ where: { id }, data, select: channelSelect })
            : await tx.channel.create({
                data: {
                  id,
                  orgId: actor.orgId,
                  kind: 'instagram',
                  externalId: account.userId,
                  ...data,
                },
                select: channelSelect,
              });
        } catch (err) {
          // channels_live_external: this account is live in another workspace.
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
            throw new AppError(
              ErrorCode.CONFLICT,
              'This Instagram account is connected to another workspace',
            );
          }
          throw err;
        }
        await this.audit.record(tx, actor.orgId, {
          action: AuditAction.CHANNEL_CHANGED,
          actorUserId: actor.userId,
          targetType: 'channel',
          targetId: id,
          metadata: { kind: 'instagram', change: 'connected', username: account.username },
          meta: actor.meta,
        });
        return saved;
      },
    );
    this.realtime.emit(actor.orgId, 'channel:updated', { channelId: row.id });
    return toChannelDto(row);
  }
}
