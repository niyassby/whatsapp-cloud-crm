import { describe, expect, it } from 'vitest';
import { countryOfWaId, normalizePhone } from './phone';

describe('countryOfWaId', () => {
  it('finds the country that sets the price', () => {
    expect(countryOfWaId('919876543210')).toBe('IN');
    expect(countryOfWaId('14155552671')).toBe('US');
    expect(countryOfWaId('5511987654321')).toBe('BR');
  });
  it('gives null when it cannot tell', () => {
    expect(countryOfWaId('123')).toBeNull();
    expect(countryOfWaId('')).toBeNull();
  });
});

describe('normalizePhone', () => {
  it.each([
    ['+91 98765 43210', undefined, '919876543210'],
    ['+1 (415) 555-2671', undefined, '14155552671'],
    ['00919876543210', undefined, '919876543210'],
    ['919876543210', undefined, '919876543210'],
    ['98765 43210', 'IN', '919876543210'],
    ['098765-43210', 'IN', '919876543210'],
    ['919876543210', 'IN', '919876543210'],
    ['(415) 555-2671', 'US', '14155552671'],
  ])('%s with %s becomes %s', (raw, country, expected) => {
    expect(normalizePhone(raw, country)).toBe(expected);
  });

  it.each(['', 'abc', '12', '9.198E+11', '+91 12', '98765 43210'])('rejects %j', (raw) => {
    expect(normalizePhone(raw)).toBeNull();
  });
});
