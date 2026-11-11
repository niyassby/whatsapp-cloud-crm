import { randomBytes, randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  type ConnectorDefinition,
  type ConnectorRegistry,
  authorizeUrl,
  exchangeCode,
  oauthClient,
  sha256Hex,
  webhookSecretField,
} from '@wacrm/connectors';
import { Prisma, type TenantTx, withTenant } from '@wacrm/db';
import {
  AppError,
  type CreateConnectionInput,
  type CreatedConnectionDto,
  type ConnectorDto,
  type CursorPage,
  ErrorCode,
  type IntegrationConnectionDto,
  type IntegrationEventDto,
  keepableHeaders,
  type ListIntegrationEventsQuery,
  type StartOAuthInput,
  type UpdateConnectionInput,
} from '@wacrm/shared';
import { integrationCredentialsAad, SecretBox, webhookUrlProblem } from '@wacrm/shared/server';
import type { Redis } from 'ioredis';
import { AuditAction, AuditService } from '../audit/audit.service';
import type { RequestMeta } from '../common/request-meta';
import { PrismaService } from '../db/prisma.service';
import { API_ENV, type ApiEnv } from '../env';
import { REDIS } from '../infra/infra.tokens';
import { QueuesService } from '../infra/queues.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service';
import { CONNECTORS, INTEGRATIONS_FETCH } from './integrations.tokens';

export interface IntegrationActor {
  userId: string;
  orgId: string;
  meta?: RequestMeta;
}

type ConnectionRow = Prisma.IntegrationConnectionGetPayload<object>;

const OAUTH_STATE_TTL_SECONDS = 600;
const stateKey = (state: string) => `oauth:state:${sha256Hex(state)}`;

interface OAuthState {
  orgId: string;
  userId: string;
  connectorKey: string;
  name: string;
  settings: Record<string, string>;
  connectionId: string | null;
}

@Injectable()
export class IntegrationsService {
  private readonly logger = new Logger(IntegrationsService.name);

  constructor(
    private readonly db: TenantPrismaService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly queues: QueuesService,
    private readonly realtime: RealtimeGateway,
    private readonly secrets: SecretBox,
    @Inject(CONNECTORS) private readonly connectors: ConnectorRegistry,
    @Inject(INTEGRATIONS_FETCH) private readonly fetchFn: typeof fetch,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(API_ENV) private readonly env: ApiEnv,
  ) {}

  // ------------------------------------------------------------------ connectors

  listConnectors(): ConnectorDto[] {
    return this.connectors.list().map((d) => this.connectors.toDto(d));
  }

  private connector(key: string): ConnectorDefinition {
    const def = this.connectors.get(key);
    if (!def) throw new AppError(ErrorCode.NOT_FOUND, 'No such integration');
    return def;
  }

  // ------------------------------------------------------------------ connections

  private webhookUrl(row: ConnectionRow): string | null {
    return row.webhookToken
      ? `${this.env.API_PUBLIC_URL.replace(/\/$/, '')}/integrations/hooks/${row.webhookToken}`
      : null;
  }

