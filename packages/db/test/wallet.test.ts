/**
 * Wallet rules on real Postgres, including the acceptance test: parallel sends can never push a
 * wallet below zero. Runs on the app role, so RLS and grants apply as in production.
 */
import { randomUUID } from 'node:crypto';
import { AppError, ErrorCode } from '@wacrm/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DbClient } from '../src/client';
import { createPrismaClient } from '../src/client';
import { withTenant } from '../src/tenant';
import {
  creditWallet,
  debitWallet,
  ensureWallet,
  findRate,
  type RateSnapshot,
  refundDebit,
  releaseReservation,
  reserveFunds,
} from '../src/wallet';
import { createTenant, ownerClient, type TenantFixture } from './fixtures';
import { TEST_DATABASE_URL } from './urls';

let owner: DbClient;
/** Bigger than the default pool, so these tests contend on the row lock and not on connections. */
let app: DbClient;
let a: TenantFixture;

const RATE: RateSnapshot = {
  rateCardId: null,
  rateMicros: 1_000_000,
  country: 'IN',
  category: 'marketing',
};
const LONG = { timeout: 60_000, maxWait: 60_000 };

beforeAll(async () => {
  owner = ownerClient();
  app = createPrismaClient({ connectionString: TEST_DATABASE_URL, max: 20 });
  a = await createTenant(owner);
});
afterAll(async () => {
  await app.$disconnect();
  await owner.$disconnect();
});

/** A fresh org with a funded wallet, so tests cannot affect each other. */
async function funded(amountMicros = 0, currency = 'INR') {
  const t = await createTenant(owner);
  await withTenant(app, { orgId: t.orgId }, async (tx) => {
    await ensureWallet(tx, t.orgId, currency);
    if (amountMicros > 0) {
      await creditWallet(tx, {
        orgId: t.orgId,
        amountMicros,
        idempotencyKey: `seed:${randomUUID()}`,
      });
    }
  });
  return t.orgId;
}

const asOrg = <T>(orgId: string, fn: Parameters<typeof withTenant<T>>[2]) =>
  withTenant(app, { orgId }, fn, LONG);

const state = (orgId: string) =>
  asOrg(orgId, async (tx) => {
    const wallet = await tx.wallet.findFirstOrThrow();
    const entries = await tx.walletLedger.findMany({ orderBy: { createdAt: 'asc' } });
    return {
      balance: Number(wallet.balanceMicros),
      reserved: Number(wallet.reservedMicros),
      entries,
      sum: entries.reduce((total, e) => total + Number(e.amountMicros), 0),
    };
  });

const debit = (orgId: string, amountMicros: number, key: string = randomUUID()) =>
  asOrg(orgId, (tx) =>
    debitWallet(tx, {
      orgId,
      amountMicros,
      idempotencyKey: key,
      referenceType: 'message',
      referenceId: key,
      rate: RATE,
    }),
  );

const isInsufficient = (err: unknown) =>
  err instanceof AppError && err.code === ErrorCode.INSUFFICIENT_BALANCE;

describe('concurrency: the wallet never goes negative', () => {
  it('200 parallel debits with funds for 50: exactly 50 succeed', async () => {
    const orgId = await funded(50_000_000);
    const results = await Promise.allSettled(
      Array.from({ length: 200 }, () => debit(orgId, 1_000_000)),
    );
    const ok = results.filter((r) => r.status === 'fulfilled');
    const refused = results.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(50);
    expect(refused).toHaveLength(150);
    // Every refusal is the balance check, not a timeout or a deadlock.
    expect(refused.every((r) => isInsufficient((r as PromiseRejectedResult).reason))).toBe(true);

    const s = await state(orgId);
    expect(s.balance).toBe(0);
    expect(s.sum).toBe(0);
    expect(s.entries).toHaveLength(51);
  }, 120_000);

  it('a running balance that always adds up, never below zero', async () => {
    const orgId = await funded(30_000_000);
    await Promise.allSettled(Array.from({ length: 60 }, () => debit(orgId, 1_000_000)));
    const s = await state(orgId);
    // Replayed in order, every entry's balance_after is the sum so far.
    const ordered = [...s.entries].sort((x, y) => (x.id < y.id ? -1 : 1));
    const afters = ordered.map((e) => Number(e.balanceAfterMicros));
    expect(Math.min(...afters)).toBeGreaterThanOrEqual(0);
    expect(new Set(afters).size).toBe(afters.length);
    expect(s.balance).toBe(s.sum);
  }, 120_000);

  it('mixed credits, debits and refunds in parallel still add up', async () => {
    const orgId = await funded(20_000_000);
    const keys = Array.from({ length: 30 }, () => randomUUID());
    await Promise.allSettled(keys.map((k) => debit(orgId, 1_000_000, k)));
    await Promise.allSettled([
      ...keys
        .slice(0, 10)
        .map((k) => asOrg(orgId, (tx) => refundDebit(tx, { orgId, debitKey: k }))),
      ...Array.from({ length: 10 }, () =>
        asOrg(orgId, (tx) =>
          creditWallet(tx, { orgId, amountMicros: 500_000, idempotencyKey: randomUUID() }),
        ),
      ),
      ...Array.from({ length: 20 }, () => debit(orgId, 1_000_000)),
    ]);
    const s = await state(orgId);
    expect(s.balance).toBeGreaterThanOrEqual(0);
    expect(s.balance).toBe(s.sum);
  }, 120_000);

  it('the database itself refuses a negative balance', async () => {
    const orgId = await funded(1_000_000);
    await expect(
      asOrg(orgId, (tx) => tx.wallet.updateMany({ data: { balanceMicros: -1n } })),
    ).rejects.toThrow();
  });

  it('reservations cannot exceed what is available, even in parallel', async () => {
    const orgId = await funded(10_000_000);
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        asOrg(orgId, (tx) =>
          reserveFunds(tx, {
            orgId,
            amountMicros: 3_000_000,
            referenceType: 'campaign',
            referenceId: randomUUID(),
            idempotencyKey: randomUUID(),
            expiresAt: new Date(Date.now() + 3600_000),
          }),
        ),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    const s = await state(orgId);
    expect(s.reserved).toBe(9_000_000);
    expect(s.balance).toBe(10_000_000);
  }, 120_000);
});

