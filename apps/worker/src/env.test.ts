import { describe, expect, it } from 'vitest';
import { loadWorkerEnv } from './env';

describe('worker env', () => {
  it('applies defaults', () => {
    expect(loadWorkerEnv({}).WORKER_HEALTH_PORT).toBe(4001);
  });
  it('rejects bad port', () => {
    expect(() => loadWorkerEnv({ WORKER_HEALTH_PORT: 'abc' })).toThrow();
  });
});
