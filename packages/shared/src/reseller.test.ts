import { describe, expect, it } from 'vitest';
import { IMPERSONATION_DENIED, impersonationPermissions, Permission } from './permissions';
import {
  applyMarkup,
  createClientSchema,
  createRateCardSchema,
  periodOf,
  previousPeriod,
  updatePartnerSelfSchema,
  walletCreditSchema,
} from './reseller';

describe('applyMarkup', () => {
  it('adds the percentage in whole micros, rounding up', () => {
    expect(applyMarkup(1_000_000, 2000)).toBe(1_200_000);
    expect(applyMarkup(333_333, 1500)).toBe(383_333);
    expect(applyMarkup(1, 1)).toBe(2);
  });

  it('never goes below the wholesale amount', () => {
    for (const wholesale of [1, 7, 333_333, 9_999_999]) {
      for (const bps of [0, 1, 250, 9_999, 20_000]) {
        expect(applyMarkup(wholesale, bps)).toBeGreaterThanOrEqual(wholesale);
      }
    }
  });

  it('leaves free and unmarked prices alone', () => {
    expect(applyMarkup(0, 5000)).toBe(0);
    expect(applyMarkup(850_000, 0)).toBe(850_000);
  });
});

describe('periods', () => {
  it('are UTC months', () => {
    expect(periodOf(new Date('2026-11-30T23:59:59Z'))).toBe('2026-11');
    // Already December in India, still November in UTC.
    expect(periodOf(new Date('2026-12-01T03:00:00+05:30'))).toBe('2026-11');
  });

  it('step back across a year', () => {
    expect(previousPeriod('2026-11')).toBe('2026-10');
    expect(previousPeriod('2026-01')).toBe('2025-12');
  });
});

describe('impersonation permissions', () => {
  it('are an admin’s, less anything lasting or about membership', () => {
    const allowed = impersonationPermissions();
    for (const p of IMPERSONATION_DENIED) expect(allowed).not.toContain(p);
    expect(allowed).toContain(Permission.INBOX_REPLY);
    expect(allowed).toContain(Permission.TEMPLATES_MANAGE);
    expect(allowed).not.toContain(Permission.API_KEYS_MANAGE);
    expect(allowed).not.toContain(Permission.BILLING_MANAGE);
  });
});

describe('input', () => {
  it('lower-cases the owner email and accepts a zero client price', () => {
    const parsed = createClientSchema.parse({
      name: 'Client',
      ownerEmail: 'Owner@Example.COM',
      planCode: 'growth',
      clientPrice: '0',
    });
    expect(parsed.ownerEmail).toBe('owner@example.com');
  });

  it('refuses a credit of nothing, and one with no idempotency key', () => {
    const base = { note: 'Bank transfer', idempotencyKey: 'k-12345678' };
    expect(walletCreditSchema.safeParse({ ...base, amount: '0' }).success).toBe(false);
    expect(walletCreditSchema.safeParse({ ...base, amount: '-5' }).success).toBe(false);
    expect(walletCreditSchema.safeParse({ ...base, amount: '25.50' }).success).toBe(true);
    expect(walletCreditSchema.safeParse({ note: 'Bank transfer', amount: '5' }).success).toBe(
      false,
    );
  });

  it('caps the markup at 200%', () => {
    expect(updatePartnerSelfSchema.safeParse({ walletMarkupBps: 20_000 }).success).toBe(true);
    expect(updatePartnerSelfSchema.safeParse({ walletMarkupBps: 20_001 }).success).toBe(false);
    expect(updatePartnerSelfSchema.safeParse({ walletMarkupBps: -1 }).success).toBe(false);
  });

  it('takes a country code or * for a rate', () => {
    const rate = { category: 'marketing', currency: 'inr', rate: '0.85' };
    expect(createRateCardSchema.parse({ ...rate, country: 'in' })).toMatchObject({
      country: 'IN',
      currency: 'INR',
    });
    expect(createRateCardSchema.safeParse({ ...rate, country: '*' }).success).toBe(true);
    expect(createRateCardSchema.safeParse({ ...rate, country: 'IND' }).success).toBe(false);
  });
});
