/**
 * Phase 4.4 over HTTP: security headers on every response, the per-address and per-person request
 * limits, and the paths those limits leave alone.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, Client, type TestApp } from './helpers';

let t: TestApp;

beforeAll(async () => {
  t = await buildApp({ env: { RATE_LIMIT_IP_PER_MINUTE: '8', RATE_LIMIT_USER_PER_MINUTE: '5' } });
});
afterAll(async () => {
  await t?.close();
});

describe('headers', () => {
  it('every response carries them, whatever its status', async () => {
    const c = new Client(t.app);
    for (const res of [await c.get('/health'), await c.get('/orgs/current')]) {
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
      expect(res.headers['content-security-policy']).toBe(
        "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
      );
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['permissions-policy']).toContain('camera=()');
    }
  });

  it('gives the API reference a policy it can run under', async () => {
    const res = await new Client(t.app).get('/v1/docs');
    expect(res.headers['content-security-policy']).toContain("script-src 'self' 'unsafe-inline'");
  });

  it('sends HSTS only in production', async () => {
    const res = await new Client(t.app).get('/health');
    expect(res.headers['strict-transport-security']).toBeUndefined();
  });
});

describe('request limits', () => {
  it('limits each address per minute, before authentication', async () => {
    const c = new Client(t.app);
    const statuses: number[] = [];
    for (let i = 0; i < 10; i++) statuses.push((await c.get('/orgs/current')).status);
    expect(statuses.slice(0, 8)).toEqual(Array(8).fill(401));
    expect(statuses.slice(8)).toEqual([429, 429]);
    const limited = await c.get('/orgs/current');
    expect(limited.body.code).toBe('RATE_LIMITED');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('leaves health checks, webhooks and the public API to their own rules', async () => {
    const c = new Client(t.app);
    for (let i = 0; i < 12; i++) expect((await c.get('/health')).status).toBe(200);
    // Not 429: Meta's verification answers 403 without the right token.
    for (let i = 0; i < 12; i++) {
      expect((await c.get('/webhooks/meta?hub.mode=subscribe')).status).not.toBe(429);
    }
    for (let i = 0; i < 12; i++) expect((await c.get('/v1/contacts')).status).toBe(401);
  });

  it('limits each signed-in person per minute, from any address', async () => {
    const first = new Client(t.app);
    await first.signup();
    const statuses: number[] = [];
    // A new client per request: new addresses, same person.
    for (let i = 0; i < 7; i++) {
      const c = new Client(t.app);
      c.accessToken = first.accessToken;
      statuses.push((await c.get('/orgs/current')).status);
    }
    // /auth/me during signup counted once.
    expect(statuses.filter((s) => s === 200).length).toBeLessThanOrEqual(5);
    expect(statuses.at(-1)).toBe(429);
  });
});
