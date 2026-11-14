/**
 * The connector framework's worker side. Everything here is the same for every connector: a
 * connector only supplies its definition (packages/connectors).
 *
 * - Inbound events (webhooks stored by the API, or syncs) are mapped to the app's own events, the
 *   contact is found or made, flows start, and each outside event is claimed once, all in one
 *   transaction.
 * - Actions run for flows, with fresh OAuth tokens, and are logged as outbound events.
 * - OAuth tokens are refreshed before they expire; health checks and syncs run on a schedule.
 */
import { randomUUID } from 'node:crypto';
import {
  ConnectorError,
  type ConnectorContext,
  type ConnectorDefinition,
  type EventContact,
  type HttpRequest,
  type MappedEvent,
  OAuthError,
  oauthClient,
  refreshTokens,
  sha256Hex,
} from '@wacrm/connectors';
import {
  assertWithinLimit,
  Prisma,
  recordConversion,
  setContactConsent,
  type TenantTx,
  withTenant,
} from '@wacrm/db';
import { AppError, ErrorCode, type IntegrationJob } from '@wacrm/shared';
import { integrationCredentialsAad, normalizePhone } from '@wacrm/shared/server';
import type { WorkerDeps } from '../deps';
import { startFlowsForEventTx } from './flows';

const HTTP_TIMEOUT_MS = 10_000;
const HTTP_MAX_BYTES = 256 * 1024;

type Credentials = Record<string, string>;

interface LoadedConnection {
  id: string;
  orgId: string;
  connectorKey: string;
  status: string;
  settings: Record<string, string>;
  credentials: Credentials;
  tokenExpiresAt: Date | null;
  syncCursor: unknown;
  webhookToken: string | null;
}

export function decryptCredentials(deps: WorkerDeps, id: string, enc: string | null): Credentials {
  if (!enc) return {};
  return JSON.parse(deps.secrets.decrypt(enc, integrationCredentialsAad(id))) as Credentials;
}

async function loadConnection(
  deps: WorkerDeps,
  tx: TenantTx,
  id: string,
): Promise<LoadedConnection | null> {
  const row = await tx.integrationConnection.findUnique({ where: { id } });
  if (!row) return null;
  return {
    id: row.id,
    orgId: row.orgId,
    connectorKey: row.connectorKey,
    status: row.status,
    settings: (row.settings ?? {}) as Record<string, string>,
    credentials: decryptCredentials(deps, row.id, row.credentialsEnc),
    tokenExpiresAt: row.tokenExpiresAt,
    syncCursor: row.syncCursor,
    webhookToken: row.webhookToken,
  };
}

/** The connector's way out to the web: https only, the webhook SSRF guard, a short timeout. */
function connectorHttp(deps: WorkerDeps): ConnectorContext['http'] {
  return async (req: HttpRequest) => {
    if (!/^https:\/\//i.test(req.url) && !deps.allowPrivateHttp) {
      throw new ConnectorError('Only https addresses can be called');
    }
    const body =
      req.body === undefined
        ? undefined
        : typeof req.body === 'string'
          ? req.body
          : JSON.stringify(req.body);
    const headers: Record<string, string> = {
      'user-agent': 'wacrm-integrations/1',
      accept: 'application/json',
      ...(body !== undefined && typeof req.body !== 'string'
        ? { 'content-type': 'application/json' }
        : {}),
      ...req.headers,
    };
    let res;
    try {
      res = await deps.httpRequest({
        method: req.method,
        url: req.url,
        headers,
        body,
        maxBytes: HTTP_MAX_BYTES,
        timeoutMs: HTTP_TIMEOUT_MS,
      });
    } catch (err) {
      throw new ConnectorError(err instanceof Error ? err.message : 'Request failed', {
        retryable: true,
      });
    }
    let json: unknown;
    try {
      json = res.body ? JSON.parse(res.body) : null;
    } catch {
      json = null;
    }
    return { status: res.status, ok: res.status >= 200 && res.status < 300, body: res.body, json };
  };
}