  private toDto(row: ConnectionRow): IntegrationConnectionDto {
    return {
      id: row.id,
      connectorKey: row.connectorKey,
      name: row.name,
      status: row.status as IntegrationConnectionDto['status'],
      settings: (row.settings ?? {}) as Record<string, string>,
      webhookUrl: this.webhookUrl(row),
      lastError: row.lastError,
      lastHealthAt: row.lastHealthAt?.toISOString() ?? null,
      lastSyncAt: row.lastSyncAt?.toISOString() ?? null,
      tokenExpiresAt: row.tokenExpiresAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  listConnections(): Promise<IntegrationConnectionDto[]> {
    return this.db.run(async (tx) => {
      const rows = await tx.integrationConnection.findMany({ orderBy: { createdAt: 'desc' } });
      return rows.map((r) => this.toDto(r));
    });
  }

  private async load(tx: TenantTx, id: string): Promise<ConnectionRow> {
    const row = await tx.integrationConnection.findUnique({ where: { id } });
    if (!row) throw new AppError(ErrorCode.NOT_FOUND, 'Connection not found');
    return row;
  }

  getConnection(id: string): Promise<IntegrationConnectionDto> {
    return this.db.run(async (tx) => this.toDto(await this.load(tx, id)));
  }

  /** Only declared fields are kept; required ones must be there; addresses must be public https. */
  private cleanFields(
    fields: { key: string; label: string; type?: string; required?: boolean }[],
    values: Record<string, string>,
    what: string,
  ): Record<string, string> {
    const out: Record<string, string> = {};
    for (const f of fields) {
      const v = values[f.key]?.trim() ?? '';
      if (!v) {
        if (f.required ?? true) {
          throw new AppError(ErrorCode.INTEGRATION_INVALID, `${f.label} is required`, {
            field: f.key,
          });
        }
        continue;
      }
      if (f.type === 'url') {
        // The worker calls these addresses, so the same rule as webhook endpoints applies.
        const problem = webhookUrlProblem(v, { allowPrivate: this.env.WEBHOOK_ALLOW_PRIVATE_URLS });
        if (problem) {
          throw new AppError(ErrorCode.INTEGRATION_INVALID, `${f.label}: ${problem}`, {
            field: f.key,
          });
        }
      }
      out[f.key] = v.replace(/\/$/, '');
    }
    if (Object.keys(values).some((k) => !fields.some((f) => f.key === k))) {
      this.logger.debug(`ignored unknown ${what} fields`);
    }
    return out;
  }

  private encrypt(id: string, credentials: Record<string, string>): string {
    return this.secrets.encrypt(JSON.stringify(credentials), integrationCredentialsAad(id));
  }

  private decrypt(row: ConnectionRow): Record<string, string> {
    return row.credentialsEnc
      ? (JSON.parse(
          this.secrets.decrypt(row.credentialsEnc, integrationCredentialsAad(row.id)),
        ) as Record<string, string>)
      : {};
  }

  /** A fresh signing secret, when the connector takes webhooks and the person did not give one. */
  private withWebhookSecret(def: ConnectorDefinition, credentials: Record<string, string>) {
    if (!def.webhook) return { credentials, generated: null };
    const field = webhookSecretField(def);
    if (credentials[field]) return { credentials, generated: null };
    const secret = randomBytes(24).toString('base64url');
    return { credentials: { ...credentials, [field]: secret }, generated: secret };
  }

  private async afterConnect(orgId: string, connectionId: string): Promise<void> {
    this.realtime.emit(orgId, 'integration:updated', { connectionId });
    // Check it works straight away rather than waiting for the hourly check.
    await this.queues
      .enqueueIntegrationJob({ kind: 'health', orgId, connectionId })
      .catch((err: unknown) => this.logger.error(`could not queue a health check: ${String(err)}`));
  }

  /** Connect with an API key, or for webhooks only. OAuth goes through startOAuth instead. */
  async create(
    actor: IntegrationActor,
    input: CreateConnectionInput,
  ): Promise<CreatedConnectionDto> {
    const def = this.connector(input.connectorKey);
    if (def.auth.type === 'oauth2') {
      throw new AppError(ErrorCode.INTEGRATION_INVALID, `${def.name} connects by signing in`);
    }
    const settings = this.cleanFields(def.settings ?? [], input.settings ?? {}, 'settings');
    const given =
      def.auth.type === 'api_key'
        ? this.cleanFields(def.auth.fields, input.credentials ?? {}, 'credential')
        : {};
    const { credentials, generated } = this.withWebhookSecret(def, given);
    const id = randomUUID();
    const row = await this.db.run(async (tx) => {
      const created = await tx.integrationConnection.create({
        data: {
          id,
          orgId: actor.orgId,
          connectorKey: def.key,
          name: input.name.trim(),
          settings,
          credentialsEnc: Object.keys(credentials).length ? this.encrypt(id, credentials) : null,
          webhookToken: def.webhook ? randomBytes(24).toString('base64url') : null,
          syncEveryMinutes: def.sync?.everyMinutes ?? null,
          createdById: actor.userId,
        },
      });
      await this.audit.record(tx, actor.orgId, {
        action: AuditAction.INTEGRATION_CHANGED,
        actorUserId: actor.userId,
        targetType: 'integration_connection',
        targetId: id,
        metadata: { change: 'connected', connector: def.key },
        meta: actor.meta,
      });
      return created;
    });
    await this.afterConnect(actor.orgId, id);
    return { ...this.toDto(row), webhookSecret: generated };
  }

  /** Rename, change settings, or replace credentials (which reconnects it). */
  async update(
    actor: IntegrationActor,
    id: string,
    input: UpdateConnectionInput,
  ): Promise<IntegrationConnectionDto> {
    const row = await this.db.run(async (tx) => {
      const current = await this.load(tx, id);
      const def = this.connector(current.connectorKey);
      const data: Prisma.IntegrationConnectionUpdateInput = {};
      if (input.name) data.name = input.name.trim();
      if (input.settings)
        data.settings = this.cleanFields(def.settings ?? [], input.settings, 'settings');
      if (input.credentials) {
        if (def.auth.type !== 'api_key') {
          throw new AppError(ErrorCode.INTEGRATION_INVALID, 'Reconnect by signing in again');
        }
        const old = this.decrypt(current);
        const fresh = this.cleanFields(def.auth.fields, input.credentials, 'credential');
        const field = webhookSecretField(def);
        // The webhook secret was made by the app and is already in the provider; keep it.
        const credentials = {
          ...fresh,
          ...(old[field] && !fresh[field] ? { [field]: old[field] } : {}),
        };
        data.credentialsEnc = this.encrypt(id, credentials);
        data.status = 'connected';
        data.lastError = null;
      }
      const updated = await tx.integrationConnection.update({ where: { id }, data });
      await this.audit.record(tx, actor.orgId, {
        action: AuditAction.INTEGRATION_CHANGED,
        actorUserId: actor.userId,
        targetType: 'integration_connection',
        targetId: id,
        metadata: { change: input.credentials ? 'reconnected' : 'updated' },
        meta: actor.meta,
      });
      return updated;
    });
    await this.afterConnect(actor.orgId, id);
    return this.toDto(row);
  }

  /** Credentials are wiped and webhooks stop; the event log stays. */
  async disconnect(actor: IntegrationActor, id: string): Promise<IntegrationConnectionDto> {
    const row = await this.db.run(async (tx) => {
      await this.load(tx, id);
      const updated = await tx.integrationConnection.update({
        where: { id },
        data: {
          status: 'disconnected',
          credentialsEnc: null,
          webhookToken: null,
          tokenExpiresAt: null,
          syncEveryMinutes: null,
        },
      });
      await this.audit.record(tx, actor.orgId, {
        action: AuditAction.INTEGRATION_CHANGED,
        actorUserId: actor.userId,
        targetType: 'integration_connection',
        targetId: id,
        metadata: { change: 'disconnected' },
        meta: actor.meta,
      });
      return updated;
    });
    this.realtime.emit(actor.orgId, 'integration:updated', { connectionId: id });
    return this.toDto(row);
  }

  /** Run the health check now; the result arrives over `integration:updated`. */
  async test(actor: IntegrationActor, id: string): Promise<void> {
    await this.db.run((tx) => this.load(tx, id));
    await this.queues.enqueueIntegrationJob({
      kind: 'health',
      orgId: actor.orgId,
      connectionId: id,
    });
  }

  // ------------------------------------------------------------------ events

  private eventDto(e: Prisma.IntegrationEventGetPayload<object>): IntegrationEventDto {
    return {
      id: e.id,
      connectionId: e.connectionId,
      direction: e.direction as IntegrationEventDto['direction'],
      type: e.type,
      status: e.status as IntegrationEventDto['status'],
      attempts: e.attempts,
      error: e.error,
      payload: e.payload,
      result: e.result,
      createdAt: e.createdAt.toISOString(),
      updatedAt: e.updatedAt.toISOString(),
    };
  }

  events(id: string, q: ListIntegrationEventsQuery): Promise<CursorPage<IntegrationEventDto>> {
    return this.db.run(async (tx) => {
      await this.load(tx, id);
      const rows = await tx.integrationEvent.findMany({
        where: {
          connectionId: id,
          ...(q.direction !== 'any' ? { direction: q.direction } : {}),
          ...(q.status !== 'any' ? { status: q.status } : {}),
          ...(q.cursor ? { id: { lt: q.cursor } } : {}),
        },
        orderBy: { id: 'desc' },
        take: q.limit + 1,
      });
      const items = rows.slice(0, q.limit).map((r) => this.eventDto(r));
      return { items, nextCursor: rows.length > q.limit ? (items.at(-1)?.id ?? null) : null };
    });
  }

  /**
   * Try an inbound event that failed or was ignored again. Events already acted on stay claimed,
   * so a replay cannot start the same flows twice.
   */
  async replay(actor: IntegrationActor, eventId: string): Promise<IntegrationEventDto> {
    const row = await this.db.run(async (tx) => {
      const event = await tx.integrationEvent.findUnique({ where: { id: eventId } });
      if (!event) throw new AppError(ErrorCode.NOT_FOUND, 'Event not found');
      if (event.direction !== 'inbound' || !['failed', 'ignored'].includes(event.status)) {
        throw new AppError(
          ErrorCode.CONFLICT,
          'Only incoming events that failed or were ignored can be tried again',
        );
      }
      return tx.integrationEvent.update({
        where: { id: eventId },
        data: { status: 'received', error: null },
      });
    });
    await this.queues.enqueueIntegrationJob({ kind: 'event', orgId: actor.orgId, eventId });
    return this.eventDto(row);
  }

  // ------------------------------------------------------------------ webhooks

  /**
   * A provider calls a connection's webhook address. Tiny on purpose: find the connection by the
   * token in the address, check the signature on the raw bytes, store, queue, answer. Mapping and
   * flows happen in the worker. A redelivery finds the row it already made.
   */
  async receiveWebhook(
    token: string,
    rawBody: Buffer | undefined,
    rawHeaders: Record<string, string | string[] | undefined>,
  ): Promise<{ received: true }> {
    // Reviewed raw SQL: a definer function keyed by an unguessable token, as no tenant is known yet.
    const [found] = await this.prisma.client.$queryRaw<
      { org_id: string; id: string; connector_key: string; status: string }[]
    >`SELECT org_id, id, connector_key, status FROM integration_connection_by_token(${token})`;
    if (!found || found.status === 'disconnected') {
      throw new AppError(ErrorCode.NOT_FOUND, 'Unknown webhook address');
    }
    const def = this.connectors.get(found.connector_key);
    if (!def?.webhook || !rawBody)
      throw new AppError(ErrorCode.NOT_FOUND, 'Unknown webhook address');
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawHeaders)) {
      if (v !== undefined) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
    }

    const orgId = found.org_id;
    const stored = await withTenant(this.prisma.client, { orgId }, async (tx) => {
      const row = await tx.integrationConnection.findUniqueOrThrow({ where: { id: found.id } });
      const settings = (row.settings ?? {}) as Record<string, string>;
      const secret = this.decrypt(row)[webhookSecretField(def)] ?? '';
      if (!def.webhook!.verify({ rawBody, headers }, secret, settings)) return null;

      const deliveryId = def.webhook!.deliveryId?.({ rawBody, headers }) ?? null;
      const dedupeKey = deliveryId
        ? `delivery:${deliveryId.slice(0, 200)}`
        : `body:${sha256Hex(rawBody)}`;
      const text = rawBody.toString('utf8');
      let body: unknown = text;
      const type = headers['content-type'] ?? '';
      if (type.includes('json')) {
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      } else if (type.includes('x-www-form-urlencoded')) {
        body = Object.fromEntries(new URLSearchParams(text));
      }
      await tx.integrationEvent.createMany({
        data: {
          id: randomUUID(),
          orgId,
          connectionId: row.id,
          direction: 'inbound',
          dedupeKey,
          status: 'received',
          payload: {
            body,
            headers: keepableHeaders(rawHeaders),
            via: 'webhook',
          } as Prisma.InputJsonValue,
        },
        skipDuplicates: true,
      });
      return tx.integrationEvent.findUniqueOrThrow({
        where: {
          connectionId_direction_dedupeKey: {
            connectionId: row.id,
            direction: 'inbound',
            dedupeKey,
          },
        },
        select: { id: true, status: true },
      });
    });
    if (!stored) {
      this.logger.warn(`rejected a ${def.key} webhook with an invalid signature`);
      throw new AppError(ErrorCode.INTEGRATION_SIGNATURE_INVALID, 'Invalid signature');
    }
    // Still 'received' on a redelivery means an earlier attempt may have died before queueing.
    if (stored.status === 'received') {
      await this.queues.enqueueIntegrationJob({ kind: 'event', orgId, eventId: stored.id });
    }
    return { received: true };
  }