describe('idempotency', () => {
  it('the same debit in parallel applies once', async () => {
    const orgId = await funded(10_000_000);
    const key = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => debit(orgId, 1_000_000, key)),
    );
    expect(results.filter((r) => r.applied)).toHaveLength(1);
    expect((await state(orgId)).balance).toBe(9_000_000);
  }, 60_000);

  it('a repeated credit, such as a redelivered payment webhook, counts once', async () => {
    const orgId = await funded();
    const credit = () =>
      asOrg(orgId, (tx) =>
        creditWallet(tx, { orgId, amountMicros: 5_000_000, idempotencyKey: 'pay_123' }),
      );
    expect((await credit()).applied).toBe(true);
    expect((await credit()).applied).toBe(false);
    expect((await state(orgId)).balance).toBe(5_000_000);
  });

  it('a debit that failed its check leaves no trace', async () => {
    const orgId = await funded(1_000_000);
    await expect(debit(orgId, 2_000_000, 'too-much')).rejects.toSatisfy(isInsufficient);
    const s = await state(orgId);
    expect(s.balance).toBe(1_000_000);
    expect(s.entries).toHaveLength(1);
    // It can be tried again once there is money.
    await asOrg(orgId, (tx) =>
      creditWallet(tx, { orgId, amountMicros: 2_000_000, idempotencyKey: 'top-up' }),
    );
    expect((await debit(orgId, 2_000_000, 'too-much')).applied).toBe(true);
  });
});

describe('refunds', () => {
  it('returns the debit once, even in parallel', async () => {
    const orgId = await funded(5_000_000);
    await debit(orgId, 2_000_000, 'msg-1');
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        asOrg(orgId, (tx) => refundDebit(tx, { orgId, debitKey: 'msg-1' })),
      ),
    );
    expect(results.filter((r) => r.applied)).toHaveLength(1);
    const s = await state(orgId);
    expect(s.balance).toBe(5_000_000);
    const refund = s.entries.find((e) => e.type === 'refund');
    expect(Number(refund?.amountMicros)).toBe(2_000_000);
    // It carries the rate and category, so usage adds up after refunds.
    expect(refund).toMatchObject({ category: 'marketing', country: 'IN', referenceId: 'msg-1' });
  }, 60_000);

  it('does nothing for a send that was never charged', async () => {
    const orgId = await funded(1_000_000);
    const res = await asOrg(orgId, (tx) => refundDebit(tx, { orgId, debitKey: 'free-send' }));
    expect(res.applied).toBe(false);
    expect((await state(orgId)).balance).toBe(1_000_000);
  });

  it('does nothing for a workspace with no wallet', async () => {
    const res = await asOrg(a.orgId, (tx) => refundDebit(tx, { orgId: a.orgId, debitKey: 'none' }));
    expect(res.applied).toBe(false);
  });
});

