import { describe, expect, it } from 'vitest';
import {
  createTopupSchema,
  effectiveStatus,
  microsToMinor,
  minorToMicros,
  plansFileSchema,
  taxInside,
  taxOnTop,
} from './billing';

const NOW = new Date('2026-06-01T00:00:00Z');
const LATER = new Date('2026-07-01T00:00:00Z');
const EARLIER = new Date('2026-05-01T00:00:00Z');

describe('effectiveStatus', () => {
  const sub = (status: string, trialEndsAt: Date | null, currentPeriodEnd: Date | null) => ({
    status,
    trialEndsAt,
    currentPeriodEnd,
  });

  it('a trial runs until its end date, and not a moment after', () => {
    expect(effectiveStatus(sub('trialing', LATER, null), NOW)).toBe('trialing');
    expect(effectiveStatus(sub('trialing', EARLIER, null), NOW)).toBe('expired');
    expect(effectiveStatus(sub('trialing', NOW, null), NOW)).toBe('expired');
  });

  it('a cancelled plan lasts until the period paid for ends', () => {
    expect(effectiveStatus(sub('cancelled', null, LATER), NOW)).toBe('active');
    expect(effectiveStatus(sub('cancelled', null, EARLIER), NOW)).toBe('expired');
    expect(effectiveStatus(sub('cancelled', null, null), NOW)).toBe('expired');
  });

  it('a failed payment keeps the plan while the provider retries', () => {
    expect(effectiveStatus(sub('past_due', null, EARLIER), NOW)).toBe('past_due');
    expect(effectiveStatus(sub('active', null, EARLIER), NOW)).toBe('active');
  });
});

describe('tax', () => {
  it('on top: the customer pays more, the wallet gets the amount', () => {
    expect(taxOnTop(1000_000_000, 1800)).toEqual({
      subtotalMicros: 1000_000_000,
      taxMicros: 180_000_000,
      totalMicros: 1180_000_000,
    });
  });

  it('inside: the parts always add up to the price', () => {
    expect(taxInside(1180_000_000, 1800)).toEqual({
      subtotalMicros: 1000_000_000,
      taxMicros: 180_000_000,
      totalMicros: 1180_000_000,
    });
    const odd = taxInside(999_990_000, 1800);
    expect(odd.subtotalMicros + odd.taxMicros).toBe(999_990_000);
  });

  it('no rate means no tax', () => {
    expect(taxOnTop(5, 0).taxMicros).toBe(0);
    expect(taxInside(5, 0)).toMatchObject({ subtotalMicros: 5, taxMicros: 0 });
  });
});

describe('provider units', () => {
  it('converts both ways', () => {
    expect(minorToMicros(118000, 'INR')).toBe(1180_000_000);
    expect(microsToMinor(1180_000_000, 'INR')).toBe(118000);
  });

  it('zero-decimal currencies have no minor unit', () => {
    expect(minorToMicros(500, 'JPY')).toBe(500_000_000);
    expect(microsToMinor(500_000_000, 'JPY')).toBe(500);
  });
});

describe('input', () => {
  it('a top-up needs a sensible amount', () => {
    const ok = (amount: string) => createTopupSchema.safeParse({ amount }).success;
    expect(ok('100')).toBe(true);
    expect(ok('49.50')).toBe(true);
    expect(ok('0')).toBe(false);
    expect(ok('-5')).toBe(false);
    expect(ok('abc')).toBe(false);
    expect(ok('99999999999')).toBe(false);
  });

  it('a plans file cannot list a feature that does not exist', () => {
    const file = (features: string[]) => ({
      plans: [{ code: 'a', name: 'A', seats: 1, numbers: 1, contacts: null, features }],
    });
    expect(plansFileSchema.safeParse(file(['campaigns'])).success).toBe(true);
    expect(plansFileSchema.safeParse(file(['teleport'])).success).toBe(false);
  });
});