function contextFor(
  deps: WorkerDeps,
  conn: LoadedConnection,
  idempotencyKey?: string,
): ConnectorContext {
  return {
    connectionId: conn.id,
    credentials: conn.credentials,
    settings: conn.settings,
    http: connectorHttp(deps),
    ...(idempotencyKey ? { idempotencyKey } : {}),
  };
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 1000);

async function setStatus(
  deps: WorkerDeps,
  orgId: string,
  connectionId: string,
  data: Prisma.IntegrationConnectionUpdateInput,
): Promise<void> {
  await withTenant(deps.db, { orgId }, (tx) =>
    tx.integrationConnection.update({ where: { id: connectionId }, data }),
  );
  deps.publisher.emit(orgId, 'integration:updated', { connectionId });
}

/** A connection that needs a person: mark it and tell the owners and admins, once. */
async function needsReconnect(
  deps: WorkerDeps,
  orgId: string,
  connectionId: string,
  reason: string,
): Promise<void> {
  const notified = await withTenant(deps.db, { orgId }, async (tx) => {
    const conn = await tx.integrationConnection.findUniqueOrThrow({ where: { id: connectionId } });
    await tx.integrationConnection.update({
      where: { id: connectionId },
      data: { status: 'needs_reconnect', lastError: reason },
    });
    if (conn.status === 'needs_reconnect') return [];
    const managers = await tx.membership.findMany({
      where: { orgId, status: 'active', role: { in: ['owner', 'admin'] } },
      select: { userId: true },
    });
    await tx.notification.createMany({
      data: managers.map((m) => ({
        orgId,
        userId: m.userId,
        kind: 'integration_needs_reconnect',
        title: `Reconnect ${conn.name}`,
        body: reason.slice(0, 200),
      })),
    });
    return managers.map((m) => m.userId);
  });
  deps.publisher.emit(orgId, 'integration:updated', { connectionId });
  for (const userId of notified) deps.publisher.emit(orgId, 'notification:new', { userId });
}

// ------------------------------------------------------------------ tokens

/**
 * Refresh an OAuth token. Concurrent callers are serialized on the row, and the second finds the
 * token already fresh. A refused grant needs a person; anything else is tried again later.
 */
export async function refreshConnection(
  deps: WorkerDeps,
  orgId: string,
  connectionId: string,
  opts: { force?: boolean } = {},
): Promise<'refreshed' | 'fresh' | 'skipped' | 'reconnect'> {
  const conn = await withTenant(deps.db, { orgId }, (tx) => loadConnection(deps, tx, connectionId));
  const def = conn && deps.connectors.get(conn.connectorKey);
  if (!conn || !def || def.auth.type !== 'oauth2' || conn.status === 'disconnected')
    return 'skipped';
  if (
    !opts.force &&
    conn.tokenExpiresAt &&
    conn.tokenExpiresAt.getTime() > Date.now() + 10 * 60_000
  ) {
    return 'fresh';
  }
  const client = oauthClient(def.auth, deps.env);
  if (!client || !conn.credentials.refreshToken) {
    await needsReconnect(deps, orgId, connectionId, 'The sign-in expired and cannot be renewed');
    return 'reconnect';
  }
  try {
    const tokens = await refreshTokens(deps.fetch, def.auth, client, {
      refreshToken: conn.credentials.refreshToken,
      settings: conn.settings,
    });
    await withTenant(deps.db, { orgId }, async (tx) => {
      // Reviewed raw SQL: a row lock under RLS, so two refreshes do not overwrite each other.
      await tx.$queryRaw`SELECT 1 FROM integration_connections WHERE id = ${connectionId}::uuid FOR UPDATE`;
      const credentials = {
        ...conn.credentials,
        accessToken: tokens.accessToken,
        ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
      };
      await tx.integrationConnection.update({
        where: { id: connectionId },
        data: {
          credentialsEnc: deps.secrets.encrypt(
            JSON.stringify(credentials),
            integrationCredentialsAad(connectionId),
          ),
          tokenExpiresAt: tokens.expiresAt,
          status: 'connected',
          lastError: null,
        },
      });
    });
    deps.publisher.emit(orgId, 'integration:updated', { connectionId });
    return 'refreshed';
  } catch (err) {
    if (err instanceof OAuthError && err.reconnect) {
      await needsReconnect(deps, orgId, connectionId, err.message);
      return 'reconnect';
    }
    await setStatus(deps, orgId, connectionId, { lastError: message(err) });
    throw err;
  }
}

