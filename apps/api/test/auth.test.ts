import { ErrorCode } from '@wacrm/shared';
import { generateTotp } from '@wacrm/shared/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, Client, type TestApp, tokenFromMail, uniqueEmail } from './helpers';

let t: TestApp;
beforeAll(async () => {
  t = await buildApp();
});
afterAll(() => t?.close());

const client = () => new Client(t.app);

describe('signup', () => {
  it('creates user, org and owner membership, and logs in', async () => {
    const c = client();
    const res = await c.post('/auth/signup', {
      name: 'Ada',
      email: uniqueEmail('ada').toUpperCase(),
      password: 'correct-horse-battery',
      orgName: 'Acme Inc',
    });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ accessToken: expect.any(String), expiresIn: 900 });
    expect(res.body.refreshToken).toBeUndefined();

    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/wacrm_rt=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Path=\/auth/);
    expect(cookie).toMatch(/SameSite=Lax/i);

    const me = await c.get('/auth/me');
    expect(me.body.user.email).toBe(me.body.user.email.toLowerCase());
    expect(me.body.user.emailVerified).toBe(false);
    expect(me.body.currentOrg).toMatchObject({ name: 'Acme Inc', role: 'owner' });
    expect(me.body.permissions).toContain('team:invite');
    expect(t.mailer.lastTo(me.body.user.email)?.subject).toMatch(/Verify your email/);
  });

  it('rejects a duplicate email regardless of case', async () => {
    const c = client();
    const { email } = await c.signup();
    const res = await client().post('/auth/signup', {
      name: 'Dup',
      email: email.toUpperCase(),
      password: 'correct-horse-battery',
      orgName: 'Dup',
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe(ErrorCode.EMAIL_TAKEN);
  });

  it('validates input with the shared schema', async () => {
    const res = await client().post('/auth/signup', {
      name: '',
      email: 'nope',
      password: 'short',
      orgName: 'x',
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(ErrorCode.VALIDATION_FAILED);
    const paths = res.body.details.issues.map((i: { path: string }) => i.path);
    expect(paths).toEqual(expect.arrayContaining(['name', 'email', 'password']));
  });
});

describe('login', () => {
  it('rejects bad credentials with one generic error', async () => {
    const { email } = await client().signup();
    const wrong = await client().post('/auth/login', { email, password: 'wrong-password-123' });
    const unknown = await client().post('/auth/login', {
      email: uniqueEmail(),
      password: 'whatever-123',
    });
    expect([wrong.status, unknown.status]).toEqual([401, 401]);
    expect(wrong.body.code).toBe(ErrorCode.INVALID_CREDENTIALS);
    expect(unknown.body).toEqual(wrong.body);
  });

  it('logs in and lands in the first org', async () => {
    const owner = await client().signup({ orgName: 'First' });
    const c = client();
    const res = await c.post('/auth/login', { email: owner.email, password: owner.password });
    expect(res.status).toBe(200);
    expect((await c.get('/auth/me')).body.currentOrg.id).toBe(owner.orgId);
  });

  it('locks an email after 5 failures, even for the right password', async () => {
    const { email, password } = await client().signup();
    const c = client();
    for (let i = 0; i < 5; i++) {
      expect((await c.post('/auth/login', { email, password: 'wrong-password-123' })).status).toBe(
        401,
      );
    }
    const blocked = await c.post('/auth/login', { email, password });
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe(ErrorCode.RATE_LIMITED);
    expect(blocked.body.details.retryAfterSeconds).toBeGreaterThan(0);
    // Other accounts are unaffected.
    const other = await client().signup();
    expect(
      (await c.post('/auth/login', { email: other.email, password: other.password })).status,
    ).toBe(200);
  });
});

describe('refresh tokens', () => {
  it('rotate on every refresh', async () => {
    const c = client();
    await c.signup();
    const firstCookie = c.cookie;
    const firstAccess = c.accessToken;
    const res = await c.post('/auth/refresh');
    expect(res.status).toBe(200);
    expect(c.cookie).not.toBe(firstCookie);
    expect(c.accessToken).not.toBe(firstAccess);
    expect((await c.get('/auth/me')).status).toBe(200);
  });

  it('detect reuse and revoke the whole session', async () => {
    const victim = client();
    const { email, password } = await victim.signup();
    const stolen = victim.cookie;
    await victim.post('/auth/refresh'); // victim rotates; `stolen` is now spent

    const attacker = client();
    attacker.cookie = stolen;
    const reuse = await attacker.post('/auth/refresh');
    expect(reuse.status).toBe(401);
    expect(reuse.body.code).toBe(ErrorCode.REFRESH_REUSE_DETECTED);

    // The victim's current refresh token and access token die with the family.
    expect((await victim.get('/auth/me')).status).toBe(401);
    const victimRefresh = await victim.post('/auth/refresh');
    expect(victimRefresh.status).toBe(401);

    // Logging in again works, and the incident is in the audit log.
    const back = client();
    expect((await back.post('/auth/login', { email, password })).status).toBe(200);
    const logs = await back.get('/orgs/current/audit-logs');
    expect(logs.body.items.map((l: { action: string }) => l.action)).toContain(
      'auth.refresh_reuse_detected',
    );
  });

  it('are refused from a foreign Origin', async () => {
    const c = client();
    await c.signup();
    const res = await c.post('/auth/refresh', {}, { origin: 'https://evil.example' });
    expect(res.status).toBe(403);
  });

  it('logout ends the session immediately', async () => {
    const c = client();
    await c.signup();
    const access = c.accessToken;
    const cookie = c.cookie;
    expect((await c.post('/auth/logout')).status).toBe(204);
    expect(c.cookie).toBeUndefined();

    const replay = client();
    replay.accessToken = access;
    replay.cookie = cookie;
    expect((await replay.get('/auth/me')).status).toBe(401);
    expect((await replay.post('/auth/refresh')).body.code).toBe(ErrorCode.SESSION_INVALID);
  });
});

describe('email verification', () => {
  it('verifies once with the emailed token', async () => {
    const c = client();
    const { email } = await c.signup();
    const token = tokenFromMail(t.mailer, email);
    expect((await client().post('/auth/verify-email', { token })).status).toBe(204);
    expect((await c.get('/auth/me')).body.user.emailVerified).toBe(true);
    const again = await client().post('/auth/verify-email', { token });
    expect(again.status).toBe(400);
    expect(again.body.code).toBe(ErrorCode.TOKEN_INVALID);
  });
});

describe('password reset', () => {
  it('does not reveal whether an account exists', async () => {
    const ghost = uniqueEmail('ghost');
    expect((await client().post('/auth/forgot-password', { email: ghost })).status).toBe(204);
    expect(t.mailer.lastTo(ghost)).toBeUndefined();
  });

  it('resets the password and signs out every session', async () => {
    const c = client();
    const { email, password } = await c.signup();
    expect((await c.post('/auth/forgot-password', { email })).status).toBe(204);
    const token = tokenFromMail(t.mailer, email);

    const reset = await client().post('/auth/reset-password', {
      token,
      password: 'a-brand-new-password',
    });
    expect(reset.status).toBe(204);

    expect((await c.get('/auth/me')).status).toBe(401);
    expect((await c.post('/auth/refresh')).status).toBe(401);
    expect((await client().post('/auth/login', { email, password })).status).toBe(401);
    expect(
      (await client().post('/auth/login', { email, password: 'a-brand-new-password' })).status,
    ).toBe(200);
    expect(
      (await client().post('/auth/reset-password', { token, password: 'another-password-1' }))
        .status,
    ).toBe(400);
  });

  it('records the reset in the audit log', async () => {
    const c = client();
    const { email } = await c.signup();
    await c.post('/auth/forgot-password', { email });
    await client().post('/auth/reset-password', {
      token: tokenFromMail(t.mailer, email),
      password: 'a-brand-new-password',
    });
    const back = client();
    await back.post('/auth/login', { email, password: 'a-brand-new-password' });
    const logs = await back.get('/orgs/current/audit-logs');
    expect(logs.body.items.map((l: { action: string }) => l.action)).toContain(
      'auth.password_reset',
    );
  });
});

describe('TOTP 2FA', () => {
  it('setup -> enable -> login challenge -> verify, with replay protection', async () => {
    const c = client();
    const { email, password } = await c.signup();
    const setup = await c.post('/auth/2fa/setup');
    expect(setup.status).toBe(200);
    expect(setup.body.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    const secret: string = setup.body.secret;

    expect((await c.post('/auth/2fa/enable', { code: '000000' })).body.code).toBe(
      ErrorCode.MFA_INVALID,
    );
    expect((await c.post('/auth/2fa/enable', { code: generateTotp(secret) })).status).toBe(204);
    expect((await c.get('/auth/me')).body.user.totpEnabled).toBe(true);

    const login = client();
    const challenge = await login.post('/auth/login', { email, password });
    expect(challenge.body).toEqual({ mfaRequired: true, mfaToken: expect.any(String) });
    expect(login.accessToken).toBeUndefined();

    const bad = await login.post('/auth/2fa/verify', {
      mfaToken: challenge.body.mfaToken,
      code: '123456',
    });
    expect(bad.status).toBe(401);

    // The enable step consumed the current time step, so use the next one (within ±1 drift).
    const next = generateTotp(secret, Date.now() + 30_000);
    const ok = await login.post('/auth/2fa/verify', {
      mfaToken: challenge.body.mfaToken,
      code: next,
    });
    expect(ok.status).toBe(200);
    expect((await login.get('/auth/me')).status).toBe(200);

    const again = client();
    const challenge2 = await again.post('/auth/login', { email, password });
    const replay = await again.post('/auth/2fa/verify', {
      mfaToken: challenge2.body.mfaToken,
      code: next,
    });
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe(ErrorCode.MFA_INVALID);
  });

  it('disabling needs the password and a valid code', async () => {
    const c = client();
    const { password } = await c.signup();
    const { secret } = (await c.post('/auth/2fa/setup')).body;
    await c.post('/auth/2fa/enable', { code: generateTotp(secret) });

    const code = generateTotp(secret);
    expect((await c.post('/auth/2fa/disable', { password: 'wrong-password-1', code })).status).toBe(
      401,
    );
    expect((await c.post('/auth/2fa/disable', { password, code })).status).toBe(204);
    expect((await c.get('/auth/me')).body.user.totpEnabled).toBe(false);
  });

  it('rejects a forged or expired MFA token', async () => {
    const res = await client().post('/auth/2fa/verify', { mfaToken: 'not-a-jwt', code: '123456' });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe(ErrorCode.MFA_INVALID);
  });
});

describe('organizations', () => {
  it('creates a second org and switches the session to it', async () => {
    const c = client();
    const { orgId: first } = await c.signup({ orgName: 'One' });
    const created = await c.post('/orgs', { name: 'Two' });
    expect(created.status).toBe(201);
    expect(created.body.role).toBe('owner');

    expect((await c.post('/auth/switch-org', { orgId: created.body.id })).status).toBe(200);
    expect((await c.get('/orgs/current')).body.name).toBe('Two');

    // A refresh keeps the session on the selected org.
    await c.post('/auth/refresh');
    const me = (await c.get('/auth/me')).body;
    expect(me.currentOrg.id).toBe(created.body.id);
    expect(me.orgs.map((o: { id: string }) => o.id).sort()).toEqual(
      [first, created.body.id].sort(),
    );
  });

  it('owner can rename the org; the change is audited', async () => {
    const c = client();
    await c.signup();
    const res = await c.patch('/orgs/current', { name: 'Renamed', timezone: 'Asia/Kolkata' });
    expect(res.body).toMatchObject({ name: 'Renamed', timezone: 'Asia/Kolkata' });
    const logs = await c.get('/orgs/current/audit-logs');
    expect(logs.body.items[0].action).toBe('org.updated');
  });
});
