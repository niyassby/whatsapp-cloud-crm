import { describe, expect, it } from 'vitest';
import { normalizePhone } from './phone';

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