/** A connection with a token that is still good, refreshed first if it is about to expire. */
async function usableConnection(
  deps: WorkerDeps,
  orgId: string,
  connectionId: string,
): Promise<{ conn: LoadedConnection; def: ConnectorDefinition }> {
  let conn = await withTenant(deps.db, { orgId }, (tx) => loadConnection(deps, tx, connectionId));
  if (!conn) throw new ConnectorError('The connection no longer exists');
  const def = deps.connectors.get(conn.connectorKey);
  if (!def) throw new ConnectorError(`The ${conn.connectorKey} connector is not available`);
  if (conn.status === 'disconnected' || conn.status === 'needs_reconnect') {
    throw new ConnectorError('The connection needs to be reconnected', { reconnect: true });
  }
  if (
    def.auth.type === 'oauth2' &&
    conn.tokenExpiresAt &&
    conn.tokenExpiresAt.getTime() < Date.now() + 60_000
  ) {
    if ((await refreshConnection(deps, orgId, connectionId)) === 'reconnect') {
      throw new ConnectorError('The connection needs to be reconnected', { reconnect: true });
    }
    conn = await withTenant(deps.db, { orgId }, (tx) => loadConnection(deps, tx, connectionId));
    if (!conn) throw new ConnectorError('The connection no longer exists');
  }
  return { conn, def };
}

// ------------------------------------------------------------------ actions

export interface ActionRequest {
  connector: string;
  action: string;
  input: Record<string, string>;
  /** null: the workspace's first working connection for the connector. */
  connectionId: string | null;
  /** Where it was asked from, for the log. */
  source?: Record<string, unknown>;
  /** Stable across a repeat of the same flow step, so the action can make things once. */
  idempotencyKey?: string;
}

export type ActionResult =
  | { ok: true; data: Record<string, unknown>; eventId: string; correlation?: string }
  | { ok: false; error: string; eventId: string | null };

/** Run one connector action and log it. Never throws: failures come back as `ok: false`. */
export async function runConnectorAction(
  deps: WorkerDeps,
  orgId: string,
  req: ActionRequest,
): Promise<ActionResult> {
  const connectionId =
    req.connectionId ??
    (await withTenant(deps.db, { orgId }, async (tx) => {
      const row = await tx.integrationConnection.findFirst({
        where: { connectorKey: req.connector, status: { in: ['connected', 'error'] } },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      });
      return row?.id ?? null;
    }));
  if (!connectionId) {
    return { ok: false, error: `No ${req.connector} connection is set up`, eventId: null };
  }

  const eventId = randomUUID();
  const log = (status: 'succeeded' | 'failed', result: unknown, error: string | null) =>
    withTenant(deps.db, { orgId }, (tx) =>
      tx.integrationEvent.create({
        data: {
          id: eventId,
          orgId,
          connectionId,
          direction: 'outbound',
          type: req.action,
          dedupeKey: eventId,
          status,
          attempts: 1,
          payload: {
            input: req.input,
            ...(req.source ? { source: req.source } : {}),
          } as Prisma.InputJsonValue,
          result: (result ?? Prisma.DbNull) as Prisma.InputJsonValue,
          error,
        },
      }),
    );

  try {
    const { conn, def } = await usableConnection(deps, orgId, connectionId);
    if (conn.connectorKey !== req.connector)
      throw new ConnectorError('That connection is for another app');
    const action = def.actions?.find((a) => a.key === req.action);
    if (!action) throw new ConnectorError(`${def.name} has no action called ${req.action}`);
    for (const field of action.input ?? []) {
      if ((field.required ?? true) && !req.input[field.key]?.trim()) {
        throw new ConnectorError(`${field.label} is empty`);
      }
    }
    const data = await action.run(contextFor(deps, conn, req.idempotencyKey), req.input);
    await log('succeeded', data, null);
    deps.publisher.emit(orgId, 'integration:updated', { connectionId });
    const correlation = action.correlation?.(data) ?? null;
    return { ok: true, data, eventId, ...(correlation ? { correlation } : {}) };
  } catch (err) {
    if (err instanceof ConnectorError && err.opts.reconnect) {
      await needsReconnect(deps, orgId, connectionId, err.message).catch(() => undefined);
    }
    await log('failed', null, message(err)).catch(() => undefined);
    deps.publisher.emit(orgId, 'integration:updated', { connectionId });
    return { ok: false, error: message(err), eventId };
  }
}

