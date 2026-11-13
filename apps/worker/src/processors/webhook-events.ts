import {
  applyTemplateEvent,
  type DbClient,
  disconnectWabaTx,
  TEMPLATE_WEBHOOK_FIELDS,
  type TenantTx,
  withTenant,
} from '@wacrm/db';
import type { WorkerDeps } from '../deps';
import { processCallsChange, processGroupChange, processInstagramEvent } from './channels';
import { processMessagesChange } from './inbound';

interface EventRow {
  id: string;
  org_id: string | null;
  provider: string;
  waba_id: string | null;
  phone_number_id: string | null;
  field: string | null;
  payload: unknown;
  status: string;
}

export type RouteOutcome = 'missing' | 'skipped' | 'ignored' | 'processed';

/** Events that mean the customer took our app off their WABA. */
const REMOVAL_EVENTS = new Set(['PARTNER_APP_UNINSTALLED', 'PARTNER_REMOVED']);

const digits = (s: string | null | undefined) => (s ?? '').replace(/\D/g, '');

/** The single `value` of a split event: each stored payload holds exactly one change. */
function changeValue(payload: unknown): Record<string, unknown> {
  const entry = (payload as { entry?: { changes?: { value?: unknown }[] }[] } | null)?.entry;
  const value = entry?.[0]?.changes?.[0]?.value;
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

/** When Meta sent this. Falls back to now, since not every event carries a time. */
function entryTime(payload: unknown): Date {
  const time = (payload as { entry?: { time?: unknown }[] } | null)?.entry?.[0]?.time;
  return typeof time === 'number' ? new Date(time * 1000) : new Date();
}

async function markEvent(
  db: DbClient,
  id: string,
  status: string,
  org: string | null,
  err: string | null,
) {
  await db.$executeRaw`
    SELECT webhook_event_mark(${id}::uuid, ${status}::"WebhookEventStatus", ${org}::uuid, ${err})`;
}

export const markEventFailed = (db: DbClient, id: string, err: string) =>
  markEvent(db, id, 'failed', null, err.slice(0, 1000));

/** Account-level events update the connection itself. */
async function applyAccountEvent(tx: TenantTx, orgId: string, event: EventRow): Promise<void> {
  const value = changeValue(event.payload);

  if (event.field === 'phone_number_quality_update' && event.waba_id) {
    const limit = typeof value.current_limit === 'string' ? value.current_limit : null;
    const number = digits(value.display_phone_number as string | undefined);
    if (!number) return;
    // Meta reports a quality drop as FLAGGED, and its recovery as UNFLAGGED.
    const quality =
      value.event === 'FLAGGED' ? 'RED' : value.event === 'UNFLAGGED' ? 'GREEN' : undefined;
    if (!limit && !quality) return;
    const phones = await tx.phoneNumber.findMany({
      where: { wabaAccount: { wabaId: event.waba_id }, status: { not: 'disconnected' } },
      select: { id: true, displayPhoneNumber: true },
    });
    for (const p of phones.filter((x) => digits(x.displayPhoneNumber) === number)) {
      await tx.phoneNumber.update({
        where: { id: p.id },
        data: {
          ...(limit ? { messagingTier: limit } : {}),
          ...(quality ? { qualityRating: quality } : {}),
        },
      });
    }
    return;
  }

  if (event.field === 'account_update' && event.waba_id) {
    if (typeof value.event !== 'string' || !REMOVAL_EVENTS.has(value.event)) return;
    const waba = await tx.wabaAccount.findFirst({
      where: { wabaId: event.waba_id, status: 'active' },
      select: { id: true },
    });
    if (!waba) return;
    await disconnectWabaTx(tx, waba.id, `Removed in Meta Business Suite (${value.event})`);
    await tx.auditLog.create({
      data: {
        orgId,
        action: 'whatsapp.disconnected',
        targetType: 'waba_account',
        targetId: waba.id,
        metadata: { reason: value.event },
      },
    });
  }
}

async function applyTemplateChange(
  deps: WorkerDeps,
  orgId: string,
  event: EventRow,
  field: string,
  wabaId: string,
): Promise<void> {
  const outcome = await withTenant(deps.db, { orgId }, (tx) =>
    applyTemplateEvent(tx, {
      wabaId,
      field,
      value: changeValue(event.payload),
      at: entryTime(event.payload),
    }),
  );
  if (outcome.kind === 'applied') {
    deps.publisher.emit(orgId, 'template:updated', { templateId: outcome.templateId });
  } else if (outcome.kind === 'needs_sync') {
    await deps.enqueueTemplateSync({ orgId, wabaAccountId: outcome.wabaAccountId });
  }
}

/**
 * Route an event to its org and apply it. Idempotent: only 'received' events do work, and message
 * handling dedupes by wamid, so a retry, a duplicate job or a replay changes nothing twice.
 */
export async function routeWebhookEvent(deps: WorkerDeps, eventId: string): Promise<RouteOutcome> {
  const { db } = deps;
  const [event] = await db.$queryRaw<
    EventRow[]
  >`SELECT * FROM webhook_event_load(${eventId}::uuid)`;
  if (!event) return 'missing'; // purged by retention
  if (event.status !== 'received') return 'skipped';
  if (event.provider === 'instagram') return routeInstagramEvent(deps, event);

  // Keep an earlier routing decision, so history stays with the org it belonged to.
  const [route] = event.org_id
    ? [{ org_id: event.org_id }]
    : await db.$queryRaw<{ org_id: string }[]>`
        SELECT org_id FROM webhook_route_lookup(${event.phone_number_id}, ${event.waba_id})`;
  if (!route) {
    await markEvent(db, eventId, 'ignored', null, 'No active number or WABA for this event');
    return 'ignored';
  }

  await withTenant(db, { orgId: route.org_id }, (tx) => applyAccountEvent(tx, route.org_id, event));
  if (event.field === 'messages') await processMessagesChange(deps, route.org_id, event.payload);
  if (event.field === 'calls') await processCallsChange(deps, route.org_id, event.payload);
  if (event.field?.startsWith('group_')) {
    await processGroupChange(deps, route.org_id, event.field, event.payload);
  }
  if (event.field && TEMPLATE_WEBHOOK_FIELDS.has(event.field) && event.waba_id) {
    await applyTemplateChange(deps, route.org_id, event, event.field, event.waba_id);
  }
  await markEvent(db, eventId, 'processed', route.org_id, null);
  return 'processed';
}

/** Instagram events name the account, which names the channel and so the workspace. */
async function routeInstagramEvent(deps: WorkerDeps, event: EventRow): Promise<RouteOutcome> {
  const { db } = deps;
  // Reviewed raw SQL: a definer function, since no workspace is known until the account is.
  const [route] = await db.$queryRaw<{ org_id: string; channel_id: string }[]>`
    SELECT org_id, channel_id FROM channel_route_lookup('instagram'::"ChannelKind", ${event.waba_id})`;
  if (!route || (event.org_id && event.org_id !== route.org_id)) {
    await markEvent(db, event.id, 'ignored', null, 'No connected Instagram account for this event');
    return 'ignored';
  }
  await processInstagramEvent(deps, route.org_id, route.channel_id, event.payload);
  await markEvent(db, event.id, 'processed', route.org_id, null);
  return 'processed';
}
