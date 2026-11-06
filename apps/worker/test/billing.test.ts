/**
 * Phase 2.5 acceptance on real Postgres: payments credit the wallet exactly once, and subscription
 * events move the plan, whatever order they arrive in and however often.
 */
import { randomUUID } from 'node:crypto';
import { StripeProvider } from '@wacrm/billing';
import { type DbClient, ensureWallet, startTrial, withTenant } from '@wacrm/db';
import { contactJobKey } from '@wacrm/shared/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { processBillingEvent } from '../src/processors/billing';
import { processContactJob } from '../src/processors/contact-jobs';
import { processMessagesChange } from '../src/processors/inbound';
import { buildDeps, connectNumber, createOrg, db, ownerDb } from './support';

let client: DbClient;
let owner: DbClient;

/** What the fake Stripe says each subscription looks like right now. */
const subscriptions = new Map<string, object>();
const stripe = new StripeProvider({
  secretKey: 'sk',
  webhookSecret: 'whsec',
  fetch: (async (url: string) => {
    const ref = url.split('/').pop() ?? '';
    const sub = subscriptions.get(ref);
    return new Response(JSON.stringify(sub ?? { error: { message: 'gone' } }), {
      status: sub ? 200 : 404,
    });
  }) as unknown as typeof fetch,
});

const CURRENCY = 'XBL';
const PRICE = `price_${randomUUID().slice(0, 8)}`;
const OTHER_PRICE = `price_${randomUUID().slice(0, 8)}`;

beforeAll(async () => {
  client = db();
  owner = ownerDb();
  const plans = await owner.plan.findMany({ where: { code: { in: ['starter', 'scale'] } } });
  const id = (code: string) => plans.find((p) => p.code === code)!.id;
  await owner.planPrice.createMany({
    data: [
      {
        planId: id('starter'),
        currency: CURRENCY,
        interval: 'month',
        amountMicros: 1_180_000_000n,
        stripePriceId: PRICE,
      },
      {
        planId: id('scale'),
        currency: CURRENCY,
        interval: 'month',
        amountMicros: 5_000_000_000n,
        stripePriceId: OTHER_PRICE,
      },
    ],
  });
});
afterAll(async () => {
  await client.$disconnect();
  await owner.$disconnect();
});

async function setup(opts: { country?: string } = {}) {
  const orgId = await createOrg(client);
  const built = buildDeps(client);
  built.deps.payments = { stripe };
  await withTenant(client, { orgId }, async (tx) => {
    await ensureWallet(tx, orgId, CURRENCY);
    await startTrial(tx, orgId);
    if (opts.country) {
      await tx.organization.update({
        where: { id: orgId },
        data: { billingCountry: opts.country, billingName: 'Acme Traders', taxId: 'GST123' },
      });
    }
  });

  const topup = async (over: { credit?: number; tax?: number } = {}) => {
    const credit = over.credit ?? 1000_000_000;
    const tax = over.tax ?? 180_000_000;
    return withTenant(client, { orgId }, (tx) =>
      tx.walletTopup.create({
        data: {
          orgId,
          provider: 'stripe',
          providerRef: `cs_${randomUUID()}`,
          currency: CURRENCY,
          creditMicros: BigInt(credit),
          taxMicros: BigInt(tax),
          taxRateBps: 1800,
          taxLabel: 'GST',
          totalMicros: BigInt(credit + tax),
        },
      }),
    );
  };

  /** Stored the way the webhook controller stores it. */
  const ingest = async (type: string, object: object, eventId = `evt_${randomUUID()}`) => {
    const payload = JSON.stringify({ id: eventId, type, data: { object } });
    const [row] = await client.$queryRaw<{ id: string }[]>`
      SELECT id FROM billing_event_ingest('stripe', ${eventId}, ${type}, ${payload}::jsonb)`;
    return row!.id;
  };
  const run = (id: string, finalAttempt = true) =>
    processBillingEvent(built.deps, id, { finalAttempt });
  const deliver = async (type: string, object: object, eventId?: string) =>
    run(await ingest(type, object, eventId));

  const paidSession = (t: { id: string; providerRef: string | null }, over: object = {}) => ({
    id: t.providerRef,
    mode: 'payment',
    payment_status: 'paid',
    payment_intent: `pi_${t.id}`,
    amount_total: 118000,
    currency: CURRENCY.toLowerCase(),
    metadata: { orgId, topupId: t.id },
    ...over,
  });

  const wallet = () =>
    withTenant(client, { orgId }, (tx) => tx.wallet.findUniqueOrThrow({ where: { orgId } }));
  const invoices = () =>
    withTenant(client, { orgId }, (tx) =>
      tx.invoice.findMany({ where: { orgId }, orderBy: { number: 'asc' } }),
    );
  const subscription = () =>
    withTenant(client, { orgId }, (tx) =>
      tx.subscription.findUniqueOrThrow({
        where: { orgId },
        include: { plan: { select: { code: true } } },
      }),
    );
  const event = (id: string) => owner.billingEvent.findUniqueOrThrow({ where: { id } });

  return {
    orgId,
    ...built,
    topup,
    ingest,
    run,
    deliver,
    paidSession,
    wallet,
    invoices,
    subscription,
    event,
  };
}