  // ------------------------------------------------------------------ OAuth

  private redirectUri(): string {
    return `${this.env.API_PUBLIC_URL.replace(/\/$/, '')}/integrations/oauth/callback`;
  }

  /** The address to send the person to. The state is random, kept 10 minutes, usable once. */
  async startOAuth(actor: IntegrationActor, input: StartOAuthInput): Promise<{ url: string }> {
    const def = this.connector(input.connectorKey);
    if (def.auth.type !== 'oauth2') {
      throw new AppError(ErrorCode.INTEGRATION_INVALID, `${def.name} does not sign in with OAuth`);
    }
    const client = oauthClient(def.auth, process.env);
    if (!client) {
      throw new AppError(
        ErrorCode.INTEGRATION_NOT_AVAILABLE,
        `${def.name} is not set up on this server yet`,
      );
    }
    const settings = this.cleanFields(def.settings ?? [], input.settings ?? {}, 'settings');
    if (input.connectionId) {
      const current = await this.db.run((tx) => this.load(tx, input.connectionId!));
      if (current.connectorKey !== def.key)
        throw new AppError(ErrorCode.INTEGRATION_INVALID, 'Wrong connection');
    }
    const state = randomBytes(32).toString('base64url');
    const saved: OAuthState = {
      orgId: actor.orgId,
      userId: actor.userId,
      connectorKey: def.key,
      name: input.name.trim(),
      settings,
      connectionId: input.connectionId ?? null,
    };
    await this.redis.set(stateKey(state), JSON.stringify(saved), 'EX', OAUTH_STATE_TTL_SECONDS);
    return {
      url: authorizeUrl(def.auth, client, { redirectUri: this.redirectUri(), state, settings }),
    };
  }

