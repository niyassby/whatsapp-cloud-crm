import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertWithinLimit,
  effectivePlan,
  recordInvoice,
  roomLeft,
  startTrial,
} from '../src/billing';
import type { DbClient } from '../src/client';
import { withTenant } from '../src/tenant';
import { appClient, createTenant, ownerClient, type TenantFixture } from './fixtures';

let owner: DbClient;
let app: DbClient;
let a: TenantFixture;
let b: TenantFixture;

const asA = <T>(fn: Parameters<typeof withTenant<T>>[2]) =>
  withTenant(app, { orgId: a.orgId, userId: a.userId }, fn);
const asB = <T>(fn: Parameters<typeof withTenant<T>>[2]) =>
  withTenant(app, { orgId: b.orgId, userId: b.userId }, fn);

const invoiceFor = (orgId: string, providerRef = randomUUID()) => ({
  orgId,
  kind: 'topup' as const,
  provider: 'stripe',
  providerRef,
  description: 'Wallet top-up',
  currency: 'INR',
  subtotalMicros: 100,
  taxMicros: 18,
  taxRateBps: 1800,
  taxLabel: 'GST',
  totalMicros: 118,
});

beforeAll(async () => {
  owner = ownerClient();
  app = appClient();
  a = await createTenant(owner);
  b = await createTenant(owner);
  await asB(async (tx) => {
    await startTrial(tx, b.orgId);
    await tx.walletTopup.create({
      data: {
        orgId: b.orgId,
        provider: 'stripe',
        providerRef: 'cs_theirs',
        currency: 'INR',
        creditMicros: 1n,
        taxMicros: 0n,
        taxRateBps: 0,
        totalMicros: 1n,
      },
    });
    await recordInvoice(tx, invoiceFor(b.orgId));
  });
});

afterAll(async () => {
  await app.$disconnect();
  await owner.$disconnect();
});

describe('tenant isolation', () => {
  it('another org sees none of it', async () => {
    const seen = await asA(async (tx) => ({
      subscriptions: await tx.subscription.count({ where: { orgId: b.orgId } }),
      topups: await tx.walletTopup.count(),
      invoices: await tx.invoice.count(),
      events: await tx.billingEvent.count(),
    }));
    expect(seen).toEqual({ subscriptions: 0, topups: 0, invoices: 0, events: 0 });
  });

  it('another org cannot change it or write into it', async () => {
    const changed = await asA((tx) =>
      tx.subscription.updateMany({ where: { orgId: b.orgId }, data: { status: 'active' } }),
    );
    expect(changed.count).toBe(0);
    await expect(asA((tx) => recordInvoice(tx, invoiceFor(b.orgId)))).rejects.toThrow();
  });
});

describe('what the app role may not do', () => {
  it('cannot change plans, prices or tax rates', async () => {
    await expect(asA((tx) => tx.plan.updateMany({ data: { name: 'x' } }))).rejects.toThrow();
    await expect(
      asA((tx) => tx.taxRate.create({ data: { country: 'ZZ', rateBps: 1, label: 'x' } })),
    ).rejects.toThrow();
    expect(await asA((tx) => tx.plan.count())).toBeGreaterThan(0);
  });

  it('cannot change or delete an invoice, even its own', async () => {
    await expect(
      asB((tx) => tx.invoice.updateMany({ data: { totalMicros: 1n } })),
    ).rejects.toThrow();
    await expect(asB((tx) => tx.invoice.deleteMany())).rejects.toThrow();
  });

  it('cannot delete a subscription or top-up', async () => {
    await expect(asB((tx) => tx.subscription.deleteMany())).rejects.toThrow();
    await expect(asB((tx) => tx.walletTopup.deleteMany())).rejects.toThrow();
  });

  it('cannot write provider events directly, or read the invoice counter', async () => {
    await expect(
      asA((tx) =>
        tx.billingEvent.create({
          data: { provider: 'stripe', eventId: 'x', type: 'x', payload: {} },
        }),
      ),
    ).rejects.toThrow();
    await expect(app.$queryRaw`SELECT value FROM invoice_counter`).rejects.toThrow();
  });
});