const stripeSub = (
  orgId: string | undefined,
  over: { status?: string; price?: string; end?: number; cancel?: boolean } = {},
) => ({
  status: over.status ?? 'active',
  customer: 'cus_1',
  cancel_at_period_end: over.cancel ?? false,
  metadata: orgId ? { orgId } : {},
  items: {
    data: [
      {
        id: 'si_1',
        price: { id: over.price ?? PRICE },
        current_period_start: 1_800_000_000,
        current_period_end: over.end ?? 1_900_000_000,
      },
    ],
  },
});

describe('acceptance: a top-up credits the wallet exactly once', () => {
  it('when the same webhook is delivered twice', async () => {
    const s = await setup();
    const t = await s.topup();
    const eventId = `evt_${randomUUID()}`;
    await s.deliver('checkout.session.completed', s.paidSession(t), eventId);
    await s.deliver('checkout.session.completed', s.paidSession(t), eventId);
    expect(Number((await s.wallet()).balanceMicros)).toBe(1000_000_000);
    expect(await s.invoices()).toHaveLength(1);
  });

  it('when a job runs again, or a replay runs an event twice', async () => {
    const s = await setup();
    const t = await s.topup();
    const id = await s.ingest('checkout.session.completed', s.paidSession(t));
    await s.run(id);
    await s.run(id);
    await s.run(id);
    expect(Number((await s.wallet()).balanceMicros)).toBe(1000_000_000);
  });

  it('when two different events report one payment', async () => {
    const s = await setup();
    const t = await s.topup();
    await s.deliver('checkout.session.completed', s.paidSession(t));
    await s.deliver('checkout.session.async_payment_succeeded', s.paidSession(t));
    expect(Number((await s.wallet()).balanceMicros)).toBe(1000_000_000);
    expect(await s.invoices()).toHaveLength(1);
  });

  it('when many deliveries race', async () => {
    const s = await setup();
    const t = await s.topup();
    const ids = await Promise.all(
      Array.from({ length: 8 }, () => s.ingest('checkout.session.completed', s.paidSession(t))),
    );
    await Promise.all(ids.map((id) => s.run(id)));
    expect(Number((await s.wallet()).balanceMicros)).toBe(1000_000_000);
    expect(await s.invoices()).toHaveLength(1);
    const ledger = await withTenant(client, { orgId: s.orgId }, (tx) =>
      tx.walletLedger.count({ where: { orgId: s.orgId } }),
    );
    expect(ledger).toBe(1);
  }, 60_000);
});

