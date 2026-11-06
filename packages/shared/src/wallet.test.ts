import { describe, expect, it } from 'vitest';
import { decimalToMicros, formatMoney, isChargeable, microsToDecimal } from './wallet';

describe('decimalToMicros', () => {
  it.each([
    ['0.0099', 9_900],
    ['1', 1_000_000],
    ['1.5', 1_500_000],
    ['0.000001', 1],
    ['123456.789012', 123_456_789_012],
    [' 2.50 ', 2_500_000],
    ['0', 0],
  ])('reads %s exactly', (text, micros) => {
    expect(decimalToMicros(text)).toBe(micros);
  });

  it.each(['', 'abc', '-1', '1.2345678', '1,5', '1.', '.5', '1e3'])('rejects %j', (text) => {
    expect(decimalToMicros(text)).toBeNull();
  });
});

describe('microsToDecimal', () => {
  it.each([
    [9_900, '0.0099'],
    [1_000_000, '1'],
    [1_500_000, '1.5'],
    [1, '0.000001'],
    [0, '0'],
    [-2_500_000, '-2.5'],
  ])('writes %i as %s', (micros, text) => {
    expect(microsToDecimal(micros)).toBe(text);
  });

  it('round-trips without losing a unit', () => {
    for (const micros of [1, 999_999, 1_000_001, 987_654_321]) {
      expect(decimalToMicros(microsToDecimal(micros))).toBe(micros);
    }
  });

  it('adds what floats get wrong', () => {
    // 0.1 + 0.2 in floats is 0.30000000000000004.
    const sum = decimalToMicros('0.1')! + decimalToMicros('0.2')!;
    expect(microsToDecimal(sum)).toBe('0.3');
  });
});

describe('formatMoney', () => {
  it('shows two decimals, and more only when needed', () => {
    expect(formatMoney(1_500_000, 'USD')).toBe('$1.50');
    expect(formatMoney(9_900, 'USD')).toBe('$0.0099');
    expect(formatMoney(0, 'USD')).toBe('$0.00');
  });
});

describe('isChargeable', () => {
  it('charges marketing and authentication at any time', () => {
    for (const windowOpen of [true, false]) {
      expect(isChargeable('MARKETING', windowOpen)).toBe(true);
      expect(isChargeable('authentication', windowOpen)).toBe(true);
    }
  });

  it('charges utility only outside the window', () => {
    expect(isChargeable('UTILITY', true)).toBe(false);
    expect(isChargeable('UTILITY', false)).toBe(true);
  });

  it('never charges service', () => {
    expect(isChargeable('service', false)).toBe(false);
  });
});
