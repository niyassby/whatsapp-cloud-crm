import { describe, expect, it } from 'vitest';
import { uuidv7 } from './ids';

describe('uuidv7', () => {
  it('is a version 7 UUID that carries its time', () => {
    const at = Date.UTC(2026, 10, 18, 12, 0, 0);
    const id = uuidv7(at);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(parseInt(id.replace(/-/g, '').slice(0, 12), 16)).toBe(at);
  });

  it('sorts by time and does not repeat', () => {
    const ids = [uuidv7(1_000), uuidv7(2_000), uuidv7(3_000)];
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(Array.from({ length: 1000 }, () => uuidv7())).size).toBe(1000);
  });
});