// ------------------------------------------------------------------ inbound events

/** Find the contact an event is about, by phone (made if new) or email. */
async function resolveContact(
  tx: TenantTx,
  orgId: string,
  who: EventContact | null,
  country: string,
): Promise<{ id: string } | { skip: string }> {
  if (!who) return { skip: 'The event names no customer' };
  const waId = who.phone ? normalizePhone(who.phone, country) : null;
  if (waId) {
    const existing = await tx.contact.findUnique({
      where: { orgId_waId: { orgId, waId } },
      select: { id: true, deletedAt: true, mergedIntoId: true, name: true, email: true },
    });
    if (existing?.mergedIntoId) return { id: existing.mergedIntoId };
    if (existing?.deletedAt) return { skip: 'The customer’s contact was deleted' };
    if (existing) {
      // Fill gaps only: what a person typed in the app wins.
      if ((!existing.name && who.name) || (!existing.email && who.email)) {
        await tx.contact.update({
          where: { id: existing.id },
          data: {
            ...(!existing.name && who.name ? { name: who.name.slice(0, 200) } : {}),
            ...(!existing.email && who.email
              ? { email: who.email.toLowerCase().slice(0, 320) }
              : {}),
          },
        });
      }
      return { id: existing.id };
    }
    try {
      await assertWithinLimit(tx, orgId, 'contacts');
    } catch (err) {
      if (err instanceof AppError && err.code === ErrorCode.PLAN_LIMIT_REACHED) {
        return { skip: 'The plan’s contact limit is reached' };
      }
      throw err;
    }
    const created = await tx.contact.create({
      data: {
        orgId,
        waId,
        name: who.name?.slice(0, 200) || null,
        email: who.email?.toLowerCase().slice(0, 320) || null,
      },
      select: { id: true },
    });
    return created;
  }
  if (who.email) {
    const byEmail = await tx.contact.findFirst({
      where: { email: who.email.toLowerCase(), deletedAt: null, mergedIntoId: null },
      select: { id: true },
    });
    if (byEmail) return byEmail;
  }
  return { skip: 'The customer has no phone number the app can use' };
}

interface StoredPayload {
  body?: unknown;
  headers?: Record<string, string>;
  /** Set by syncs: already mapped. */
  mapped?: MappedEvent;
}

/** Stop runs still under way that an earlier event started with one of these correlations. */
async function cancelCorrelatedRuns(
  tx: TenantTx,
  orgId: string,
  keys: string[],
  by: string,
): Promise<number> {
  if (keys.length === 0) return 0;
  const runs = await tx.flowRun.findMany({
    where: {
      status: { in: ['running', 'waiting'] },
      OR: keys.flatMap((k) => [
        { trigger: { path: ['correlation'], equals: k } },
        { trigger: { path: ['correlations'], array_contains: [k] } },
      ]),
    },
    select: { id: true, currentNodeId: true },
  });
  let cancelled = 0;
  for (const run of runs) {
    // Reviewed raw SQL: the engine holds this lock while it runs a step.
    await tx.$queryRaw`SELECT 1 FROM flow_runs WHERE id = ${run.id}::uuid FOR UPDATE`;
    const res = await tx.flowRun.updateMany({
      where: { id: run.id, status: { in: ['running', 'waiting'] } },
      data: {
        status: 'cancelled',
        endReason: 'cancelled_by_event',
        endedAt: new Date(),
        wakeAt: null,
        awaiting: Prisma.DbNull,
        input: Prisma.DbNull,
      },
    });
    if (res.count === 0) continue;
    cancelled++;
    await tx.flowRunStep.create({
      data: {
        orgId,
        runId: run.id,
        nodeId: run.currentNodeId ?? '',
        nodeType: 'run',
        outcome: 'cancelled',
        detail: { reason: 'cancelled_by_event', by },
      },
    });
  }
  return cancelled;
}

