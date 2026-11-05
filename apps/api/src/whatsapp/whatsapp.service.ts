import { randomInt, randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { disconnectWabaTx, Prisma, withTenant } from '@wacrm/db';
import {
  AppError,
  type CursorPage,
  type CursorQuery,
  type EmbeddedSignupInput,
  ErrorCode,
  type ManualConnectInput,
  type PhoneNumberDto,
  type WebhookEventDto,
  type WhatsAppConfigDto,
} from '@wacrm/shared';
import { phonePinAad, phoneTokenAad, SecretBox } from '@wacrm/shared/server';
import {
  GraphClient,
  type GraphConfig,
  type PhoneInfo,
  WapiCloudGateway,
  type WabaInfo,
  WhatsAppClientFactory,
  type WhatsAppError,
} from '@wacrm/whatsapp';
import { AuditAction, AuditService } from '../audit/audit.service';
import type { RequestMeta } from '../common/request-meta';
import { PrismaService } from '../db/prisma.service';
import { API_ENV, type ApiEnv } from '../env';
import { decodeCursor, encodeCursor } from '../orgs/cursor';
import { QueuesService } from '../infra/queues.service';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service';
import { GRAPH_CONFIG } from './whatsapp.tokens';

export interface Actor {
  userId: string;
  orgId: string;
}

interface ConnectParams {
  accessToken: string;
  wabaId: string;
  phoneNumberId: string;
  source: 'embedded_signup' | 'manual';
  metaUserId?: string;
  /** 'auto': register unless Meta says it is already live. 'skip': never. Or an explicit PIN. */
  register: 'auto' | 'skip' | { pin: string };
}

const metaFailure = (err: WhatsAppError): AppError =>
  new AppError(ErrorCode.WHATSAPP_META_ERROR, err.message, {
    whatsappCode: err.code,
    metaCode: err.metaCode,
    fbtraceId: err.fbtraceId,
  });

const newPin = () => String(randomInt(0, 1_000_000)).padStart(6, '0');

@Injectable()
export class WhatsAppService {
  private readonly logger = new Logger(WhatsAppService.name);
  private readonly graph: GraphClient;

  constructor(
    @Inject(API_ENV) private readonly env: ApiEnv,
    @Inject(GRAPH_CONFIG) private readonly graphConfig: GraphConfig,
    private readonly db: TenantPrismaService,
    private readonly prisma: PrismaService,
    private readonly secrets: SecretBox,
    private readonly audit: AuditService,
    private readonly factory: WhatsAppClientFactory,
    private readonly queues: QueuesService,
  ) {
    this.graph = new GraphClient(graphConfig);
  }

  private get manualConnectEnabled(): boolean {
    return this.env.ALLOW_MANUAL_CONNECT ?? this.env.NODE_ENV !== 'production';
  }

  getConfig(): WhatsAppConfigDto {
    const { META_APP_ID, META_APP_SECRET, META_EMBEDDED_SIGNUP_CONFIG_ID } = this.env;
    return {
      embeddedSignupEnabled: Boolean(
        META_APP_ID && META_APP_SECRET && META_EMBEDDED_SIGNUP_CONFIG_ID,
      ),
      manualConnectEnabled: this.manualConnectEnabled,
      appId: META_APP_ID ?? null,
      configId: META_EMBEDDED_SIGNUP_CONFIG_ID ?? null,
      graphApiVersion: this.env.META_GRAPH_API_VERSION,
    };
  }

  // ------------------------------------------------------------------ connecting

  async connectEmbedded(
    actor: Actor,
    input: EmbeddedSignupInput,
    meta: RequestMeta,
  ): Promise<PhoneNumberDto> {
    if (!this.getConfig().embeddedSignupEnabled) {
      throw new AppError(ErrorCode.WHATSAPP_NOT_CONFIGURED, 'Embedded Signup is not configured');
    }
    const token = await this.graph.exchangeCode(input.code);
    if (token.error) throw metaFailure(token.error);
    return this.connect(
      actor,
      {
        accessToken: token.data.accessToken,
        wabaId: input.wabaId,
        phoneNumberId: input.phoneNumberId,
        source: 'embedded_signup',
        metaUserId: input.metaUserId,
        register: 'auto',
      },
      meta,
    );
  }

  /** Development fallback: a system user token pasted by an admin. Off in production by default. */
  async connectManual(
    actor: Actor,
    input: ManualConnectInput,
    meta: RequestMeta,
  ): Promise<PhoneNumberDto> {
    if (!this.manualConnectEnabled) {
      throw new AppError(ErrorCode.FORBIDDEN, 'Manual connect is disabled');
    }
    return this.connect(
      actor,
      {
        accessToken: input.accessToken,
        wabaId: input.wabaId,
        phoneNumberId: input.phoneNumberId,
        source: 'manual',
        register: input.pin ? { pin: input.pin } : 'skip',
      },
      meta,
    );
  }

  /** All Meta calls happen before the transaction: never hold a DB connection across HTTP. */
  private async connect(
    actor: Actor,
    p: ConnectParams,
    meta: RequestMeta,
  ): Promise<PhoneNumberDto> {
    // Reading the WABA's numbers with this token proves the token really has access to it, so
    // a client cannot claim another customer's WABA by sending its id.
    const numbers = await this.graph.listPhoneNumbers(p.wabaId, p.accessToken);
    if (numbers.error) throw metaFailure(numbers.error);
    if (!numbers.data.some((n) => n.id === p.phoneNumberId)) {
      throw new AppError(
        ErrorCode.WHATSAPP_PHONE_NOT_IN_WABA,
        'This phone number does not belong to that WhatsApp Business Account',
      );
    }

    const waba = await this.graph.getWaba(p.wabaId, p.accessToken);
    if (waba.error) throw metaFailure(waba.error);
    const phone = await this.graph.getPhoneNumber(p.phoneNumberId, p.accessToken);
    if (phone.error) throw metaFailure(phone.error);

    const subscribed = await this.graph.subscribeApp(p.wabaId, p.accessToken);
    if (subscribed.error) throw metaFailure(subscribed.error);

    const registration = await this.registerOnConnect(p, phone.data);

    const row = await this.persist(actor, p, waba.data, phone.data, registration, meta);
    this.factory.invalidate(p.phoneNumberId);
    return row;
  }

  private async registerOnConnect(
    p: ConnectParams,
    phone: PhoneInfo,
  ): Promise<{ registered: boolean; pin?: string; failure?: string }> {
    if (p.register === 'skip') return { registered: false };
    const alreadyLive = phone.status === 'CONNECTED' && phone.platformType === 'CLOUD_API';
    if (p.register === 'auto' && alreadyLive) return { registered: true };

    const pin = p.register === 'auto' ? newPin() : p.register.pin;
    const gateway = new WapiCloudGateway({
      phoneNumberId: p.phoneNumberId,
      credentials: { accessToken: p.accessToken, wabaId: p.wabaId },
      graph: this.graphConfig,
    });
    const res = await gateway.register(pin);
    if (res.error) {
      // Keep the connection: the admin can retry with the number's existing PIN.
      this.logger.warn(`registration failed for a number: ${res.error.code}`);
      return { registered: false, failure: res.error.message };
    }
    return { registered: true, pin };
  }

  private async persist(
    actor: Actor,
    p: ConnectParams,
    waba: WabaInfo,
    phone: PhoneInfo,
    registration: { registered: boolean; pin?: string; failure?: string },
    meta: RequestMeta,
  ): Promise<PhoneNumberDto> {
    const wabaFields = {
      name: waba.name,
      currency: waba.currency,
      timezoneId: waba.timezoneId,
      templateNamespace: waba.templateNamespace,
      status: 'active' as const,
      disconnectedAt: null,
      webhookSubscribedAt: new Date(),
      connectedById: actor.userId,
      ...(p.metaUserId ? { metaUserId: p.metaUserId } : {}),
    };
    try {
      return await this.db.run(async (tx) => {
        const account = await tx.wabaAccount.upsert({
          where: { orgId_wabaId: { orgId: actor.orgId, wabaId: p.wabaId } },
          create: { orgId: actor.orgId, wabaId: p.wabaId, ...wabaFields },
          update: wabaFields,
        });
        const existing = await tx.phoneNumber.findUnique({
          where: { orgId_phoneNumberId: { orgId: actor.orgId, phoneNumberId: p.phoneNumberId } },
          select: { id: true },
        });
        const id = existing?.id ?? randomUUID();
        const fields = {
          wabaAccountId: account.id,
          ...phoneColumns(phone),
          status: registration.failure ? ('registration_failed' as const) : ('connected' as const),
          statusReason: registration.failure ?? null,
          credentialSource: p.source,
          accessTokenEnc: this.secrets.encrypt(p.accessToken, phoneTokenAad(id)),
          disconnectedAt: null,
          lastSyncedAt: new Date(),
          ...(registration.pin
            ? { registrationPinEnc: this.secrets.encrypt(registration.pin, phonePinAad(id)) }
            : {}),
          ...(registration.registered ? { registeredAt: new Date() } : {}),
        };
        const row = await tx.phoneNumber.upsert({
          where: { id },
          create: { id, orgId: actor.orgId, phoneNumberId: p.phoneNumberId, ...fields },
          update: fields,
          include: { wabaAccount: { select: { wabaId: true, name: true } } },
        });

        // The token is per WABA: keep sibling numbers on the newest one.
        const siblings = await tx.phoneNumber.findMany({
          where: { wabaAccountId: account.id, id: { not: id }, status: { not: 'disconnected' } },
          select: { id: true, phoneNumberId: true },
        });
        for (const s of siblings) {
          await tx.phoneNumber.update({
            where: { id: s.id },
            data: { accessTokenEnc: this.secrets.encrypt(p.accessToken, phoneTokenAad(s.id)) },
          });
          this.factory.invalidate(s.phoneNumberId);
        }

        await this.audit.record(tx, actor.orgId, {
          action: AuditAction.WHATSAPP_CONNECTED,
          actorUserId: actor.userId,
          targetType: 'phone_number',
          targetId: id,
          metadata: { phoneNumberId: p.phoneNumberId, wabaId: p.wabaId, source: p.source },
          meta,
        });
        return toDto(row);
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new AppError(
          ErrorCode.WHATSAPP_ALREADY_CONNECTED,
          'This number is already connected to another workspace',
        );
      }
      throw err;
    }
  }

  // ------------------------------------------------------------------ managing

  async list(): Promise<PhoneNumberDto[]> {
    const rows = await this.db.run((tx) =>
      tx.phoneNumber.findMany({
        orderBy: { createdAt: 'asc' },
        include: { wabaAccount: { select: { wabaId: true, name: true } } },
      }),
    );
    return rows.map(toDto);
  }

  private async findOrThrow(id: string) {
    const row = await this.db.run((tx) =>
      tx.phoneNumber.findUnique({
        where: { id },
        include: { wabaAccount: { select: { id: true, wabaId: true, name: true } } },
      }),
    );
    if (!row) throw new AppError(ErrorCode.NOT_FOUND, 'Phone number not found');
    return row;
  }

  /** Refresh quality, tier and status from Meta. */
  async sync(actor: Actor, id: string): Promise<PhoneNumberDto> {
    const row = await this.findOrThrow(id);
    const gateway = await this.factory.get({
      orgId: actor.orgId,
      phoneNumberId: row.phoneNumberId,
    });
    const info = await gateway.getPhoneInfo();
    if (info.error) throw metaFailure(info.error);
    const updated = await this.db.run((tx) =>
      tx.phoneNumber.update({
        where: { id },
        data: { ...phoneColumns(info.data), lastSyncedAt: new Date() },
        include: { wabaAccount: { select: { wabaId: true, name: true } } },
      }),
    );
    return toDto(updated);
  }

  /** Retry registration, e.g. with the number's existing 2-step PIN. */
  async registerNumber(
    actor: Actor,
    id: string,
    pin: string | undefined,
    meta: RequestMeta,
  ): Promise<PhoneNumberDto> {
    const row = await this.findOrThrow(id);
    const gateway = await this.factory.get({
      orgId: actor.orgId,
      phoneNumberId: row.phoneNumberId,
    });
    const usePin = pin ?? newPin();
    const res = await gateway.register(usePin);
    if (res.error) throw metaFailure(res.error);
    const updated = await this.db.run(async (tx) => {
      await this.audit.record(tx, actor.orgId, {
        action: AuditAction.WHATSAPP_REGISTERED,
        actorUserId: actor.userId,
        targetType: 'phone_number',
        targetId: id,
        meta,
      });
      return tx.phoneNumber.update({
        where: { id },
        data: {
          status: 'connected',
          statusReason: null,
          registeredAt: new Date(),
          registrationPinEnc: this.secrets.encrypt(usePin, phonePinAad(id)),
        },
        include: { wabaAccount: { select: { wabaId: true, name: true } } },
      });
    });
    return toDto(updated);
  }

  /** Stops receiving this number's messages and wipes its credentials. History stays. */
  async disconnect(actor: Actor, id: string, meta: RequestMeta): Promise<void> {
    const row = await this.findOrThrow(id);
    const token = row.accessTokenEnc
      ? this.secrets.decrypt(row.accessTokenEnc, phoneTokenAad(id))
      : null;

    const lastInWaba = await this.db.run(async (tx) => {
      const others = await tx.phoneNumber.count({
        where: {
          wabaAccountId: row.wabaAccountId,
          id: { not: id },
          status: { not: 'disconnected' },
        },
      });
      if (others === 0) {
        await disconnectWabaTx(tx, row.wabaAccountId, 'Disconnected by an admin');
      } else {
        await tx.phoneNumber.update({
          where: { id },
          data: {
            status: 'disconnected',
            statusReason: 'Disconnected by an admin',
            accessTokenEnc: null,
            registrationPinEnc: null,
            disconnectedAt: new Date(),
          },
        });
      }
      await this.audit.record(tx, actor.orgId, {
        action: AuditAction.WHATSAPP_DISCONNECTED,
        actorUserId: actor.userId,
        targetType: 'phone_number',
        targetId: id,
        metadata: { phoneNumberId: row.phoneNumberId },
        meta,
      });
      return others === 0;
    });
    this.factory.invalidate(row.phoneNumberId);

    // Best effort, after the local wipe: a Meta outage must not keep a number half-connected.
    if (lastInWaba && token) {
      const res = await this.graph.unsubscribeApp(row.wabaAccount.wabaId, token);
      if (res.error) this.logger.warn(`could not unsubscribe a WABA: ${res.error.code}`);
    }
  }

  // ------------------------------------------------------------------ webhook events

  async listEvents(query: CursorQuery): Promise<CursorPage<WebhookEventDto>> {
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    const rows = await this.db.run((tx) =>
      tx.webhookEvent.findMany({
        where: cursor
          ? {
              OR: [
                { receivedAt: { lt: cursor.createdAt } },
                { receivedAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }
          : undefined,
        orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
        // The raw payload holds customer messages: it stays out of this list.
        omit: { payload: true },
      }),
    );
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      items: page.map((e) => ({
        id: e.id,
        field: e.field,
        phoneNumberId: e.phoneNumberId,
        status: e.status,
        attempts: e.attempts,
        error: e.error,
        receivedAt: e.receivedAt.toISOString(),
        processedAt: e.processedAt?.toISOString() ?? null,
      })),
      nextCursor:
        rows.length > query.limit && last
          ? encodeCursor({ createdAt: last.receivedAt, id: last.id })
          : null,
    };
  }

  /** Re-run an event through the worker pipeline from its stored raw payload. */
  async replayEvent(actor: Actor, id: string, meta: RequestMeta): Promise<void> {
    await withTenant(
      this.prisma.client,
      { orgId: actor.orgId, userId: actor.userId },
      async (tx) => {
        const res = await tx.webhookEvent.updateMany({
          where: { id },
          data: { status: 'received', error: null },
        });
        if (res.count === 0) throw new AppError(ErrorCode.NOT_FOUND, 'Event not found');
        await this.audit.record(tx, actor.orgId, {
          action: AuditAction.WEBHOOK_REPLAYED,
          actorUserId: actor.userId,
          targetType: 'webhook_event',
          targetId: id,
          meta,
        });
      },
    );
    await this.queues.enqueueReplay(id);
  }
}

function phoneColumns(p: PhoneInfo) {
  return {
    displayPhoneNumber: p.displayPhoneNumber,
    verifiedName: p.verifiedName,
    qualityRating: p.qualityRating,
    messagingTier: p.messagingTier,
    codeVerificationStatus: p.codeVerificationStatus,
    nameStatus: p.nameStatus,
    platformType: p.platformType,
  };
}

/** Whitelist mapping: tokens and PINs can never reach a response. */
function toDto(r: {
  id: string;
  phoneNumberId: string;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  qualityRating: string | null;
  messagingTier: string | null;
  nameStatus: string | null;
  codeVerificationStatus: string | null;
  platformType: string | null;
  status: PhoneNumberDto['status'];
  statusReason: string | null;
  credentialSource: PhoneNumberDto['credentialSource'];
  lastSyncedAt: Date | null;
  createdAt: Date;
  wabaAccount: { wabaId: string; name: string | null };
}): PhoneNumberDto {
  return {
    id: r.id,
    wabaId: r.wabaAccount.wabaId,
    wabaName: r.wabaAccount.name,
    phoneNumberId: r.phoneNumberId,
    displayPhoneNumber: r.displayPhoneNumber,
    verifiedName: r.verifiedName,
    qualityRating: r.qualityRating,
    messagingTier: r.messagingTier,
    nameStatus: r.nameStatus,
    codeVerificationStatus: r.codeVerificationStatus,
    platformType: r.platformType,
    status: r.status,
    statusReason: r.statusReason,
    credentialSource: r.credentialSource,
    lastSyncedAt: r.lastSyncedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  };
}
