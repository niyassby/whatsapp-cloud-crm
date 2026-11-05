import { type DbClient, disconnectWabaTx, type TenantTx, withTenant } from '@wacrm/db';

interface EventRow {
  id: string;
  org_id: string | null;
  waba_id: string | null;
  phone_number_id: string | null;
  field: string | null;
  payload: unknown;
  status: string;
}

export type RouteOutcome = 'missing' | 'skipped' | 'ignored' | 'routed';

/** Events that mean the customer took our app off their WABA. */
const REMOVAL_EVENTS = new Set(['PARTNER_APP_UNINSTALLED', 'PARTNER_REMOVED']);

const digits = (s: string | null | undefined) => (s ?? '').replace(/\D/g, '');

/** The single `value` of a split event: each stored payload holds exactly one change. */
function changeValue(payload: unknown): Record<string, unknown> {
  const entry = (payload as { entry?: { changes?: { value?: unknown }[] }[] } | null)?.entry;
  const value = entry?.[0]?.changes?.[0]?.value;
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
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

/** Account-level events update the connection itself; message handling arrives in Phase 1.5. */
async function applyAccountEvent(tx: TenantTx, orgId: string, event: EventRow): Promise<void> {
  const value = changeValue(event.payload);

  if (event.field === 'phone_number_quality_update' && event.waba_id) {
    const limit = typeof value.current_limit === 'string' ? value.current_limit : null;
    const number = digits(value.display_phone_number as string | undefined);
    if (!limit || !number) return;
    const phones = await tx.phoneNumber.findMany({
      where: { wabaAccount: { wabaId: event.waba_id }, status: { not: 'disconnected' } },
      select: { id: true, displayPhoneNumber: true },
    });
    for (const p of phones.filter((x) => digits(x.displayPhoneNumber) === number)) {
      await tx.phoneNumber.update({ where: { id: p.id }, data: { messagingTier: limit } });
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

/**
 * Resolve an event to its org. Idempotent: only 'received' events do work, so a retry or a
 * duplicate job after success is a no-op. Replay resets the status to 'received'.
 */
export async function routeWebhookEvent(db: DbClient, eventId: string): Promise<RouteOutcome> {
  const [event] = await db.$queryRaw<
    EventRow[]
  >`SELECT * FROM webhook_event_load(${eventId}::uuid)`;
  if (!event) return 'missing'; // purged by retention
  if (event.status !== 'received') return 'skipped';

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
  await markEvent(db, eventId, 'routed', route.org_id, null);
  return 'routed';
}