async function managerIds(tx: TenantTx, orgId: string): Promise<string[]> {
  const rows = await tx.membership.findMany({
    where: { orgId, status: 'active', role: { in: ['owner', 'admin'] } },
    select: { userId: true },
  });
  return rows.map((r) => r.userId);
}

/**
 * Act on one inbound event. The connector maps it first (it may fetch what the delivery leaves
 * out), then one transaction does everything else: effects, cancelling runs an earlier event
 * started, consent, and starting flows, with a claim on each outside event once it is acted on.
 * A redelivery, a sync of the same order or a retry after a crash finds the claim and is logged
 * as already handled.
 */
export async function processIntegrationEvent(
  deps: WorkerDeps,
  orgId: string,
  eventId: string,
  opts: { finalAttempt?: boolean } = {},
): Promise<'processed' | 'ignored' | 'skipped' | 'failed'> {
  const failed = async (err: unknown) => {
    // Rolled back. Count the try and keep the error, so the log shows why it is being retried.
    await withTenant(deps.db, { orgId }, (tx) =>
      tx.integrationEvent.updateMany({
        where: { id: eventId, status: 'received' },
        data: {
          attempts: { increment: 1 },
          error: message(err),
          ...(opts.finalAttempt ? { status: 'failed' } : {}),
        },
      }),
    ).catch(() => undefined);
    if (opts.finalAttempt) return 'failed' as const;
    throw err;
  };

  // ---- read and map, outside any transaction
  const loaded = await withTenant(deps.db, { orgId }, async (tx) => {
    const event = await tx.integrationEvent.findUnique({ where: { id: eventId } });
    if (!event || event.direction !== 'inbound' || event.status !== 'received') return null;
    const conn = await loadConnection(deps, tx, event.connectionId);
    return conn ? { event, conn } : null;
  });
  if (!loaded) return 'skipped';
  const { event, conn } = loaded;
  const def = deps.connectors.get(conn.connectorKey);
  const payload = event.payload as StoredPayload;
  let mapped: MappedEvent[] = [];
  let ignoreReason: string | null = null;
  if (!def) {
    ignoreReason = `The ${conn.connectorKey} connector is not available`;
  } else if (payload.mapped) {
    mapped = [payload.mapped];
  } else if (def.webhook) {
    try {
      mapped = await def.webhook.map(
        payload.body,
        payload.headers ?? {},
        conn.settings,
        contextFor(deps, conn),
      );
    } catch (err) {
      return failed(err);
    }
  }
  if (!ignoreReason && mapped.length === 0) ignoreReason = 'Nothing to act on';

  const attempt = () =>
    withTenant(
      deps.db,
      { orgId },
      async (tx) => {
        // Reviewed raw SQL: a row lock under RLS, so two jobs cannot act on one event.
        await tx.$queryRaw`SELECT 1 FROM integration_events WHERE id = ${eventId}::uuid FOR UPDATE`;
        const current = await tx.integrationEvent.findUnique({
          where: { id: eventId },
          select: { status: true },
        });
        if (current?.status !== 'received') return null;

        const finish = async (
          status: 'processed' | 'ignored',
          type: string | null,
          result: unknown,
        ) =>
          tx.integrationEvent.update({
            where: { id: eventId },
            data: {
              status,
              type,
              attempts: { increment: 1 },
              result: result as Prisma.InputJsonValue,
              error: null,
            },
          });
        const runIds: string[] = [];
        const notified: string[] = [];
        if (ignoreReason) {
          await finish('ignored', null, { reason: ignoreReason });
          return { status: 'ignored' as const, runIds, notified };
        }

        const org = await tx.organization.findUniqueOrThrow({
          where: { id: orgId },
          select: { billingCountry: true },
        });
        const country = conn.settings.defaultCountry || org.billingCountry || 'IN';
        const results: Record<string, unknown>[] = [];
        for (const ev of mapped) {
          const row: Record<string, unknown> = { trigger: ev.trigger, externalId: ev.externalId };
          results.push(row);

          if (ev.cancels?.length) {
            row.cancelledRuns = await cancelCorrelatedRuns(tx, orgId, ev.cancels, ev.externalId);
          }
          if (ev.effect) {
            const claim = await tx.integrationEventClaim.createMany({
              data: {
                orgId,
                connectionId: conn.id,
                externalId: ev.externalId.slice(0, 300),
                eventId,
              },
              skipDuplicates: true,
            });
            if (claim.count === 0) {
              row.skipped = 'Already handled';
              continue;
            }
            if (ev.effect.kind === 'disconnect' || ev.effect.kind === 'erase') {
              await tx.integrationConnection.update({
                where: { id: conn.id },
                data: {
                  status: 'disconnected',
                  credentialsEnc: null,
                  webhookToken: null,
                  tokenExpiresAt: null,
                  syncEveryMinutes: null,
                  lastError: ev.effect.reason,
                },
              });
              if (ev.effect.kind === 'erase') {
                // Payloads hold customers' details; the rows stay as a record that events came.
                await tx.integrationEvent.updateMany({
                  where: { connectionId: conn.id },
                  data: { payload: {}, result: Prisma.DbNull },
                });
              }
              row.effect = ev.effect.kind === 'erase' ? 'erased' : 'disconnected';
            } else {
              const managers = await managerIds(tx, orgId);
              await tx.notification.createMany({
                data: managers.map((userId) => ({
                  orgId,
                  userId,
                  kind: 'integration_request',
                  title: ev.effect?.kind === 'notify' ? ev.effect.title.slice(0, 200) : '',
                  body: ev.effect?.kind === 'notify' ? ev.effect.body.slice(0, 1000) : null,
                })),
              });
              notified.push(...managers);
              row.effect = 'notified';
            }
            continue;
          }

          const contact = await resolveContact(tx, orgId, ev.contact, country);
          if ('skip' in contact) {
            // Not claimed: a later delivery that names the customer can still act.
            row.skipped = contact.skip;
            continue;
          }
          const claim = await tx.integrationEventClaim.createMany({
            data: {
              orgId,
              connectionId: conn.id,
              externalId: ev.externalId.slice(0, 300),
              eventId,
            },
            skipDuplicates: true,
          });
          if (claim.count === 0) {
            row.skipped = 'Already handled';
            continue;
          }
          row.contactId = contact.id;
          await recordSale(tx, orgId, conn.connectorKey, contact.id, ev);
          if (ev.contact?.consent) {
            const now = await tx.contact.findUniqueOrThrow({
              where: { id: contact.id },
              select: { optInStatus: true },
            });
            // Consent given at a checkout only fills a gap; an opt-out always stands.
            if (now.optInStatus === 'unknown') {
              row.consent = await setContactConsent(tx, {
                orgId,
                contactId: contact.id,
                status: 'opted_in',
                source: ev.contact.consent.source.slice(0, 100),
                proof: ev.contact.consent.proof.slice(0, 2000),
              });
            }
          }
          const started = await startFlowsForEventTx(tx, orgId, {
            type: 'integration_event',
            connector: conn.connectorKey,
            event: ev.trigger,
            contactId: contact.id,
            data: ev.data,
            ...(ev.correlation ? { correlation: ev.correlation } : {}),
          });
          runIds.push(...started);
          row.flowsStarted = started.length;
        }
        await finish('processed', mapped[0]!.trigger, { events: results });
        return { status: 'processed' as const, runIds, notified };
      },
      { timeout: 30_000, maxWait: 10_000 },
    );

  let outcome: Awaited<ReturnType<typeof attempt>>;
  try {
    outcome = await attempt();
  } catch (err) {
    return failed(err);
  }
  if (!outcome) return 'skipped';
  for (const runId of outcome.runIds) await deps.enqueueFlowJob({ kind: 'advance', orgId, runId });
  for (const userId of outcome.notified) deps.publisher.emit(orgId, 'notification:new', { userId });
  deps.publisher.emit(orgId, 'integration:updated', { connectionId: conn.id });
  return outcome.status;
}

