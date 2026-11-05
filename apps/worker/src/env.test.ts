import { describe, expect, it } from 'vitest';
import { loadWorkerEnv } from './env';

const base = {
  DATABASE_URL: 'postgresql://u:p@127.0.0.1:5433/db',
  ENCRYPTION_KEY: 'x',
};

describe('worker env', () => {
  it('applies defaults', () => {
    const env = loadWorkerEnv(base);
    expect(env.WORKER_HEALTH_PORT).toBe(4001);
    expect(env.WEBHOOK_RETENTION_DAYS).toBe(30);
    expect(env.QUEUE_PREFIX).toBe('wacrm');
  });
  it('requires a database', () => {
    expect(() => loadWorkerEnv({})).toThrow(/DATABASE_URL/);
  });
  it('rejects bad port', () => {
    expect(() => loadWorkerEnv({ ...base, WORKER_HEALTH_PORT: 'abc' })).toThrow();
  });
});
