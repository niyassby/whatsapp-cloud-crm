import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadApiEnv } from './env';

describe('api env', () => {
  const meta = { META_APP_ID: '1', META_APP_SECRET: 's', META_WEBHOOK_VERIFY_TOKEN: 'v' };
  const base = {
    DATABASE_URL: 'postgresql://u:p@localhost:5433/db',
    JWT_ACCESS_SECRET: 'a'.repeat(32),
    JWT_REFRESH_SECRET: 'b'.repeat(32),
    ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  };

  it('applies defaults', () => {
    const env = loadApiEnv(base);
    expect(env.API_PORT).toBe(4000);
    expect(env.DATABASE_POOL_MAX).toBe(10);
    expect(env.ACCESS_TOKEN_TTL_SECONDS).toBe(900);
    expect(env.ENCRYPTION_KEY_PREVIOUS).toEqual([]);
    expect(env.TRUST_PROXY).toBe(false);
  });

  it('requires DATABASE_URL and the secrets', () => {
    expect(() => loadApiEnv({})).toThrow(
      /DATABASE_URL[\s\S]*JWT_ACCESS_SECRET[\s\S]*ENCRYPTION_KEY/,
    );
  });

  it('rejects a non-postgres DATABASE_URL', () => {
    expect(() => loadApiEnv({ ...base, DATABASE_URL: 'mysql://u:p@h/db' })).toThrow(/DATABASE_URL/);
  });

  it('rejects short JWT secrets and malformed encryption keys', () => {
    expect(() => loadApiEnv({ ...base, JWT_ACCESS_SECRET: 'short' })).toThrow(/JWT_ACCESS_SECRET/);
    expect(() => loadApiEnv({ ...base, ENCRYPTION_KEY: 'not-32-bytes' })).toThrow(/ENCRYPTION_KEY/);
  });

  it('refuses dev-only secrets in production', () => {
    const dev = {
      ...base,
      ...meta,
      NODE_ENV: 'production',
      JWT_ACCESS_SECRET: 'dev-only-access-secret-0123456789abcdef0123456789',
      ENCRYPTION_KEY: 'ZGV2LW9ubHktZW5jcnlwdGlvbi1rZXktMzJieXRlcyE=',
    };
    expect(() => loadApiEnv(dev)).toThrow(/dev-only values: JWT_ACCESS_SECRET, ENCRYPTION_KEY/);
    expect(loadApiEnv({ ...base, ...meta, NODE_ENV: 'production' }).NODE_ENV).toBe('production');
  });

  it('requires the Meta settings in production', () => {
    expect(() => loadApiEnv({ ...base, NODE_ENV: 'production' })).toThrow(/META_APP_SECRET/);
    expect(loadApiEnv(base).META_GRAPH_API_VERSION).toBe('v25.0');
    expect(() =>
      loadApiEnv({
        ...base,
        ...meta,
        NODE_ENV: 'production',
        META_GRAPH_BASE_URL: 'http://127.0.0.1:4999',
      }),
    ).toThrow(/META_GRAPH_BASE_URL/);
  });

  it('parses previous encryption keys for rotation', () => {
    const prev = [randomBytes(32).toString('base64'), randomBytes(32).toString('base64')];
    expect(
      loadApiEnv({ ...base, ENCRYPTION_KEY_PREVIOUS: prev.join(', ') }).ENCRYPTION_KEY_PREVIOUS,
    ).toEqual(prev);
  });
});