describe('what a top-up does', () => {
  it('credits what was asked for, not the tax, and marks it paid', async () => {
    const s = await setup();
    const t = await s.topup();
    expect(await s.deliver('checkout.session.completed', s.paidSession(t))).toBe('processed');
    const row = await withTenant(client, { orgId: s.orgId }, (tx) =>
      tx.walletTopup.findUniqueOrThrow({ where: { id: t.id } }),
    );
    expect(row.status).toBe('paid');
    expect(row.paidAt).toBeInstanceOf(Date);
    expect(s.publisher.of('wallet:updated')).toHaveLength(1);
  });

  it('invoices the payment with its tax, copied from the top-up', async () => {
    const s = await setup({ country: 'IN' });
    const t = await s.topup();
    await s.deliver('checkout.session.completed', s.paidSession(t));
    const [invoice] = await s.invoices();
    expect(invoice).toMatchObject({
      kind: 'topup',
      subtotalMicros: 1000_000_000n,
      taxMicros: 180_000_000n,
      totalMicros: 1180_000_000n,
      taxLabel: 'GST',
      taxRateBps: 1800,
      billTo: { name: 'Acme Traders', taxId: 'GST123', country: 'IN' },
    });
    expect(invoice!.number).toMatch(/^INV-\d{4}-\d{6}$/);
  });

  it('an unpaid session credits nothing', async () => {
    const s = await setup();
    const t = await s.topup();
    const result = await s.deliver(
      'checkout.session.completed',
      s.paidSession(t, { payment_status: 'unpaid' }),
    );
    expect(result).toBe('ignored');
    expect(Number((await s.wallet()).balanceMicros)).toBe(0);
  });

  it('a different amount credits nothing, and is kept for someone to look at', async () => {
    const s = await setup();
    const t = await s.topup();
    await s.deliver('checkout.session.completed', s.paidSession(t, { amount_total: 100 }));
    expect(Number((await s.wallet()).balanceMicros)).toBe(0);
    const row = await withTenant(client, { orgId: s.orgId }, (tx) =>
      tx.walletTopup.findUniqueOrThrow({ where: { id: t.id } }),
    );
    expect(row.status).toBe('failed');
    expect(row.failure).toContain('expected');
    expect(await s.invoices()).toEqual([]);
  });

  it('a different currency credits nothing', async () => {
    const s = await setup();
    const t = await s.topup();
    await s.deliver('checkout.session.completed', s.paidSession(t, { currency: 'usd' }));
    expect(Number((await s.wallet()).balanceMicros)).toBe(0);
  });

  it('another workspace named in an event cannot reach this top-up', async () => {
    const victim = await setup();
    const other = await setup();
    const t = await victim.topup();
    const id = await victim.ingest(
      'checkout.session.completed',
      victim.paidSession(t, { metadata: { orgId: other.orgId, topupId: t.id } }),
    );
    expect(await victim.run(id)).toBe('failed');
    expect(Number((await victim.wallet()).balanceMicros)).toBe(0);
    expect(Number((await other.wallet()).balanceMicros)).toBe(0);
    expect((await victim.event(id)).error).toContain('No matching top-up');
  });

  it('with no org in the event, finds it through the stored reference', async () => {
    const s = await setup();
    const t = await s.topup();
    await s.deliver(
      'checkout.session.completed',
      s.paidSession(t, { metadata: { topupId: t.id } }),
    );
    expect(Number((await s.wallet()).balanceMicros)).toBe(1000_000_000);
  });

  it('if the webhook beats the saved reference, retries rather than losing the payment', async () => {
    const s = await setup();
    const t = await s.topup();
    await withTenant(client, { orgId: s.orgId }, (tx) =>
      tx.walletTopup.update({ where: { id: t.id }, data: { providerRef: null } }),
    );
    const id = await s.ingest(
      'checkout.session.completed',
      s.paidSession(t, { id: 'cs_late', metadata: { topupId: t.id } }),
    );
    await expect(s.run(id, false)).rejects.toThrow('No workspace');
    expect((await s.event(id)).status).toBe('received');

    await withTenant(client, { orgId: s.orgId }, (tx) =>
      tx.walletTopup.update({ where: { id: t.id }, data: { providerRef: 'cs_late' } }),
    );
    expect(await s.run(id)).toBe('processed');
    expect(Number((await s.wallet()).balanceMicros)).toBe(1000_000_000);
  });
});

