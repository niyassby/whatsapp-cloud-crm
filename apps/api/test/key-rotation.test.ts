/**
 * Phase 4.4: rotating the JWT secrets (infra/key-rotation.md). With the old secrets listed as
 * previous, sessions, refresh cookies and API keys keep working, and an API key is rehashed under
 * the new pepper on use; once the old secrets are dropped, old access tokens stop and the
 * rehashed key still works.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp, Client, type TestApp } from './helpers';

const OLD = { access: randomBytes(32).toString('hex'), refresh: randomBytes(32).toString('hex') };
const NEW = { access: randomBytes(32).toString('hex'), refresh: randomBytes(32).toString('hex') };
const opened: TestApp[] = [];

async function app(env: Record<string, string>) {
  const t = await buildApp({ env });
  opened.push(t);
  return t;
}
afterAll(async () => {
  for (const t of opened) await t.close();
});

/** The same session and key, carried from one app instance to the next. */
function carry(t: TestApp, from: Client) {
  const c = new Client(t.app);
  c.accessToken = from.accessToken;
  c.cookie = from.cookie;
  return c;
}

describe('rotating the JWT secrets', () => {
  it('keeps sessions and keys through the change, and drops the old secrets after', async () => {
    const before = await app({ JWT_ACCESS_SECRET: OLD.access, JWT_REFRESH_SECRET: OLD.refresh });
    const user = new Client(before.app);
    await user.signup();
    const key = (await user.post('/api-keys', { name: 'Zapier', scopes: ['contacts:read'] })).body
      .key as string;
    const oldAccess = user.accessToken!;

    // During the rotation: new secrets, old ones still accepted.
    const during = await app({
      JWT_ACCESS_SECRET: NEW.access,
      JWT_REFRESH_SECRET: NEW.refresh,
      JWT_ACCESS_SECRET_PREVIOUS: OLD.access,
      JWT_REFRESH_SECRET_PREVIOUS: OLD.refresh,
    });
    const same = carry(during, user);
    expect((await same.get('/orgs/current')).status).toBe(200);
    const apiCall = (t: TestApp) =>
      new Client(t.app).req('GET', '/v1/contacts', undefined, { authorization: `Bearer ${key}` });
    expect((await apiCall(during)).status).toBe(200);
    // The refresh cookie was stored under the old pepper; refreshing issues new-secret tokens.
    const refreshed = await same.post('/auth/refresh');
    expect(refreshed.status).toBe(200);
    const newAccess = same.accessToken!;
    expect(newAccess).not.toBe(oldAccess);

    // After: the old secrets are gone.
    const after = await app({ JWT_ACCESS_SECRET: NEW.access, JWT_REFRESH_SECRET: NEW.refresh });
    const stale = new Client(after.app);
    stale.accessToken = oldAccess;
    expect((await stale.get('/orgs/current')).status).toBe(401);
    const fresh = new Client(after.app);
    fresh.accessToken = newAccess;
    expect((await fresh.get('/orgs/current')).status).toBe(200);
    // Rehashed on its use during the rotation, so it still works.
    expect((await apiCall(after)).status).toBe(200);
  });
});
