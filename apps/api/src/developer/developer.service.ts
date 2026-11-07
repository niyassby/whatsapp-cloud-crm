import { randomBytes, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  apiKeyToDto,
  emitWebhookEvent,
  webhookDeliveryToDto,
  webhookEndpointToDto,
} from '@wacrm/db';
import {
  type ApiKeyDto,
  AppError,
  type CreatedApiKeyDto,
  type CreatedWebhookEndpointDto,
  type CreateApiKeyParsed,
  type CreateWebhookEndpointParsed,
  type CursorPage,
  ErrorCode,
  type ListWebhookDeliveriesQuery,
  MAX_WEBHOOK_ENDPOINTS,
  type UpdateWebhookEndpointInput,
  type WebhookDeliveryDto,
  type WebhookEndpointDto,
  WEBHOOK_TEST_EVENT,
} from '@wacrm/shared';
import { SecretBox, webhookSecretAad, webhookUrlProblem } from '@wacrm/shared/server';
import { AuditAction, AuditService } from '../audit/audit.service';
import { TokenService } from '../auth/token.service';
import type { RequestMeta } from '../common/request-meta';
import { API_ENV, type ApiEnv } from '../env';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service';

export interface DeveloperActor {
  userId: string;
  orgId: string;
  meta?: RequestMeta;
}

const newSecret = () => `whsec_${randomBytes(32).toString('base64url')}`;

@Injectable()
export class DeveloperService {
  constructor(
    private readonly db: TenantPrismaService,
    private readonly audit: AuditService,
    private readonly tokens: TokenService,
    private readonly secrets: SecretBox,
    @Inject(API_ENV) private readonly env: ApiEnv,
  ) {}

  // ------------------------------------------------------------------ API keys

  async listKeys(): Promise<ApiKeyDto[]> {
    const rows = await this.db.run((tx) =>
      tx.apiKey.findMany({ orderBy: { createdAt: 'desc' }, take: 200 }),
    );
    return rows.map(apiKeyToDto);
  }

  /** Only a keyed hash is stored, so this is the one time the key can be shown. */
  async createKey(actor: DeveloperActor, input: CreateApiKeyParsed): Promise<CreatedApiKeyDto> {
    const prefix = randomBytes(8).toString('hex');
    const key = `wak_${prefix}_${randomBytes(32).toString('base64url')}`;
    const row = await this.db.run(async (tx) => {
      const created = await tx.apiKey.create({
        data: {
          orgId: actor.orgId,
          name: input.name,
          prefix,
          keyHash: this.tokens.hashToken(key),
          scopes: input.scopes,
          createdById: actor.userId,
          expiresAt: input.expiresInDays
            ? new Date(Date.now() + input.expiresInDays * 86_400_000)
            : null,
        },
      });
      await this.audit.record(tx, actor.orgId, {
        action: AuditAction.API_KEY_CREATED,
        actorUserId: actor.userId,
        targetType: 'api_key',
        targetId: created.id,
        metadata: { name: input.name, scopes: input.scopes },
        meta: actor.meta,
      });
      return created;
    });
    return { ...apiKeyToDto(row), key };
  }

  /** Effective at once: the key is read from the database on every request. */
  async revokeKey(actor: DeveloperActor, id: string): Promise<ApiKeyDto> {
    const row = await this.db.run(async (tx) => {
      const current = await tx.apiKey.findUnique({ where: { id } });
      if (!current) throw new AppError(ErrorCode.NOT_FOUND, 'API key not found');
      if (current.revokedAt) return current;
      await this.audit.record(tx, actor.orgId, {
        action: AuditAction.API_KEY_REVOKED,
        actorUserId: actor.userId,
        targetType: 'api_key',
        targetId: id,
        metadata: { name: current.name },
        meta: actor.meta,
      });
      return tx.apiKey.update({ where: { id }, data: { revokedAt: new Date() } });
    });
    return apiKeyToDto(row);
  }

  // ------------------------------------------------------------------ webhook endpoints

  private assertUrl(url: string): void {
    const problem = webhookUrlProblem(url, { allowPrivate: this.env.WEBHOOK_ALLOW_PRIVATE_URLS });
    if (problem) throw new AppError(ErrorCode.WEBHOOK_URL_INVALID, problem);
  }

  async listEndpoints(): Promise<WebhookEndpointDto[]> {
    const rows = await this.db.run((tx) =>
      tx.webhookEndpoint.findMany({ orderBy: { createdAt: 'desc' } }),
    );
    return rows.map(webhookEndpointToDto);
  }