describe('subscriptions', () => {
  const changed = (ref: string, orgId?: string) => ({ id: ref, metadata: orgId ? { orgId } : {} });

  it('an event moves the plan to what the provider says, and ends the trial', async () => {
    const s = await setup();
    const ref = `sub_${randomUUID()}`;
    subscriptions.set(ref, stripeSub(s.orgId));
    expect(await s.deliver('customer.subscription.created', changed(ref, s.orgId))).toBe(
      'processed',
    );
    expect(await s.subscription()).toMatchObject({
      status: 'active',
      plan: { code: 'starter' },
      provider: 'stripe',
      providerSubscriptionId: ref,
      providerCustomerId: 'cus_1',
      trialEndsAt: null,
      currentPeriodEnd: new Date(1_900_000_000_000),
    });
    expect(s.publisher.of('billing:updated')).toHaveLength(1);
  });

  it('events in the wrong order still land on the current state', async () => {
    const s = await setup();
    const ref = `sub_${randomUUID()}`;
    // The provider has already moved on to the bigger plan.
    subscriptions.set(ref, stripeSub(s.orgId, { price: OTHER_PRICE }));
    await s.deliver('customer.subscription.updated', changed(ref, s.orgId));
    // A late event from when it was on the smaller plan changes nothing.
    await s.deliver('customer.subscription.created', changed(ref, s.orgId));
    expect((await s.subscription()).plan.code).toBe('scale');
  });

  it('an event before payment changes nothing', async () => {
    const s = await setup();
    const ref = `sub_${randomUUID()}`;
    subscriptions.set(ref, stripeSub(s.orgId, { status: 'incomplete' }));
    await s.deliver('customer.subscription.created', changed(ref, s.orgId));
    expect(await s.subscription()).toMatchObject({
      status: 'trialing',
      providerSubscriptionId: null,
    });
  });

  it('follows a failed payment, a pending cancel and the end', async () => {
    const s = await setup();
    const ref = `sub_${randomUUID()}`;
    const step = async (over: Parameters<typeof stripeSub>[1]) => {
      subscriptions.set(ref, stripeSub(s.orgId, over));
      await s.deliver('customer.subscription.updated', changed(ref, s.orgId));
      return s.subscription();
    };
    expect((await step({})).status).toBe('active');
    expect((await step({ status: 'past_due' })).status).toBe('past_due');
    expect((await step({ cancel: true })).cancelAtPeriodEnd).toBe(true);
    expect((await step({ status: 'canceled' })).status).toBe('cancelled');
  });

  it('the end of an old subscription does not cancel the one that replaced it', async () => {
    const s = await setup();
    const current = `sub_${randomUUID()}`;
    const old = `sub_${randomUUID()}`;
    subscriptions.set(current, stripeSub(s.orgId));
    subscriptions.set(old, stripeSub(s.orgId, { status: 'canceled' }));
    await s.deliver('customer.subscription.updated', changed(current, s.orgId));
    await s.deliver('customer.subscription.deleted', changed(old, s.orgId));
    expect(await s.subscription()).toMatchObject({
      status: 'active',
      providerSubscriptionId: current,
    });
  });

  it('a price no plan knows is refused visibly, without changing the plan', async () => {
    const s = await setup();
    const ref = `sub_${randomUUID()}`;
    subscriptions.set(ref, stripeSub(s.orgId, { price: 'price_unknown' }));
    const id = await s.ingest('customer.subscription.updated', changed(ref, s.orgId));
    expect(await s.run(id)).toBe('failed');
    expect((await s.event(id)).error).toContain('price_unknown');
    expect((await s.subscription()).status).toBe('trialing');
  });

  it('with no org in the event or on the subscription, finds it by reference', async () => {
    const s = await setup();
    const ref = `sub_${randomUUID()}`;
    subscriptions.set(ref, stripeSub(s.orgId));
    await s.deliver('customer.subscription.created', changed(ref, s.orgId));
    subscriptions.set(ref, stripeSub(undefined, { status: 'past_due' }));
    await s.deliver('customer.subscription.updated', changed(ref));
    expect((await s.subscription()).status).toBe('past_due');
  });

  it('a provider outage retries, and is marked only when out of attempts', async () => {
    const s = await setup();
    const id = await s.ingest('customer.subscription.updated', changed('sub_missing', s.orgId));
    await expect(s.run(id, false)).rejects.toThrow();
    expect((await s.event(id)).status).toBe('received');
    await expect(s.run(id, true)).rejects.toThrow();
    expect((await s.event(id)).status).toBe('failed');
  });

  const paidInvoice = (ref: string, orgId: string, id = `in_${randomUUID()}`) => ({
    id,
    currency: CURRENCY.toLowerCase(),
    amount_paid: 118000,
    parent: { subscription_details: { subscription: ref, metadata: { orgId } } },
    lines: { data: [{ period: { start: 1_800_000_000, end: 1_900_000_000 } }] },
  });

  it('a paid invoice bills once, with tax taken out of the price', async () => {
    const s = await setup({ country: 'IN' });
    const ref = `sub_${randomUUID()}`;
    subscriptions.set(ref, stripeSub(s.orgId));
    const invoice = paidInvoice(ref, s.orgId);
    await s.deliver('invoice.paid', invoice);
    await s.deliver('invoice.paid', invoice);
    const rows = await s.invoices();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'subscription',
      description: 'Starter subscription',
      subtotalMicros: 1000_000_000n,
      taxMicros: 180_000_000n,
      totalMicros: 1180_000_000n,
      periodEnd: new Date(1_900_000_000_000),
    });
    // A subscription payment never touches the wallet.
    expect(Number((await s.wallet()).balanceMicros)).toBe(0);
  });

  it('with no tax rate for the country, the whole price is the subtotal', async () => {
    const s = await setup({ country: 'DE' });
    const ref = `sub_${randomUUID()}`;
    subscriptions.set(ref, stripeSub(s.orgId));
    await s.deliver('invoice.paid', paidInvoice(ref, s.orgId));
    expect((await s.invoices())[0]).toMatchObject({
      subtotalMicros: 1180_000_000n,
      taxMicros: 0n,
      taxLabel: null,
    });
  });
});

