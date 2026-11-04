import { describe, expect, it } from 'vitest';
import { buildHealth, healthResponseSchema } from './health';

describe('buildHealth', () => {
  it('matches the schema', () => {
    expect(healthResponseSchema.parse(buildHealth('api')).status).toBe('ok');
  });
});
