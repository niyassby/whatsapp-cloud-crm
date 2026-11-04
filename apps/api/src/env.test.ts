import { describe, expect, it } from 'vitest';
import { loadApiEnv } from './env';

describe('api env', () => {
  const base = { DATABASE_URL: 'postgresql://u:p@localhost:5433/db' };

  it('applies defaults', () => {
    const env = loadApiEnv(base);
    expect(env.API_PORT).toBe(4000);
    expect(env.DATABASE_POOL_MAX).toBe(10);
  });

  it('requires DATABASE_URL', () => {
    expect(() => loadApiEnv({})).toThrow(/DATABASE_URL/);
  });

  it('rejects a non-postgres DATABASE_URL', () => {
    expect(() => loadApiEnv({ DATABASE_URL: 'mysql://u:p@h/db' })).toThrow(/DATABASE_URL/);
  });
});
