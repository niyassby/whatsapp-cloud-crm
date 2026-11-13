/**
 * Reseller tables (Phase 4.1): who can see and change what, and how a month closes. Every
 * assertion about access runs on the app-role connection, as production does.
 */
import { randomUUID } from 'node:crypto';
import { periodOf } from '@wacrm/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DbClient } from '../src/client';
import { effectiveLimits } from '../src/billing';
import {
  closeDuePartnerMonths,
  closePartnerMonth,
  PARTNER_PROVIDER,
  partnerTotals,
  setPartnerManagedPlan,
} from '../src/partners';
import { withDbContext, withTenant } from '../src/tenant';
import { chargeMessage, creditWallet, ensureWallet, findRate, refundDebit } from '../src/wallet';
import {
  appClient,
  createPartner,
  createTenant,
  ownerClient,
  type TenantFixture,
} from './fixtures';

const CURRENCY = 'XRT';

let owner: DbClient;
let app: DbClient;
let p1: string;
let p2: string;
/** a and a2 are clients of p1, b of p2, and solo has no partner. */
let a: TenantFixture;
let a2: TenantFixture;
let b: TenantFixture;
let solo: TenantFixture;
let adminUserId: string;
let growthId: string;

const asPartner = <T>(partnerId: string, fn: Parameters<typeof withDbContext<T>>[2]) =>
  withDbContext(app, { partnerId }, fn);
const asOrg = <T>(t: TenantFixture, fn: Parameters<typeof withTenant<T>>[2]) =>
  withTenant(app, { orgId: t.orgId, userId: t.userId }, fn);
const asAdmin = <T>(fn: Parameters<typeof withDbContext<T>>[2]) =>
  withDbContext(app, { userId: adminUserId, platformAdmin: true }, fn);

const charge = (t: TenantFixture, messageId = randomUUID()) =>
  asOrg(t, (tx) =>
    chargeMessage(tx, {
      orgId: t.orgId,
      messageId,
      category: 'marketing',
      country: 'IN',
      windowOpen: false,
      defaults: { currency: CURRENCY, thresholdMicros: null },
    }),
  );

beforeAll(async () => {
  owner = ownerClient();
  app = appClient();
  p1 = await createPartner(owner);
  p2 = await createPartner(owner);
  await owner.partner.update({
    where: { id: p1 },
    data: { currency: CURRENCY, walletMarkupBps: 1500 },
  });
  await owner.partner.update({ where: { id: p2 }, data: { currency: CURRENCY } });
  a = await createTenant(owner, { partnerId: p1 });
  a2 = await createTenant(owner, { partnerId: p1 });
  b = await createTenant(owner, { partnerId: p2 });
  solo = await createTenant(owner);

  const adminTenant = await createTenant(owner);
  adminUserId = adminTenant.userId;
  await owner.platformAdmin.create({ data: { userId: adminUserId } });

  growthId = (await owner.plan.findUniqueOrThrow({ where: { code: 'growth' } })).id;
  await owner.wholesalePlanPrice.create({
    data: { planId: growthId, currency: CURRENCY, amountMicros: 40_000_000n },
  });
  await owner.rateCard.createMany({
    data: [
      {
        country: 'IN',
        category: 'marketing',
        currency: CURRENCY,
        // An awkward price, so the markup has something to round.
        rateMicros: 333_333n,
        validFrom: new Date('2026-01-01'),
      },
    ],
    skipDuplicates: true,
  });
  for (const t of [a, a2, b, solo]) {
    await withTenant(owner, { orgId: t.orgId }, async (tx) => {
      await ensureWallet(tx, t.orgId, CURRENCY);
      await creditWallet(tx, { orgId: t.orgId, amountMicros: 50_000_000, idempotencyKey: 'seed' });
    });
  }
  await owner.partnerClient.create({
    data: { orgId: a.orgId, partnerId: p1, limitSeats: 4, clientPriceMicros: 65_000_000n },
  });
  await owner.partnerClient.create({ data: { orgId: b.orgId, partnerId: p2 } });
  for (const t of [a, a2, b]) {
    await withTenant(owner, { orgId: t.orgId }, (tx) =>
      setPartnerManagedPlan(tx, t.orgId, growthId),
    );
  }
});

afterAll(async () => {
  await app.$disconnect();
  await owner.$disconnect();
});

describe('without a context', () => {
  it('sees nothing in any reseller table', async () => {
    const counts = await withDbContext(app, {}, async (tx) => [
      await tx.partnerMember.count(),
      await tx.partnerClient.count(),
      await tx.partnerLedger.count(),
      await tx.partnerStatement.count(),
      await tx.impersonationSession.count(),
      await tx.platformAuditLog.count(),
      await tx.platformAdmin.count(),
      await tx.partner.count(),
    ]);
    expect(counts).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });
});