// ------------------------------------------------------------------ health and sync

export async function checkConnectionHealth(
  deps: WorkerDeps,
  orgId: string,
  connectionId: string,
): Promise<'ok' | 'error' | 'reconnect' | 'skipped'> {
  let usable;
  try {
    usable = await usableConnection(deps, orgId, connectionId);
  } catch (err) {
    if (err instanceof ConnectorError && err.opts.reconnect) return 'reconnect';
    return 'skipped';
  }
  const { conn, def } = usable;
  try {
    await def.healthCheck?.(contextFor(deps, conn));
    await setStatus(deps, orgId, connectionId, {
      status: 'connected',
      lastError: null,
      lastHealthAt: new Date(),
    });
    return 'ok';
  } catch (err) {
    if (err instanceof ConnectorError && err.opts.reconnect) {
      await needsReconnect(deps, orgId, connectionId, err.message);
      await setStatus(deps, orgId, connectionId, { lastHealthAt: new Date() });
      return 'reconnect';
    }
    await setStatus(deps, orgId, connectionId, {
      status: 'error',
      lastError: message(err),
      lastHealthAt: new Date(),
    });
    return 'error';
  }
}

/**
 * Fetch what changed since the last sync. Each event becomes an inbound row, deduplicated on the
 * connector's id for it, and goes through the same processing as a webhook.
 */
