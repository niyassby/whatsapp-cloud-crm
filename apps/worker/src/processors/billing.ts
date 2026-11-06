import type { BillingEvent, PaymentProvider, SubscriptionState } from '@wacrm/billing';
import {
  creditWallet,
  type DbClient,
  recordInvoice,
  subscriptionInvoiceAmounts,
  withTenant,
} from '@wacrm/db';
import type { WorkerDeps } from '../deps';

interface LoadedEvent {
  id: string;
  provider: string;
  type: string;
  payload: unknown;
  status: string;
}

/** Reviewed raw SQL: narrow definer functions with bound parameters, as no org is known yet. */
const loadEvent = async (db: DbClient, id: string) => {
  const [row] = await db.$queryRaw<LoadedEvent[]>`
    SELECT id, provider, type, payload, status::text AS status FROM billing_event_load(${id}::uuid)`;
  return row ?? null;
};

const markEvent = (
  db: DbClient,
  id: string,
  status: 'processed' | 'ignored' | 'failed',
  orgId: string | null,
  error: string | null,
) =>
  db.$executeRaw`
    SELECT billing_event_mark(
      ${id}::uuid, ${status}::billing_event_status, ${orgId}::uuid, ${error}
    )`;

export const orgForRef = async (db: DbClient, provider: string, ref: string) => {
  const [row] = await db.$queryRaw<{ org_id: string | null }[]>`
    SELECT billing_org_for_ref(${provider}, ${ref}) AS org_id`;
  return row?.org_id ?? null;
};

/** A paid event that cannot be applied as it stands. Retrying would not help. */
class RefusedEvent extends Error {}

/**
 * Credit the wallet for a paid top-up, once. The event is signature-checked, so its ids are ours,
 * and the amount is still compared with what was asked for. RLS confines this to the org named.
 */
async function applyTopupPaid(
  deps: WorkerDeps,
  provider: string,
  ev: Extract<BillingEvent, { kind: 'topup.paid' }>,
): Promise<string> {
  const orgId = ev.orgId ?? (await orgForRef(deps.db, provider, ev.providerRef));
  // The webhook can beat the API saving the provider's reference, so this may work on a retry.
  if (!orgId) throw new Error('No workspace found for this payment yet');

  await withTenant(deps.db, { orgId }, async (tx) => {
    const topup = await tx.walletTopup.findUnique({ where: { id: ev.topupId } });
    if (!topup || topup.provider !== provider) {
      throw new RefusedEvent(`No matching top-up for ${ev.providerRef}`);
    }
    if (
      topup.currency !== ev.currency ||
      Number(topup.totalMicros) !== Math.round(ev.amountMicros)
    ) {
      // Never credit an amount nobody asked for. Someone needs to look at this one.
      await tx.walletTopup.update({
        where: { id: topup.id },
        data: {
          status: 'failed',
          failure: `Paid ${ev.amountMicros} ${ev.currency}, expected ${topup.totalMicros} ${topup.currency}`,
        },
      });
      return;
    }
    // The key is the top-up, not the event: two different events about one payment credit once.
    await creditWallet(tx, {
      orgId,
      amountMicros: Number(topup.creditMicros),
      idempotencyKey: `topup:${topup.id}`,
      referenceType: 'topup',
      referenceId: topup.id,
      description: 'Wallet top-up',
      type: 'credit',
    });
    await recordInvoice(tx, {
      orgId,
      kind: 'topup',
      provider,
      providerRef: ev.paymentRef,
      description: 'Wallet top-up',
      currency: topup.currency,
      subtotalMicros: Number(topup.creditMicros),
      taxMicros: Number(topup.taxMicros),
      taxRateBps: topup.taxRateBps,
      taxLabel: topup.taxLabel,
      totalMicros: Number(topup.totalMicros),
    });
    await tx.walletTopup.update({
      where: { id: topup.id },
      data: { status: 'paid', paidAt: topup.paidAt ?? new Date(), failure: null },
    });
  });
  deps.publisher.emit(orgId, 'wallet:updated', {});
  deps.publisher.emit(orgId, 'billing:updated', {});
  return orgId;
}