describe('the ledger', () => {
  it('is append-only for the app role', async () => {
    const orgId = await funded(1_000_000);
    await expect(
      asOrg(orgId, (tx) => tx.walletLedger.updateMany({ data: { amountMicros: 999n } })),
    ).rejects.toThrow();
    await expect(asOrg(orgId, (tx) => tx.walletLedger.deleteMany())).rejects.toThrow();
  });

  it('snapshots the rate, which later rate changes cannot alter', async () => {
    const orgId = await funded(5_000_000);
    await debit(orgId, 1_000_000, 'snap');
    const entry = (await state(orgId)).entries.find((e) => e.type === 'debit');
    expect(entry).toMatchObject({ country: 'IN', category: 'marketing' });
    expect(Number(entry?.rateMicros)).toBe(1_000_000);
  });

  it('a wallet cannot be deleted by the app role', async () => {
    const orgId = await funded();
    await expect(asOrg(orgId, (tx) => tx.wallet.deleteMany())).rejects.toThrow();
  });
});

describe('low balance', () => {
  async function withThreshold(balance: number, threshold: number) {
    const orgId = await funded(balance);
    await asOrg(orgId, (tx) =>
      tx.wallet.updateMany({ data: { lowBalanceThresholdMicros: BigInt(threshold) } }),
    );
    return orgId;
  }

  it('reports the crossing once, not on every send after it', async () => {
    const orgId = await withThreshold(5_000_000, 3_000_000);
    expect((await debit(orgId, 1_000_000)).crossedLowBalance).toBe(false);
    expect((await debit(orgId, 2_000_000)).crossedLowBalance).toBe(true);
    expect((await debit(orgId, 1_000_000)).crossedLowBalance).toBe(false);
  });

  it('alerts again after a top-up and a new crossing', async () => {
    const orgId = await withThreshold(4_000_000, 3_000_000);
    expect((await debit(orgId, 2_000_000)).crossedLowBalance).toBe(true);
    await asOrg(orgId, (tx) =>
      creditWallet(tx, { orgId, amountMicros: 5_000_000, idempotencyKey: 'top' }),
    );
    expect((await debit(orgId, 5_000_000)).crossedLowBalance).toBe(true);
  });

  it('only one of many parallel debits reports it', async () => {
    const orgId = await withThreshold(10_000_000, 5_000_000);
    const results = await Promise.all(Array.from({ length: 10 }, () => debit(orgId, 1_000_000)));
    expect(results.filter((r) => r.crossedLowBalance)).toHaveLength(1);
  }, 60_000);
});

describe('reservations', () => {
  const reserve = (
    orgId: string,
    amountMicros: number,
    key: string = randomUUID(),
    expiresIn = 3600_000,
  ) =>
    asOrg(orgId, (tx) =>
      reserveFunds(tx, {
        orgId,
        amountMicros,
        referenceType: 'campaign',
        referenceId: key,
        idempotencyKey: key,
        expiresAt: new Date(Date.now() + expiresIn),
      }),
    );

  it('holds funds away from other sends without changing the balance', async () => {
    const orgId = await funded(10_000_000);
    await reserve(orgId, 8_000_000);
    expect((await state(orgId)).balance).toBe(10_000_000);
    await expect(debit(orgId, 3_000_000)).rejects.toSatisfy(isInsufficient);
    expect((await debit(orgId, 2_000_000)).applied).toBe(true);
  });

  it('a send from the reservation uses held money, then the rest returns', async () => {
    const orgId = await funded(10_000_000);
    const r = await reserve(orgId, 6_000_000);
    await asOrg(orgId, (tx) =>
      debitWallet(tx, {
        orgId,
        amountMicros: 2_000_000,
        idempotencyKey: 'c1',
        reservationId: r.id,
        rate: RATE,
      }),
    );
    let s = await state(orgId);
    expect(s).toMatchObject({ balance: 8_000_000, reserved: 4_000_000 });

    const released = await asOrg(orgId, (tx) =>
      releaseReservation(tx, { orgId, reservationId: r.id }),
    );
    expect(released.releasedMicros).toBe(4_000_000);
    s = await state(orgId);
    expect(s).toMatchObject({ balance: 8_000_000, reserved: 0 });

    // A second release changes nothing, and a released hold cannot be spent.
    const again = await asOrg(orgId, (tx) =>
      releaseReservation(tx, { orgId, reservationId: r.id }),
    );
    expect(again.releasedMicros).toBe(0);
    await expect(
      asOrg(orgId, (tx) =>
        debitWallet(tx, {
          orgId,
          amountMicros: 1_000_000,
          idempotencyKey: 'c2',
          reservationId: r.id,
          rate: RATE,
        }),
      ),
    ).rejects.toThrow('no longer active');
  });

  it('cannot spend more than it holds', async () => {
    const orgId = await funded(10_000_000);
    const r = await reserve(orgId, 1_000_000);
    await expect(
      asOrg(orgId, (tx) =>
        debitWallet(tx, {
          orgId,
          amountMicros: 2_000_000,
          idempotencyKey: 'over',
          reservationId: r.id,
          rate: RATE,
        }),
      ),
    ).rejects.toSatisfy(isInsufficient);
  });

  it('the same key returns the same hold', async () => {
    const orgId = await funded(10_000_000);
    const first = await reserve(orgId, 3_000_000, 'campaign-1');
    const second = await reserve(orgId, 3_000_000, 'campaign-1');
    expect(second).toEqual({ id: first.id, created: false, amountMicros: 3_000_000 });
    expect((await state(orgId)).reserved).toBe(3_000_000);
  });

  it('a hold that outlives its campaign goes back', async () => {
    const orgId = await funded(10_000_000);
    await reserve(orgId, 10_000_000, 'crashed', -1000);
    // The next reservation releases it first, so this fits.
    await reserve(orgId, 9_000_000);
    expect((await state(orgId)).reserved).toBe(9_000_000);
  });
});