export async function syncConnection(
  deps: WorkerDeps,
  orgId: string,
  connectionId: string,
): Promise<{ events: number } | 'skipped'> {
  let usable;
  try {
    usable = await usableConnection(deps, orgId, connectionId);
  } catch {
    return 'skipped';
  }
  const { conn, def } = usable;
  if (!def.sync) return 'skipped';
  let result;
  try {
    result = await def.sync.run(contextFor(deps, conn), conn.syncCursor);
  } catch (err) {
    if (err instanceof ConnectorError && err.opts.reconnect) {
      await needsReconnect(deps, orgId, connectionId, err.message);
      return 'skipped';
    }
    await setStatus(deps, orgId, connectionId, { lastError: message(err), lastSyncAt: new Date() });
    throw err;
  }
  const created = await withTenant(deps.db, { orgId }, async (tx) => {
    const ids: string[] = [];
    for (const ev of result.events) {
      const id = randomUUID();
      const res = await tx.integrationEvent.createMany({
        data: {
          id,
          orgId,
          connectionId,
          direction: 'inbound',
          type: ev.trigger,
          dedupeKey: `sync:${sha256Hex(ev.externalId)}`,
          status: 'received',
          payload: { mapped: ev, via: 'sync' } as unknown as Prisma.InputJsonValue,
        },
        skipDuplicates: true,
      });
      if (res.count > 0) ids.push(id);
    }
    await tx.integrationConnection.update({
      where: { id: connectionId },
      data: {
        syncCursor: (result.cursor ?? Prisma.DbNull) as Prisma.InputJsonValue,
        lastSyncAt: new Date(),
      },
    });
    return ids;
  });
  for (const eventId of created)
    await deps.enqueueIntegrationJob({ kind: 'event', orgId, eventId });
  deps.publisher.emit(orgId, 'integration:updated', { connectionId });
  return { events: created.length };
}

/**
 * Run the connector's setup after connecting or reconnecting, such as registering its webhooks
 * with the provider at this connection's address. Connectors make it safe to run twice.
 */