describe('plan limits outside the API', () => {
  const onFree = async (orgId: string, contacts: number) => {
    const free = await owner.plan.findUniqueOrThrow({ where: { code: 'free' } });
    await owner.subscription.update({
      where: { orgId },
      data: { planId: free.id, status: 'active' },
    });
    await withTenant(client, { orgId }, (tx) =>
      tx.contact.createMany({
        data: Array.from({ length: contacts }, (_, i) => ({
          orgId,
          waId: String(910000000000 + i),
        })),
      }),
    );
  };

  it('an import adds up to the limit, updates anyone, and reports the rest', async () => {
    const s = await setup();
    await onFree(s.orgId, 248);
    await withTenant(client, { orgId: s.orgId }, (tx) =>
      tx.contact.create({ data: { orgId: s.orgId, waId: '919876500000' } }),
    );
    const jobId = randomUUID();
    await s.storage.put(
      contactJobKey(s.orgId, jobId, 'source'),
      Buffer.from(
        'Phone,Name\n+919876500000,Updated\n+919876543210,First new\n+919876543211,Over\n',
      ),
      'text/csv',
    );
    await withTenant(client, { orgId: s.orgId }, (tx) =>
      tx.contactJob.create({
        data: {
          id: jobId,
          orgId: s.orgId,
          kind: 'import',
          options: { columns: { phone: 'Phone', name: 'Name', fields: {} } },
        },
      }),
    );
    await processContactJob(s.deps, { orgId: s.orgId, jobId }, { finalAttempt: true });
    const job = await withTenant(client, { orgId: s.orgId }, (tx) =>
      tx.contactJob.findUniqueOrThrow({ where: { id: jobId } }),
    );
    expect(job).toMatchObject({ createdCount: 1, updatedCount: 1 });
    const report = (await s.storage.get(job.resultKey!)).toString();
    expect(report).toContain('contact limit');
    const count = await withTenant(client, { orgId: s.orgId }, (tx) =>
      tx.contact.count({ where: { orgId: s.orgId } }),
    );
    expect(count).toBe(250);
  });

  it('a customer writing in is never refused, whatever the limit', async () => {
    const s = await setup();
    const number = await connectNumber(client, s.orgId);
    await onFree(s.orgId, 250);
    await processMessagesChange(s.deps, s.orgId, {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: number.wabaId,
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '1', phone_number_id: number.phoneNumberId },
                contacts: [{ profile: { name: 'New' }, wa_id: '14155552671' }],
                messages: [
                  {
                    from: '14155552671',
                    id: `wamid.${randomUUID()}`,
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    type: 'text',
                    text: { body: 'Hello?' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    const contact = await withTenant(client, { orgId: s.orgId }, (tx) =>
      tx.contact.findUnique({ where: { orgId_waId: { orgId: s.orgId, waId: '14155552671' } } }),
    );
    expect(contact).not.toBeNull();
  });
});

describe('events with nothing to do', () => {
  it('are marked ignored, and kept', async () => {
    const s = await setup();
    const id = await s.ingest('customer.created', { id: 'cus_1' });
    expect(await s.run(id)).toBe('ignored');
    expect((await s.event(id)).status).toBe('ignored');
  });

  it('a missing event does nothing', async () => {
    const s = await setup();
    expect(await s.run(randomUUID())).toBe('missing');
  });
});