  /**
   * The provider sends the person back here. The state proves it is the sign-in this app started
   * and says for which workspace; it is deleted on first use. Returns where to send the browser.
   */
  async finishOAuth(query: { code?: string; state?: string; error?: string }): Promise<string> {
    const web = `${this.env.WEB_URL.replace(/\/$/, '')}/integrations`;
    const fail = (reason: string) => `${web}?error=${encodeURIComponent(reason)}`;
    if (!query.state) return fail('The sign-in did not come back from the provider');
    const raw = await this.redis.getdel(stateKey(query.state));
    if (!raw) return fail('That sign-in link has expired. Start again.');
    const state = JSON.parse(raw) as OAuthState;
    if (query.error || !query.code)
      return fail(query.error ?? 'The provider did not approve the sign-in');
    const def = this.connectors.get(state.connectorKey);
    const client = def?.auth.type === 'oauth2' ? oauthClient(def.auth, process.env) : null;
    if (!def || def.auth.type !== 'oauth2' || !client)
      return fail('This integration is not available');

    let tokens;
    try {
      tokens = await exchangeCode(this.fetchFn, def.auth, client, {
        code: query.code,
        redirectUri: this.redirectUri(),
        settings: state.settings,
      });
    } catch (err) {
      this.logger.warn(`OAuth code exchange for ${def.key} failed: ${String(err)}`);
      return fail('The provider refused the sign-in. Try again.');
    }
    const credentials = {
      accessToken: tokens.accessToken,
      ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
    };
    const id = state.connectionId ?? randomUUID();
    const { credentials: withSecret } = this.withWebhookSecret(def, credentials);
    await withTenant(
      this.prisma.client,
      { orgId: state.orgId, userId: state.userId },
      async (tx) => {
        const data = {
          status: 'connected',
          lastError: null,
          settings: state.settings,
          credentialsEnc: this.encrypt(id, withSecret),
          tokenExpiresAt: tokens.expiresAt,
        };
        if (state.connectionId) {
          const current = await tx.integrationConnection.findUniqueOrThrow({ where: { id } });
          // Keep the existing webhook secret: the provider already has it.
          const old = this.decrypt(current);
          const field = webhookSecretField(def);
          const merged = { ...withSecret, ...(old[field] ? { [field]: old[field] } : {}) };
          await tx.integrationConnection.update({
            where: { id },
            data: { ...data, credentialsEnc: this.encrypt(id, merged) },
          });
        } else {
          await tx.integrationConnection.create({
            data: {
              id,
              orgId: state.orgId,
              connectorKey: def.key,
              name: state.name,
              ...data,
              webhookToken: def.webhook ? randomBytes(24).toString('base64url') : null,
              syncEveryMinutes: def.sync?.everyMinutes ?? null,
              createdById: state.userId,
            },
          });
        }
        await this.audit.record(tx, state.orgId, {
          action: AuditAction.INTEGRATION_CHANGED,
          actorUserId: state.userId,
          targetType: 'integration_connection',
          targetId: id,
          metadata: {
            change: state.connectionId ? 'reconnected' : 'connected',
            connector: def.key,
          },
        });
      },
    );
    await this.afterConnect(state.orgId, id);
    return `${web}/${id}?connected=1`;
  }
}