describe('definer functions', () => {
  it('an event stores once, and a redelivery finds the same row', async () => {
    const eventId = `evt_${randomUUID()}`;
    const ingest = () =>
      app.$queryRaw<{ id: string; status: string }[]>`
        SELECT id, status::text AS status
        FROM billing_event_ingest('stripe', ${eventId}, 'x', '{"a":1}'::jsonb)`;
    const [first] = await ingest();
    const [second] = await ingest();
    expect(second?.id).toBe(first?.id);
    expect(first?.status).toBe('received');
  });

  it('the same event id from another provider is a different event', async () => {
    const eventId = `evt_${randomUUID()}`;
    const ingest = (provider: string) =>
      app.$queryRaw<{ id: string }[]>`
        SELECT id FROM billing_event_ingest(${provider}, ${eventId}, 'x', '{}'::jsonb)`;
    const [s] = await ingest('stripe');
    const [r] = await ingest('razorpay');
    expect(s?.id).not.toBe(r?.id);
  });

  it('finding an org by reference answers only the id, and only for a match', async () => {
    const find = (ref: string) =>
      app.$queryRaw<{ org: string | null }[]>`
        SELECT billing_org_for_ref('stripe', ${ref}) AS org`;
    expect((await find('cs_theirs'))[0]?.org).toBe(b.orgId);
    expect((await find('cs_nobody'))[0]?.org).toBeNull();
  });

  it('a rolled-back invoice gives its number back, so the sequence has no gaps', async () => {
    const number = async () => {
      const made = await asB((tx) => recordInvoice(tx, invoiceFor(b.orgId)));
      return Number(made.invoice.number.split('-')[2]);
    };
    const first = await number();
    await expect(
      asB(async (tx) => {
        await recordInvoice(tx, invoiceFor(b.orgId));
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(await number()).toBe(first + 1);
  });

  it('one payment has one invoice', async () => {
    const ref = randomUUID();
    const one = await asB((tx) => recordInvoice(tx, invoiceFor(b.orgId, ref)));
    const two = await asB((tx) => recordInvoice(tx, invoiceFor(b.orgId, ref)));
    expect(one.created).toBe(true);
    expect(two.created).toBe(false);
    expect(two.invoice.id).toBe(one.invoice.id);
  });
});

describe('plans and limits', () => {
  it('a trial gets the trial plan, and ending it falls back to Free', async () => {
    const t = await createTenant(owner);
    const scope = { orgId: t.orgId, userId: t.userId };
    await withTenant(app, scope, (tx) => startTrial(tx, t.orgId));
    const during = await withTenant(app, scope, (tx) => effectivePlan(tx, t.orgId));
    expect(during).toMatchObject({ status: 'trialing', plan: { code: 'growth' } });

    const after = await withTenant(app, scope, (tx) =>
      effectivePlan(tx, t.orgId, new Date(Date.now() + 15 * 86_400_000)),
    );
    expect(after).toMatchObject({
      status: 'expired',
      plan: { code: 'free' },
      subscribedPlan: { code: 'growth' },
    });
  });

  it('starting a trial twice does not extend it', async () => {
    const t = await createTenant(owner);
    const scope = { orgId: t.orgId, userId: t.userId };
    await withTenant(app, scope, (tx) => startTrial(tx, t.orgId));
    const first = await withTenant(app, scope, (tx) => effectivePlan(tx, t.orgId));
    await withTenant(app, scope, (tx) =>
      startTrial(tx, t.orgId, new Date(Date.now() + 365 * 86_400_000)),
    );
    const second = await withTenant(app, scope, (tx) => effectivePlan(tx, t.orgId));
    expect(second?.subscription.trialEndsAt).toEqual(first?.subscription.trialEndsAt);
  });

  it('limits count what exists, and refuse only what would pass them', async () => {
    const t = await createTenant(owner);
    const scope = { orgId: t.orgId, userId: t.userId };
    const free = await owner.plan.findUniqueOrThrow({ where: { code: 'free' } });
    await owner.subscription.create({
      data: { orgId: t.orgId, planId: free.id, status: 'active' },
    });
    await withTenant(app, scope, async (tx) => {
      await tx.contact.createMany({
        data: Array.from({ length: 249 }, (_, i) => ({
          orgId: t.orgId,
          waId: String(910000000000 + i),
        })),
      });
    });
    expect(await withTenant(app, scope, (tx) => roomLeft(tx, t.orgId, 'contacts'))).toBe(1);
    await withTenant(app, scope, (tx) => assertWithinLimit(tx, t.orgId, 'contacts'));
    await expect(
      withTenant(app, scope, (tx) => assertWithinLimit(tx, t.orgId, 'contacts', 2)),
    ).rejects.toMatchObject({ code: 'PLAN_LIMIT_REACHED' });
  });

  it('with no subscription row, limits do not apply', async () => {
    const t = await createTenant(owner);
    const scope = { orgId: t.orgId, userId: t.userId };
    expect(await withTenant(app, scope, (tx) => roomLeft(tx, t.orgId, 'contacts'))).toBeNull();
  });
});