  async createEndpoint(
    actor: DeveloperActor,
    input: CreateWebhookEndpointParsed,
  ): Promise<CreatedWebhookEndpointDto> {
    this.assertUrl(input.url);
    const id = randomUUID();
    const secret = newSecret();
    const row = await this.db.run(async (tx) => {
      const count = await tx.webhookEndpoint.count();
      if (count >= MAX_WEBHOOK_ENDPOINTS) {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          `A workspace can have up to ${MAX_WEBHOOK_ENDPOINTS} endpoints`,
        );
      }
      const created = await tx.webhookEndpoint.create({
        data: {
          id,
          orgId: actor.orgId,
          url: input.url,
          description: input.description,
          events: input.events,
          secretEnc: this.secrets.encrypt(secret, webhookSecretAad(id)),
          createdById: actor.userId,
        },
      });
      await this.audit.record(tx, actor.orgId, {
        action: AuditAction.WEBHOOK_ENDPOINT_CREATED,
        actorUserId: actor.userId,
        targetType: 'webhook_endpoint',
        targetId: id,
        metadata: { url: input.url, events: input.events },
        meta: actor.meta,
      });
      return created;
    });
    return { ...webhookEndpointToDto(row), secret };
  }

  private async loadEndpoint(id: string) {
    const row = await this.db.run((tx) => tx.webhookEndpoint.findUnique({ where: { id } }));
    if (!row) throw new AppError(ErrorCode.NOT_FOUND, 'Endpoint not found');
    return row;
  }

  async updateEndpoint(
    actor: DeveloperActor,
    id: string,
    input: UpdateWebhookEndpointInput,
  ): Promise<WebhookEndpointDto> {
    if (input.url) this.assertUrl(input.url);
    await this.loadEndpoint(id);
    const row = await this.db.run(async (tx) => {
      await this.audit.record(tx, actor.orgId, {
        action: AuditAction.WEBHOOK_ENDPOINT_CHANGED,
        actorUserId: actor.userId,
        targetType: 'webhook_endpoint',
        targetId: id,
        meta: actor.meta,
      });
      return tx.webhookEndpoint.update({ where: { id }, data: input });
    });
    return webhookEndpointToDto(row);
  }

  async deleteEndpoint(actor: DeveloperActor, id: string): Promise<void> {
    const current = await this.loadEndpoint(id);
    await this.db.run(async (tx) => {
      await this.audit.record(tx, actor.orgId, {
        action: AuditAction.WEBHOOK_ENDPOINT_DELETED,
        actorUserId: actor.userId,
        targetType: 'webhook_endpoint',
        targetId: id,
        metadata: { url: current.url },
        meta: actor.meta,
      });
      await tx.webhookEndpoint.delete({ where: { id } });
    });
  }

  /** The old secret stops working at once, so the receiver needs updating at the same moment. */
  async rotateSecret(actor: DeveloperActor, id: string): Promise<CreatedWebhookEndpointDto> {
    await this.loadEndpoint(id);
    const secret = newSecret();
    const row = await this.db.run(async (tx) => {
      await this.audit.record(tx, actor.orgId, {
        action: AuditAction.WEBHOOK_SECRET_ROTATED,
        actorUserId: actor.userId,
        targetType: 'webhook_endpoint',
        targetId: id,
        meta: actor.meta,
      });
      return tx.webhookEndpoint.update({
        where: { id },
        data: { secretEnc: this.secrets.encrypt(secret, webhookSecretAad(id)) },
      });
    });
    return { ...webhookEndpointToDto(row), secret };
  }

  async sendTest(actor: DeveloperActor, id: string): Promise<void> {
    await this.loadEndpoint(id);
    await this.db.run((tx) =>
      emitWebhookEvent(
        tx,
        actor.orgId,
        WEBHOOK_TEST_EVENT,
        { message: 'This is a test event.' },
        { endpointId: id },
      ),
    );
  }

  // ------------------------------------------------------------------ delivery log

  async listDeliveries(
    endpointId: string,
    q: ListWebhookDeliveriesQuery,
  ): Promise<CursorPage<WebhookDeliveryDto>> {
    await this.loadEndpoint(endpointId);
    const rows = await this.db.run((tx) =>
      tx.webhookDelivery.findMany({
        where: {
          endpointId,
          ...(q.status ? { status: q.status } : {}),
          ...(q.cursor ? { id: { lt: q.cursor } } : {}),
        },
        orderBy: { id: 'desc' },
        take: q.limit + 1,
      }),
    );
    const page = rows.slice(0, q.limit);
    return {
      items: page.map(webhookDeliveryToDto),
      nextCursor: rows.length > q.limit ? (page.at(-1)?.id ?? null) : null,
    };
  }

  /**
   * Send it again as a new row, so the log keeps what happened the first time. It keeps the event
   * id, so a receiver that already processed it can tell.
   */
  async replay(
    actor: DeveloperActor,
    endpointId: string,
    deliveryId: string,
  ): Promise<WebhookDeliveryDto> {
    const row = await this.db.run(async (tx) => {
      const original = await tx.webhookDelivery.findFirst({
        where: { id: deliveryId, endpointId },
      });
      if (!original) throw new AppError(ErrorCode.NOT_FOUND, 'Delivery not found');
      await this.audit.record(tx, actor.orgId, {
        action: AuditAction.WEBHOOK_DELIVERY_REPLAYED,
        actorUserId: actor.userId,
        targetType: 'webhook_delivery',
        targetId: deliveryId,
        meta: actor.meta,
      });
      return tx.webhookDelivery.create({
        data: {
          orgId: actor.orgId,
          endpointId,
          eventId: original.eventId,
          eventType: original.eventType,
          payload: original.payload as object,
          nextAttemptAt: new Date(),
          replayOfId: original.id,
        },
      });
    });
    return webhookDeliveryToDto(row);
  }
}