/** Bring the local row in line with what the provider says now. Safe to run in any order. */
async function applySubscriptionState(
  deps: WorkerDeps,
  provider: PaymentProvider,
  orgId: string,
  state: SubscriptionState,
): Promise<void> {
  const { status } = state;
  if (status === 'incomplete') return;
  await withTenant(deps.db, { orgId }, async (tx) => {
    const current = await tx.subscription.findUnique({ where: { orgId } });
    // The end of an old subscription must not cancel the one that replaced it.
    if (
      status === 'cancelled' &&
      current?.providerSubscriptionId &&
      current.providerSubscriptionId !== state.ref
    ) {
      return;
    }
    const price = state.priceRef
      ? await tx.planPrice.findFirst({ where: { [provider.priceColumn]: state.priceRef } })
      : null;
    if (!price) {
      throw new RefusedEvent(`No plan has the ${provider.id} price ${state.priceRef}`);
    }
    const data = {
      planId: price.planId,
      status,
      provider: provider.id,
      providerSubscriptionId: state.ref,
      providerCustomerId: state.customerRef,
      trialEndsAt: null,
      currentPeriodStart: state.periodStart,
      currentPeriodEnd: state.periodEnd,
      ...(state.cancelAtPeriodEnd === null ? {} : { cancelAtPeriodEnd: state.cancelAtPeriodEnd }),
    };
    await tx.subscription.upsert({
      where: { orgId },
      create: { orgId, ...data },
      update: data,
    });
  });
  deps.publisher.emit(orgId, 'billing:updated', {});
}

async function applyEvent(
  deps: WorkerDeps,
  provider: PaymentProvider,
  ev: BillingEvent,
): Promise<string> {
  if (ev.kind === 'topup.paid') return applyTopupPaid(deps, provider.id, ev);

  if (ev.kind === 'subscription.changed') {
    // Providers do not promise order, so ask for the current state instead of trusting this event.
    // Outside any transaction: never hold a connection across a call to someone else's API.
    const state = await provider.getSubscription(ev.subscriptionRef);
    const orgId =
      state.orgId ?? ev.orgId ?? (await orgForRef(deps.db, provider.id, ev.subscriptionRef));
    if (!orgId) throw new RefusedEvent(`No workspace for subscription ${ev.subscriptionRef}`);
    await applySubscriptionState(deps, provider, orgId, state);
    return orgId;
  }

  const orgId = ev.orgId ?? (await orgForRef(deps.db, provider.id, ev.subscriptionRef));
  if (!orgId) throw new Error('No workspace found for this subscription yet');
  await withTenant(deps.db, { orgId }, async (tx) => {
    const sub = await tx.subscription.findUnique({
      where: { orgId },
      include: { plan: { select: { name: true } } },
    });
    await recordInvoice(tx, {
      orgId,
      kind: 'subscription',
      provider: provider.id,
      providerRef: ev.paymentRef,
      description: `${sub?.plan.name ?? 'Plan'} subscription`,
      currency: ev.currency,
      ...(await subscriptionInvoiceAmounts(tx, orgId, Math.round(ev.amountMicros))),
      periodStart: ev.periodStart,
      periodEnd: ev.periodEnd,
    });
  });
  deps.publisher.emit(orgId, 'billing:updated', {});
  return orgId;
}

/**
 * One stored provider event. Running it again changes nothing: credits and invoices are keyed by
 * the payment, and subscriptions are set to the provider's current state.
 */
export async function processBillingEvent(
  deps: WorkerDeps,
  eventId: string,
  opts: { finalAttempt: boolean },
): Promise<'processed' | 'ignored' | 'failed' | 'missing'> {
  const row = await loadEvent(deps.db, eventId);
  if (!row) return 'missing';
  const provider = deps.payments[row.provider as keyof typeof deps.payments];
  if (!provider) throw new Error(`The ${row.provider} provider is not configured`);

  const events = provider.parseEvent(row.type, row.payload);
  if (events.length === 0) {
    await markEvent(deps.db, eventId, 'ignored', null, null);
    return 'ignored';
  }
  try {
    let orgId: string | null = null;
    for (const ev of events) orgId = await applyEvent(deps, provider, ev);
    await markEvent(deps.db, eventId, 'processed', orgId, null);
    return 'processed';
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof RefusedEvent) {
      await markEvent(deps.db, eventId, 'failed', null, message.slice(0, 1000));
      return 'failed';
    }
    if (opts.finalAttempt)
      await markEvent(deps.db, eventId, 'failed', null, message.slice(0, 1000));
    throw err;
  }
}