export async function setupConnection(
  deps: WorkerDeps,
  orgId: string,
  connectionId: string,
): Promise<'done' | 'skipped' | 'reconnect'> {
  let usable;
  try {
    usable = await usableConnection(deps, orgId, connectionId);
  } catch {
    return 'skipped';
  }
  const { conn, def } = usable;
  if (!def.setup) return 'skipped';
  const webhookUrl = conn.webhookToken
    ? `${deps.apiPublicUrl.replace(/\/$/, '')}/integrations/hooks/${conn.webhookToken}`
    : null;
  try {
    const learned = await def.setup(contextFor(deps, conn), { webhookUrl });
    if (learned?.credentials && Object.keys(learned.credentials).length) {
      await withTenant(deps.db, { orgId }, async (tx) => {
        // Reviewed raw SQL: a row lock under RLS, so a token refresh cannot overwrite this.
        await tx.$queryRaw`SELECT 1 FROM integration_connections WHERE id = ${connectionId}::uuid FOR UPDATE`;
        const row = await tx.integrationConnection.findUniqueOrThrow({
          where: { id: connectionId },
          select: { credentialsEnc: true },
        });
        const credentials = {
          ...decryptCredentials(deps, connectionId, row.credentialsEnc),
          ...learned.credentials,
        };
        await tx.integrationConnection.update({
          where: { id: connectionId },
          data: {
            credentialsEnc: deps.secrets.encrypt(
              JSON.stringify(credentials),
              integrationCredentialsAad(connectionId),
            ),
          },
        });
      });
    }
    await setStatus(deps, orgId, connectionId, { lastError: null });
    return 'done';
  } catch (err) {
    if (err instanceof ConnectorError && err.opts.reconnect) {
      await needsReconnect(deps, orgId, connectionId, err.message);
      return 'reconnect';
    }
    await setStatus(deps, orgId, connectionId, {
      status: 'error',
      lastError: `Setup: ${message(err)}`,
    });
    throw err;
  }
}

/** Refreshes, health checks and syncs that are due, across orgs. A definer function; ids only. */
export function integrationDueWork(deps: Pick<WorkerDeps, 'db'>, limit = 500) {
  return deps.db.$queryRaw<{ org_id: string; id: string; kind: 'refresh' | 'health' | 'sync' }[]>`
    SELECT org_id, id, kind FROM integration_due_work(${limit}::int)`;
}

export async function processIntegrationJob(
  deps: WorkerDeps,
  job: IntegrationJob,
  opts: { finalAttempt?: boolean } = {},
): Promise<string> {
  switch (job.kind) {
    case 'event':
      return processIntegrationEvent(deps, job.orgId, job.eventId, opts);
    case 'refresh':
      return refreshConnection(deps, job.orgId, job.connectionId);
    case 'health':
      return checkConnectionHealth(deps, job.orgId, job.connectionId);
    case 'setup':
      return setupConnection(deps, job.orgId, job.connectionId);
    case 'sync': {
      const r = await syncConnection(deps, job.orgId, job.connectionId);
      return r === 'skipped' ? r : `synced ${r.events}`;
    }
  }
}

/**
 * A paid order or payment is a conversion for the reports. Claimed with the event above, and
 * unique on its reference too, so a store and its payment provider cannot count one sale twice
 * under the same id.
 */
async function recordSale(
  tx: TenantTx,
  orgId: string,
  connector: string,
  contactId: string,
  ev: { trigger: string; data: Record<string, unknown> },
): Promise<void> {
  const pick = (v: unknown) => (v && typeof v === 'object' ? (v as Record<string, unknown>) : null);
  const str = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');
  if (ev.trigger === 'order.paid') {
    const order = pick(ev.data.order);
    if (!order) return;
    await recordConversion(tx, {
      orgId,
      contactId,
      source: 'store_order',
      reference: `${connector}:${str(order.id)}`,
      amount: str(order.total),
      currency: str(order.currency),
    });
  } else if (ev.trigger === 'payment.paid') {
    const payment = pick(ev.data.payment);
    if (!payment) return;
    const id = str(payment.id) || str(payment.linkId);
    if (!id) return;
    await recordConversion(tx, {
      orgId,
      contactId,
      source: 'payment',
      reference: `${connector}:${id}`,
      amount: str(payment.amount),
      currency: str(payment.currency),
    });
  }
}