describe('a partner', () => {
  it('sees its own clients and nobody else', async () => {
    const orgs = await asPartner(p1, (tx) => tx.organization.findMany({ select: { id: true } }));
    expect(orgs.map((o) => o.id).sort()).toEqual([a.orgId, a2.orgId].sort());
    const caps = await asPartner(p1, (tx) => tx.partnerClient.findMany());
    expect(caps.map((c) => c.orgId)).toEqual([a.orgId]);
  });

  it('reads a client’s balance and plan, but cannot change either or see inside', async () => {
    const seen = await asPartner(p1, async (tx) => ({
      wallets: (await tx.wallet.findMany({ select: { orgId: true } })).map((w) => w.orgId).sort(),
      subscriptions: await tx.subscription.count(),
      // Tenant tables stay closed to a partner context: it has no org.
      ledger: await tx.walletLedger.count(),
      memberships: await tx.membership.count(),
      audit: await tx.auditLog.count(),
      keys: await tx.apiKey.count(),
    }));
    expect(seen).toEqual({
      wallets: [a.orgId, a2.orgId].sort(),
      subscriptions: 2,
      ledger: 0,
      memberships: 0,
      audit: 0,
      keys: 0,
    });
    const changed = await asPartner(p1, async (tx) => ({
      wallet: await tx.wallet.updateMany({ data: { balanceMicros: 1n } }),
      subscription: await tx.subscription.updateMany({ data: { status: 'cancelled' } }),
    }));
    expect(changed).toEqual({ wallet: { count: 0 }, subscription: { count: 0 } });
  });

  it('changes its own clients only', async () => {
    const mine = await asPartner(p1, (tx) =>
      tx.organization.updateMany({ where: { id: a2.orgId }, data: { status: 'suspended' } }),
    );
    const theirs = await asPartner(p1, (tx) =>
      tx.organization.updateMany({
        where: { id: { in: [b.orgId, solo.orgId] } },
        data: { status: 'suspended' },
      }),
    );
    expect([mine.count, theirs.count]).toEqual([1, 0]);
    await asPartner(p1, (tx) =>
      tx.organization.updateMany({ where: { id: a2.orgId }, data: { status: 'active' } }),
    );
  });

  it('cannot hand one of its clients to another partner', async () => {
    await expect(
      asPartner(p1, (tx) =>
        tx.organization.updateMany({ where: { id: a2.orgId }, data: { partnerId: p2 } }),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('cannot create a workspace under another partner', async () => {
    const orgId = randomUUID();
    await expect(
      withTenant(app, { orgId, partnerId: p1 }, (tx) =>
        tx.organization.create({
          data: { id: orgId, name: 'Planted', slug: `planted-${orgId}`, partnerId: p2 },
        }),
      ),
    ).rejects.toThrow(/row-level security/);
    // Nor can an ordinary signup attach itself to a partner.
    const other = randomUUID();
    await expect(
      withTenant(app, { orgId: other }, (tx) =>
        tx.organization.create({
          data: { id: other, name: 'Planted', slug: `planted-${other}`, partnerId: p1 },
        }),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('changes its own row, not another partner’s', async () => {
    const res = await asPartner(p1, (tx) =>
      tx.partner.updateMany({ where: { id: { in: [p1, p2] } }, data: { walletMarkupBps: 1500 } }),
    );
    expect(res.count).toBe(1);
    await expect(
      asPartner(p1, (tx) =>
        tx.partner.updateMany({ where: { id: p1 }, data: { walletMarkupBps: 20_001 } }),
      ),
    ).rejects.toThrow(/partners_markup_range/);
  });

  it('cannot add its own staff or record its own payment', async () => {
    await expect(
      asPartner(p1, (tx) =>
        tx.partnerMember.createMany({ data: [{ partnerId: p1, userId: solo.userId }] }),
      ),
    ).rejects.toThrow(/row-level security/);
  });
});

describe('a client workspace', () => {
  it('reads its own limits and cannot change them', async () => {
    const mine = await asOrg(a, (tx) => tx.partnerClient.findMany());
    expect(mine.map((c) => c.orgId)).toEqual([a.orgId]);
    const changed = await asOrg(a, (tx) =>
      tx.partnerClient.updateMany({ data: { limitSeats: 9999 } }),
    );
    expect(changed.count).toBe(0);
    await expect(
      asOrg(a2, (tx) =>
        tx.partnerClient.createMany({ data: [{ orgId: a2.orgId, partnerId: p1 }] }),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('has the plan’s limits lowered by the partner’s caps', async () => {
    // Growth: 10 seats, 3 numbers, 25,000 contacts. The partner capped seats at 4.
    expect(await asOrg(a, (tx) => effectiveLimits(tx, a.orgId))).toEqual({
      seats: 4,
      numbers: 3,
      contacts: 25_000,
    });
    expect(await asOrg(a2, (tx) => effectiveLimits(tx, a2.orgId))).toEqual({
      seats: 10,
      numbers: 3,
      contacts: 25_000,
    });
  });

  it('is priced with its partner’s markup, rounded up', async () => {
    const quote = await asOrg(a, (tx) =>
      findRate(tx, { currency: CURRENCY, category: 'marketing', country: 'IN' }),
    );
    // 333,333 x 1.15 = 383,332.95
    expect(quote).toMatchObject({ wholesaleMicros: 333_333, rateMicros: 383_333, partnerId: p1 });
    const plain = await asOrg(solo, (tx) =>
      findRate(tx, { currency: CURRENCY, category: 'marketing', country: 'IN' }),
    );
    expect(plain).toMatchObject({ wholesaleMicros: 333_333, rateMicros: 333_333, partnerId: null });
  });

  it('writes its partner’s ledger when charged, and can never read it', async () => {
    const messageId = randomUUID();
    await charge(a, messageId);
    await charge(a, messageId); // idempotent
    expect(await asOrg(a, (tx) => tx.partnerLedger.count())).toBe(0);

    const rows = await asPartner(p1, (tx) =>
      tx.partnerLedger.findMany({ where: { orgId: a.orgId } }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: 'usage',
      wholesaleMicros: 333_333n,
      retailMicros: 383_333n,
      commissionMicros: 50_000n,
      period: periodOf(new Date()),
    });

    await asOrg(a, (tx) =>
      refundDebit(tx, { orgId: a.orgId, debitKey: `debit:message:${messageId}` }),
    );
    const totals = await asPartner(p1, (tx) =>
      partnerTotals(tx, { partnerId: p1, period: periodOf(new Date()), currency: CURRENCY }),
    );
    expect(totals).toMatchObject({
      usageWholesaleMicros: 0,
      commissionMicros: 0,
      totalDueMicros: 0,
    });
  });

  it('cannot write a ledger entry for another partner or another workspace', async () => {
    const row = {
      type: 'usage',
      currency: CURRENCY,
      wholesaleMicros: -5_000_000n,
      retailMicros: -5_000_000n,
      commissionMicros: 0n,
      period: periodOf(new Date()),
      idempotencyKey: randomUUID(),
    };
    await expect(
      asOrg(a, (tx) =>
        tx.partnerLedger.createMany({ data: [{ ...row, partnerId: p2, orgId: a.orgId }] }),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      asOrg(a, (tx) =>
        tx.partnerLedger.createMany({ data: [{ ...row, partnerId: p1, orgId: a2.orgId }] }),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      asOrg(solo, (tx) =>
        tx.partnerLedger.createMany({ data: [{ ...row, partnerId: p1, orgId: solo.orgId }] }),
      ),
    ).rejects.toThrow(/row-level security/);
  });
});

describe('append-only and read-only tables', () => {
  it('lets nobody rewrite the partner ledger or the platform audit log', async () => {
    await charge(a2);
    await expect(
      asPartner(p1, (tx) => tx.partnerLedger.updateMany({ data: { wholesaleMicros: 0n } })),
    ).rejects.toThrow(/permission denied/);
    await expect(asPartner(p1, (tx) => tx.partnerLedger.deleteMany())).rejects.toThrow(
      /permission denied/,
    );
    await expect(asAdmin((tx) => tx.platformAuditLog.deleteMany())).rejects.toThrow(
      /permission denied/,
    );
  });

  it('lets the app role read platform_admins but never write it', async () => {
    await expect(
      withDbContext(
        app,
        { userId: solo.userId },
        (tx) => tx.$executeRaw`INSERT INTO platform_admins (user_id) VALUES (${solo.userId}::uuid)`,
      ),
    ).rejects.toThrow(/permission denied/);
    const own = await withDbContext(app, { userId: adminUserId }, (tx) => tx.platformAdmin.count());
    const others = await withDbContext(app, { userId: solo.userId }, (tx) =>
      tx.platformAdmin.count(),
    );
    expect([own, others]).toEqual([1, 0]);
  });
});

describe('platform admin context', () => {
  it('needs both the flag and a platform_admins row', async () => {
    const real = await asAdmin((tx) => tx.partner.count());
    expect(real).toBeGreaterThanOrEqual(2);
    // The flag without the row.
    const flagOnly = await withDbContext(app, { userId: solo.userId, platformAdmin: true }, (tx) =>
      tx.partner.count(),
    );
    // The row without the flag: an admin in their own workspace is an ordinary member.
    const rowOnly = await withDbContext(app, { userId: adminUserId }, (tx) => tx.partner.count());
    // The flag with no user at all.
    const nobody = await withDbContext(app, { platformAdmin: true }, (tx) => tx.partner.count());
    expect([flagOnly, rowOnly, nobody]).toEqual([0, 0, 0]);
  });

  it('sees every workspace, but tenant data only by naming the workspace', async () => {
    const seen = await asAdmin(async (tx) => ({
      orgs: await tx.organization.count({
        where: { id: { in: [a.orgId, b.orgId, solo.orgId] } },
      }),
      memberships: await tx.membership.count({ where: { orgId: { in: [a.orgId, b.orgId] } } }),
      keys: await tx.apiKey.count(),
    }));
    expect(seen).toEqual({ orgs: 3, memberships: 0, keys: 0 });
  });

  it('is the only one who edits plans, wholesale prices and rate cards', async () => {
    const before = await owner.plan.findUniqueOrThrow({ where: { code: 'scale' } });
    for (const ctx of [{ partnerId: p1 }, { orgId: a.orgId, userId: a.userId }]) {
      const res = await withDbContext(app, ctx, (tx) =>
        tx.plan.updateMany({ where: { code: 'scale' }, data: { seats: 1 } }),
      );
      expect(res.count).toBe(0);
      await expect(
        withDbContext(app, ctx, (tx) =>
          tx.rateCard.createMany({
            data: [
              {
                country: 'ZZ',
                category: 'marketing',
                currency: CURRENCY,
                rateMicros: 1n,
                validFrom: new Date(),
              },
            ],
          }),
        ),
      ).rejects.toThrow(/row-level security/);
      await expect(
        withDbContext(app, ctx, (tx) =>
          tx.wholesalePlanPrice.updateMany({ data: { amountMicros: 0n } }),
        ),
      ).resolves.toEqual({ count: 0 });
    }
    // Even an admin cannot touch what the panel does not edit: provider prices, trial flags.
    await expect(
      asAdmin((tx) => tx.plan.updateMany({ where: { code: 'scale' }, data: { isTrial: true } })),
    ).rejects.toThrow(/permission denied/);
    expect(await owner.plan.findUniqueOrThrow({ where: { code: 'scale' } })).toEqual(before);
  });

  it('sees a partner’s staff by name, as the partner does, and nobody else does', async () => {
    await asAdmin((tx) =>
      tx.partnerMember.createMany({ data: [{ partnerId: p1, userId: solo.userId }] }),
    );
    const names = (ctx: Parameters<typeof withDbContext>[1]) =>
      withDbContext(app, ctx, (tx) =>
        tx.partnerMember.findMany({ select: { user: { select: { id: true } } } }),
      );
    expect(await names({ userId: adminUserId, platformAdmin: true })).toEqual([
      { user: { id: solo.userId } },
    ]);
    expect(await names({ partnerId: p1 })).toEqual([{ user: { id: solo.userId } }]);
    expect(await names({ partnerId: p2 })).toEqual([]);
    // A person works for one partner.
    await expect(
      asAdmin((tx) =>
        tx.partnerMember.createMany({ data: [{ partnerId: p2, userId: solo.userId }] }),
      ),
    ).rejects.toThrow(/Unique constraint/);
  });
});

describe('impersonation sessions', () => {
  it('are written by the person, in the workspace, and seen by that workspace', async () => {
    const expiresAt = new Date(Date.now() + 60_000);
    const ctx = { orgId: a.orgId, userId: solo.userId, partnerId: p1 };
    const session = await withTenant(app, ctx, (tx) =>
      tx.impersonationSession.create({
        data: { orgId: a.orgId, userId: solo.userId, partnerId: p1, reason: 'test', expiresAt },
      }),
    );
    // Not in someone else's name, and not in a workspace other than the current one.
    await expect(
      withTenant(app, ctx, (tx) =>
        tx.impersonationSession.createMany({
          data: [{ orgId: a.orgId, userId: a.userId, reason: 'forged', expiresAt }],
        }),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      withTenant(app, ctx, (tx) =>
        tx.impersonationSession.createMany({
          data: [{ orgId: b.orgId, userId: solo.userId, reason: 'elsewhere', expiresAt }],
        }),
      ),
    ).rejects.toThrow(/row-level security/);

    expect(await asOrg(a, (tx) => tx.impersonationSession.count())).toBe(1);
    expect(await asOrg(b, (tx) => tx.impersonationSession.count())).toBe(0);
    expect(await asPartner(p2, (tx) => tx.impersonationSession.count())).toBe(0);
    // The workspace can see it, but only the person can end it.
    const byOrg = await asOrg(a, (tx) =>
      tx.impersonationSession.updateMany({ data: { endedAt: new Date() } }),
    );
    const byPerson = await withDbContext(app, { userId: solo.userId }, (tx) =>
      tx.impersonationSession.updateMany({
        where: { id: session.id },
        data: { endedAt: new Date() },
      }),
    );
    expect([byOrg.count, byPerson.count]).toEqual([0, 1]);
  });
});

describe('closing a month', () => {
  // The fixtures and charges above all fall in the current month; close it from next month.
  const period = periodOf(new Date());
  const nextMonth = new Date(
    Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 2),
  );

  it('refuses a month that is still running', async () => {
    await expect(closePartnerMonth(app, p1, period)).rejects.toThrow(/finished month/);
  });

  it('adds each client’s plan fee to the usage, once', async () => {
    const first = await closePartnerMonth(app, p1, period, nextMonth);
    expect(first.created).toBe(true);
    expect(first.statement).toMatchObject({
      period,
      currency: CURRENCY,
      status: 'issued',
      // One charge by a2 is still standing; a's was refunded.
      usageWholesaleMicros: 333_333,
      usageRetailMicros: 383_333,
      // Two clients on Growth at 40 wholesale. Client a pays the partner 65; a2 has no price
      // set, so it counts at wholesale and earns nothing.
      planFeesWholesaleMicros: 80_000_000,
      planFeesRetailMicros: 105_000_000,
      commissionMicros: 25_050_000,
      totalDueMicros: 80_333_333,
    });

    const again = await closePartnerMonth(app, p1, period, nextMonth);
    expect(again.created).toBe(false);
    expect(again.statement?.id).toBe(first.statement?.id);
    const fees = await asPartner(p1, (tx) =>
      tx.partnerLedger.count({ where: { type: 'plan_fee', period } }),
    );
    expect(fees).toBe(2);
  });

  it('closes every partner from the daily job, and issues nothing for an empty month', async () => {
    const result = await closeDuePartnerMonths(app, nextMonth);
    expect(result.failed).toEqual([]);
    // p1 is already closed; p2 has one client on a plan, so it gets a statement now.
    const theirs = await asPartner(p2, (tx) => tx.partnerStatement.findMany());
    expect(theirs).toHaveLength(1);
    expect(theirs[0]).toMatchObject({ period, totalDueMicros: 40_000_000n, commissionMicros: 0n });

    const idle = await createPartner(owner);
    expect(await closePartnerMonth(app, idle, period, nextMonth)).toEqual({
      created: false,
      statement: null,
    });
  });

  it('skips a client that pays for itself or was deleted before the month', async () => {
    const p3 = await createPartner(owner);
    await owner.partner.update({ where: { id: p3 }, data: { currency: CURRENCY } });
    const own = await createTenant(owner, { partnerId: p3 });
    const gone = await createTenant(owner, { partnerId: p3 });
    await withTenant(owner, { orgId: own.orgId }, (tx) =>
      tx.subscription.create({
        data: { orgId: own.orgId, planId: growthId, status: 'active', provider: 'stripe' },
      }),
    );
    await withTenant(owner, { orgId: gone.orgId }, (tx) =>
      setPartnerManagedPlan(tx, gone.orgId, growthId),
    );
    await owner.organization.update({
      where: { id: gone.orgId },
      data: { deletedAt: new Date('2020-01-01') },
    });
    expect((await closePartnerMonth(app, p3, period, nextMonth)).statement).toBeNull();
    expect(PARTNER_PROVIDER).toBe('partner');
  });

  it('lets only a platform admin record the payment', async () => {
    const paid = { status: 'paid', paidAt: new Date(), paymentReference: 'UTR123' };
    const byPartner = await asPartner(p1, (tx) => tx.partnerStatement.updateMany({ data: paid }));
    const byAdmin = await asAdmin((tx) =>
      tx.partnerStatement.updateMany({ where: { partnerId: p1 }, data: paid }),
    );
    expect([byPartner.count, byAdmin.count]).toEqual([0, 1]);
    // One partner never sees another's statement.
    const seen = await asPartner(p2, (tx) => tx.partnerStatement.findMany());
    expect(seen.every((s) => s.partnerId === p2)).toBe(true);
  });
});