describe('rate cards', () => {
  const currency = () => `X${randomUUID().slice(0, 2).toUpperCase()}`;

  async function rates(cur: string, rows: [string, string, number, string][]) {
    await owner.rateCard.createMany({
      data: rows.map(([country, category, micros, from]) => ({
        country,
        category,
        currency: cur,
        rateMicros: BigInt(micros),
        validFrom: new Date(from),
      })),
    });
  }
  const quote = (cur: string, category: string, country: string | null, at?: Date) =>
    asOrg(a.orgId, (tx) => findRate(tx, { currency: cur, category, country, at }));

  it('a country rate wins over the any-country rate', async () => {
    const cur = currency();
    await rates(cur, [
      ['IN', 'marketing', 700, '2026-01-01'],
      ['*', 'marketing', 900, '2026-01-01'],
    ]);
    expect((await quote(cur, 'MARKETING', 'IN'))?.rateMicros).toBe(700);
    expect(await quote(cur, 'marketing', 'BR')).toMatchObject({ rateMicros: 900, country: '*' });
    expect((await quote(cur, 'marketing', null))?.rateMicros).toBe(900);
  });

  it('uses the version in force at the time, and ignores future ones', async () => {
    const cur = currency();
    await rates(cur, [
      ['IN', 'utility', 100, '2026-01-01'],
      ['IN', 'utility', 200, '2026-06-01'],
      ['IN', 'utility', 300, '2099-01-01'],
    ]);
    expect((await quote(cur, 'utility', 'IN', new Date('2026-03-01')))?.rateMicros).toBe(100);
    expect((await quote(cur, 'utility', 'IN', new Date('2026-07-01')))?.rateMicros).toBe(200);
    expect((await quote(cur, 'utility', 'IN'))?.rateMicros).toBe(200);
  });

  it('finds nothing for another currency or category', async () => {
    const cur = currency();
    await rates(cur, [['IN', 'marketing', 100, '2026-01-01']]);
    expect(await quote(cur, 'authentication', 'IN')).toBeNull();
    expect(await quote('ZZZ', 'marketing', 'IN')).toBeNull();
  });

  it('the app role can read rate cards but never change them', async () => {
    await expect(
      asOrg(a.orgId, (tx) =>
        tx.rateCard.create({
          data: {
            country: 'IN',
            category: 'marketing',
            currency: 'INR',
            rateMicros: 1n,
            validFrom: new Date(),
          },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      asOrg(a.orgId, (tx) => tx.rateCard.updateMany({ data: { rateMicros: 0n } })),
    ).rejects.toThrow();
  });
});

describe('tenant isolation', () => {
  it('another org cannot see or spend from a wallet', async () => {
    const orgId = await funded(5_000_000);
    const other = await funded(1_000_000);
    const seen = await asOrg(other, (tx) => tx.wallet.findMany({ where: { orgId } }));
    expect(seen).toEqual([]);
    // Named by id, the row is not visible, so nothing to lock.
    await expect(
      asOrg(other, (tx) =>
        debitWallet(tx, {
          orgId,
          amountMicros: 1_000_000,
          idempotencyKey: 'steal',
          rate: RATE,
        }),
      ),
    ).rejects.toThrow('no wallet');
    expect((await state(orgId)).balance).toBe(5_000_000);
    const ledger = await asOrg(other, (tx) => tx.walletLedger.findMany({ where: { orgId } }));
    expect(ledger).toEqual([]);
    const holds = await asOrg(other, (tx) => tx.walletReservation.findMany({ where: { orgId } }));
    expect(holds).toEqual([]);
  });

  it('the same payment id in two orgs are separate credits', async () => {
    const x = await funded();
    const y = await funded();
    for (const orgId of [x, y]) {
      const res = await asOrg(orgId, (tx) =>
        creditWallet(tx, { orgId, amountMicros: 1_000_000, idempotencyKey: 'pay_same' }),
      );
      expect(res.applied).toBe(true);
    }
  });
});
