/**
 * Webhook ingestion, Meta callbacks and number onboarding over HTTP, with the real database and
 * Redis queues. Only Meta's Graph API is faked.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { createPrismaClient, type DbClient } from '@wacrm/db';
import { ErrorCode, WhatsAppErrorCode } from '@wacrm/shared';
import { phonePinAad, phoneTokenAad, SecretBox } from '@wacrm/shared/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { QueuesService } from '../src/infra/queues.service';
import { buildApp, Client, type TestApp, tokenFromMail, uniqueEmail, urls } from './helpers';

const APP_SECRET = 'test-app-secret';
const VERIFY_TOKEN = 'test-verify-token';
const USER_TOKEN = 'EAAG-secret-system-user-token-1234567890';
const VERSION = 'v25.0';

const metaId = () => String(Math.floor(Math.random() * 1e15) + 1e15);

/** Minimal fake of the Graph API endpoints onboarding uses. */
function fakeMeta() {
  const wabas = new Map<string, string[]>();
  const phones = new Map<string, Record<string, unknown>>();
  const calls: { method: string; path: string; auth: string | null }[] = [];
  const failures = new Map<string, { status: number; code: number; message: string }>();

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const method = init?.method ?? 'GET';
    const path = url.pathname.replace(`/${VERSION}`, '');
    calls.push({ method, path, auth: new Headers(init?.headers).get('authorization') });

    const failure = failures.get(`${method} ${path}`);
    if (failure) {
      return json(
        { error: { message: failure.message, code: failure.code, fbtrace_id: 't' } },
        failure.status,
      );
    }
    if (path === '/oauth/access_token') {
      return json({ access_token: `biz-token-for-${url.searchParams.get('code')}` });
    }
    const [, id, sub] = path.split('/');
    if (id && wabas.has(id)) {
      if (sub === 'phone_numbers') {
        return json({ data: wabas.get(id)!.map((p) => ({ id: p, ...phones.get(p) })) });
      }
      if (sub === 'subscribed_apps') return json({ success: true });
      return json({ id, name: 'Acme WABA', currency: 'INR', timezone_id: '53' });
    }
    if (id && phones.has(id)) {
      if (sub === 'register') return json({ success: true });
      return json({ id, ...phones.get(id) });
    }
    return json({ error: { message: 'Unknown object', code: 100 } }, 400);
  }) as typeof fetch;

  return {
    fetchImpl,
    calls,
    failures,
    /** Add a WABA with one number to the fake. */
    add(overrides: Record<string, unknown> = {}) {
      const wabaId = metaId();
      const phoneNumberId = metaId();
      wabas.set(wabaId, [phoneNumberId]);
      phones.set(phoneNumberId, {
        display_phone_number: '+1 555 000 1111',
        verified_name: 'Acme',
        quality_rating: 'GREEN',
        messaging_limit_tier: 'TIER_250',
        code_verification_status: 'VERIFIED',
        name_status: 'APPROVED',
        platform_type: 'NOT_APPLICABLE',
        status: 'PENDING',
        ...overrides,
      });
      return { wabaId, phoneNumberId };
    },
    setPhone(id: string, patch: Record<string, unknown>) {
      phones.set(id, { ...phones.get(id), ...patch });
    },
  };
}

const ENCRYPTION_KEY = randomBytes(32).toString('base64');
const secrets = new SecretBox(ENCRYPTION_KEY);

let t: TestApp;
let meta: ReturnType<typeof fakeMeta>;
let owner: DbClient;
let queues: QueuesService;

beforeAll(async () => {
  meta = fakeMeta();
  t = await buildApp({
    env: {
      ENCRYPTION_KEY,
      META_APP_ID: 'app-1',
      META_APP_SECRET: APP_SECRET,
      META_WEBHOOK_VERIFY_TOKEN: VERIFY_TOKEN,
      META_EMBEDDED_SIGNUP_CONFIG_ID: 'config-1',
    },
    graph: {
      apiVersion: VERSION,
      appId: 'app-1',
      appSecret: APP_SECRET,
      fetch: meta.fetchImpl,
    },
  });
  owner = createPrismaClient({ connectionString: urls.directUrl });
  queues = t.app.get(QueuesService);
});

afterAll(async () => {
  await queues?.webhookEvents.obliterate({ force: true });
  await queues?.metaAccount.obliterate({ force: true });
  await t?.close();
  await owner?.$disconnect();
});

const sign = (body: string, secret = APP_SECRET) =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

const postWebhook = (body: string, signature: string | undefined = sign(body)) =>
  t.app.inject({
    method: 'POST',
    url: '/webhooks/meta',
    payload: body,
    headers: {
      'content-type': 'application/json',
      ...(signature ? { 'x-hub-signature-256': signature } : {}),
    },
  });

function delivery(wabaId: string, phoneNumberId: string, messageId = metaId()) {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: wabaId,
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: phoneNumberId },
              messages: [{ id: `wamid.${messageId}`, type: 'text', text: { body: 'Hi' } }],
            },
          },
        ],
      },
    ],
  });
}

const eventsFor = (phoneNumberId: string) =>
  owner.webhookEvent.findMany({ where: { phoneNumberId } });

describe('webhook verification handshake', () => {
  const get = (q: string) => t.app.inject({ method: 'GET', url: `/webhooks/meta?${q}` });

  it('echoes the challenge as plain text', async () => {
    const res = await get(
      `hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=1158201444`,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('1158201444');
    expect(res.headers['content-type']).toMatch(/text\/plain/);
  });

  it('refuses a wrong token', async () => {
    const res = await get('hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1');
    expect(res.statusCode).toBe(403);
  });
});

describe('webhook delivery', () => {
  it('stores the raw event, enqueues a job, and answers 200', async () => {
    const wabaId = metaId();
    const phone = metaId();
    const body = delivery(wabaId, phone);
    const res = await postWebhook(body);
    expect(res.statusCode).toBe(200);

    const [event] = await eventsFor(phone);
    expect(event).toMatchObject({
      wabaId,
      field: 'messages',
      status: 'received',
      orgId: null,
    });
    expect(event!.payload).toEqual(JSON.parse(body));
    const job = await queues.webhookEvents.getJob(event!.id);
    expect(job?.data).toEqual({ eventId: event!.id });
  });

  it('verifies the exact bytes, so any change is rejected and nothing is stored', async () => {
    const phone = metaId();
    const body = delivery(metaId(), phone);
    expect((await postWebhook(body, sign(body, 'wrong-secret'))).statusCode).toBe(401);
    expect((await postWebhook(`${body} `, sign(body))).statusCode).toBe(401);
    expect((await postWebhook(body, 'nope')).statusCode).toBe(401);
    const missing = await t.app.inject({
      method: 'POST',
      url: '/webhooks/meta',
      payload: body,
      headers: { 'content-type': 'application/json' },
    });
    expect(missing.statusCode).toBe(401);
    expect(await eventsFor(phone)).toEqual([]);
  });

  it('accepts semantically identical JSON only with its own signature', async () => {
    const phone = metaId();
    const pretty = JSON.stringify(JSON.parse(delivery(metaId(), phone)), null, 2);
    expect((await postWebhook(pretty)).statusCode).toBe(200);
    expect(await eventsFor(phone)).toHaveLength(1);
  });

  it('splits a batched delivery into one event per change', async () => {
    const [phoneA, phoneB] = [metaId(), metaId()];
    const a = JSON.parse(delivery(metaId(), phoneA));
    const b = JSON.parse(delivery(metaId(), phoneB));
    const body = JSON.stringify({ ...a, entry: [...a.entry, ...b.entry] });
    expect((await postWebhook(body)).statusCode).toBe(200);
    expect(await eventsFor(phoneA)).toHaveLength(1);
    expect(await eventsFor(phoneB)).toHaveLength(1);
  });

  it('collapses redeliveries onto one row and one job', async () => {
    const phone = metaId();
    const body = delivery(metaId(), phone);
    await postWebhook(body);
    await postWebhook(body);
    const events = await eventsFor(phone);
    expect(events).toHaveLength(1);
    const before = await queues.webhookEvents.getJobCounts('waiting');
    await postWebhook(body);
    expect(await queues.webhookEvents.getJobCounts('waiting')).toEqual(before);
  });

  it('answers 5xx when the queue is down, and the redelivery recovers the job', async () => {
    const phone = metaId();
    const body = delivery(metaId(), phone);
    const add = vi
      .spyOn(queues.webhookEvents, 'add')
      .mockRejectedValueOnce(new Error('Redis is down'));
    expect((await postWebhook(body)).statusCode).toBe(500);
    add.mockRestore();

    const [event] = await eventsFor(phone);
    expect(await queues.webhookEvents.getJob(event!.id)).toBeUndefined();

    expect((await postWebhook(body)).statusCode).toBe(200);
    expect(await queues.webhookEvents.getJob(event!.id)).toBeDefined();
    expect(await eventsFor(phone)).toHaveLength(1);
  });

  it('does not re-enqueue an event that has already been routed', async () => {
    const phone = metaId();
    const body = delivery(metaId(), phone);
    await postWebhook(body);
    const [event] = await eventsFor(phone);
    await queues.webhookEvents.remove(event!.id);
    await owner.webhookEvent.update({ where: { id: event!.id }, data: { status: 'routed' } });
    await postWebhook(body);
    expect(await queues.webhookEvents.getJob(event!.id)).toBeUndefined();
  });

  it('ignores valid but empty bodies', async () => {
    const res = await postWebhook(JSON.stringify({ object: 'page', entry: [] }));
    expect(res.statusCode).toBe(200);
  });
});

describe('when Meta is not configured', () => {
  it('webhooks answer 503, not a false success', async () => {
    const bare = await buildApp();
    try {
      const body = delivery(metaId(), metaId());
      const post = await bare.app.inject({
        method: 'POST',
        url: '/webhooks/meta',
        payload: body,
        headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) },
      });
      expect(post.statusCode).toBe(503);
      expect(post.json().code).toBe(ErrorCode.WHATSAPP_NOT_CONFIGURED);
    } finally {
      await bare.close();
    }
  });
});

describe('Meta signed_request callbacks', () => {
  const signed = (payload: object, secret = APP_SECRET) => {
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${createHmac('sha256', secret).update(encoded).digest('base64url')}.${encoded}`;
  };
  const postForm = (url: string, signedRequest: string) =>
    t.app.inject({
      method: 'POST',
      url,
      payload: `signed_request=${encodeURIComponent(signedRequest)}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
  const good = (userId: string) => signed({ algorithm: 'HMAC-SHA256', user_id: userId });

  it('deauthorize enqueues a job for that user', async () => {
    const add = vi.spyOn(queues.metaAccount, 'add');
    const res = await postForm('/meta/deauthorize', good('fb-1'));
    expect(res.statusCode).toBe(200);
    expect(add).toHaveBeenCalledWith('deauthorize', { kind: 'deauthorize', metaUserId: 'fb-1' });
    add.mockRestore();
  });

  it.each(['/meta/deauthorize', '/meta/data-deletion'])(
    '%s rejects a bad signature',
    async (url) => {
      const res = await postForm(
        url,
        signed({ algorithm: 'HMAC-SHA256', user_id: 'fb-1' }, 'wrong-secret'),
      );
      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe(ErrorCode.WEBHOOK_SIGNATURE_INVALID);
    },
  );

  it('data deletion answers with the url and code Meta requires, and exposes status', async () => {
    const res = await postForm('/meta/data-deletion', good('fb-2'));
    expect(res.statusCode).toBe(200);
    const { url, confirmation_code: code } = res.json();
    expect(url).toBe(`http://localhost:3000/data-deletion?code=${code}`);

    const status = await t.app.inject({ method: 'GET', url: `/meta/data-deletion/${code}` });
    expect(status.json()).toMatchObject({
      confirmationCode: code,
      status: 'received',
      completedAt: null,
    });
    const unknown = await t.app.inject({ method: 'GET', url: '/meta/data-deletion/nope' });
    expect(unknown.statusCode).toBe(404);
  });
});

async function signupOwner() {
  const c = new Client(t.app);
  const s = await c.signup();
  return { client: c, ...s };
}

async function manualConnect(c: Client, ids = meta.add()) {
  const res = await c.post('/whatsapp/manual-connect', { accessToken: USER_TOKEN, ...ids });
  expect(res.status).toBe(201);
  return { ...ids, phone: res.body };
}

describe('config', () => {
  it('reports what is enabled, never the secret', async () => {
    const { client } = await signupOwner();
    const res = await client.get('/whatsapp/config');
    expect(res.body).toEqual({
      embeddedSignupEnabled: true,
      manualConnectEnabled: true,
      appId: 'app-1',
      configId: 'config-1',
      graphApiVersion: VERSION,
    });
    expect(JSON.stringify(res.body)).not.toContain(APP_SECRET);
  });
});

describe('manual connect', () => {
  it('stores the number, encrypts the token, subscribes the app, and never returns the token', async () => {
    const { client, orgId } = await signupOwner();
    const ids = meta.add();
    const res = await client.post('/whatsapp/manual-connect', {
      accessToken: USER_TOKEN,
      ...ids,
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      phoneNumberId: ids.phoneNumberId,
      wabaId: ids.wabaId,
      wabaName: 'Acme WABA',
      verifiedName: 'Acme',
      qualityRating: 'GREEN',
      messagingTier: 'TIER_250',
      status: 'connected',
      credentialSource: 'manual',
    });
    expect(JSON.stringify(res.body)).not.toContain(USER_TOKEN);
    expect(res.body.accessTokenEnc).toBeUndefined();

    const row = await owner.phoneNumber.findFirstOrThrow({
      where: { phoneNumberId: ids.phoneNumberId },
    });
    expect(row.orgId).toBe(orgId);
    expect(row.accessTokenEnc).not.toContain(USER_TOKEN);
    expect(secrets.decrypt(row.accessTokenEnc!, phoneTokenAad(row.id))).toBe(USER_TOKEN);

    expect(meta.calls).toContainEqual({
      method: 'POST',
      path: `/${ids.wabaId}/subscribed_apps`,
      auth: `Bearer ${USER_TOKEN}`,
    });
    // Test numbers are already registered: no PIN, no register call.
    expect(meta.calls.some((c) => c.path === `/${ids.phoneNumberId}/register`)).toBe(false);

    const list = await client.get('/whatsapp/phone-numbers');
    expect(list.body.map((p: { phoneNumberId: string }) => p.phoneNumberId)).toEqual([
      ids.phoneNumberId,
    ]);
    expect(JSON.stringify(list.body)).not.toContain('Enc');

    const logs = await client.get('/orgs/current/audit-logs');
    expect(logs.body.items.map((l: { action: string }) => l.action)).toContain(
      'whatsapp.connected',
    );
  });

  it('rejects a number that is not under that WABA, storing nothing', async () => {
    const { client } = await signupOwner();
    const a = meta.add();
    const b = meta.add();
    const res = await client.post('/whatsapp/manual-connect', {
      accessToken: USER_TOKEN,
      wabaId: a.wabaId,
      phoneNumberId: b.phoneNumberId,
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(ErrorCode.WHATSAPP_PHONE_NOT_IN_WABA);
    expect(await owner.phoneNumber.count({ where: { phoneNumberId: b.phoneNumberId } })).toBe(0);
  });

  it('surfaces Meta failures with a mapped code, storing nothing', async () => {
    const { client } = await signupOwner();
    const ids = meta.add();
    meta.failures.set(`GET /${ids.wabaId}/phone_numbers`, {
      status: 401,
      code: 190,
      message: 'Token expired',
    });
    const res = await client.post('/whatsapp/manual-connect', { accessToken: USER_TOKEN, ...ids });
    expect(res.status).toBe(502);
    expect(res.body.code).toBe(ErrorCode.WHATSAPP_META_ERROR);
    expect(res.body.details.whatsappCode).toBe(WhatsAppErrorCode.TOKEN_INVALID);
    expect(await owner.wabaAccount.count({ where: { wabaId: ids.wabaId } })).toBe(0);
  });

  it('stores nothing when subscribing to webhooks fails', async () => {
    const { client } = await signupOwner();
    const ids = meta.add();
    meta.failures.set(`POST /${ids.wabaId}/subscribed_apps`, {
      status: 403,
      code: 200,
      message: 'Permission denied',
    });
    const res = await client.post('/whatsapp/manual-connect', { accessToken: USER_TOKEN, ...ids });
    expect(res.status).toBe(502);
    expect(await owner.phoneNumber.count({ where: { phoneNumberId: ids.phoneNumberId } })).toBe(0);
  });

  it('can be turned off', async () => {
    const off = await buildApp({ env: { ALLOW_MANUAL_CONNECT: 'false' } });
    try {
      const c = new Client(off.app);
      await c.signup();
      const res = await c.post('/whatsapp/manual-connect', {
        accessToken: USER_TOKEN,
        ...meta.add(),
      });
      expect(res.status).toBe(403);
    } finally {
      await off.close();
    }
  });
});

describe('Embedded Signup', () => {
  const body = (ids: { wabaId: string; phoneNumberId: string }, code = 'signup-code-123') => ({
    code,
    ...ids,
    metaUserId: 'fb-user-77',
  });

  it('exchanges the code, subscribes, registers with an encrypted PIN, and syncs', async () => {
    const { client } = await signupOwner();
    const ids = meta.add();
    const res = await client.post('/whatsapp/embedded-signup', body(ids));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      status: 'connected',
      credentialSource: 'embedded_signup',
      qualityRating: 'GREEN',
    });

    expect(meta.calls.map((c) => `${c.method} ${c.path}`)).toEqual(
      expect.arrayContaining([
        'GET /oauth/access_token',
        `POST /${ids.wabaId}/subscribed_apps`,
        `POST /${ids.phoneNumberId}/register`,
      ]),
    );

    const row = await owner.phoneNumber.findFirstOrThrow({
      where: { phoneNumberId: ids.phoneNumberId },
      include: { wabaAccount: true },
    });
    expect(secrets.decrypt(row.accessTokenEnc!, phoneTokenAad(row.id))).toBe(
      'biz-token-for-signup-code-123',
    );
    expect(secrets.decrypt(row.registrationPinEnc!, phonePinAad(row.id))).toMatch(/^\d{6}$/);
    expect(row.registeredAt).not.toBeNull();
    expect(row.wabaAccount.metaUserId).toBe('fb-user-77');
    expect(row.wabaAccount.webhookSubscribedAt).not.toBeNull();
  });

  it('skips registration for a number already live on the Cloud API', async () => {
    const { client } = await signupOwner();
    const ids = meta.add({ status: 'CONNECTED', platform_type: 'CLOUD_API' });
    const res = await client.post('/whatsapp/embedded-signup', body(ids));
    expect(res.body.status).toBe('connected');
    expect(meta.calls.some((c) => c.path === `/${ids.phoneNumberId}/register`)).toBe(false);
  });

  it('keeps the connection when registration fails, and a retry with a PIN fixes it', async () => {
    const { client } = await signupOwner();
    const ids = meta.add();
    meta.failures.set(`POST /${ids.phoneNumberId}/register`, {
      status: 400,
      code: 133005,
      message: 'Two-step PIN mismatch',
    });
    const res = await client.post('/whatsapp/embedded-signup', body(ids));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      status: 'registration_failed',
      statusReason: expect.stringContaining('Two-step PIN mismatch'),
    });

    meta.failures.delete(`POST /${ids.phoneNumberId}/register`);
    const retry = await client.post(`/whatsapp/phone-numbers/${res.body.id}/register`, {
      pin: '123456',
    });
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ status: 'connected', statusReason: null });
    const row = await owner.phoneNumber.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(secrets.decrypt(row.registrationPinEnc!, phonePinAad(row.id))).toBe('123456');
  });

  it('reconnecting updates the existing row and the token', async () => {
    const { client } = await signupOwner();
    const ids = meta.add();
    const first = await client.post('/whatsapp/embedded-signup', body(ids, 'first-code-123'));
    const second = await client.post('/whatsapp/embedded-signup', body(ids, 'second-code-456'));
    expect(second.body.id).toBe(first.body.id);
    const row = await owner.phoneNumber.findUniqueOrThrow({ where: { id: first.body.id } });
    expect(secrets.decrypt(row.accessTokenEnc!, phoneTokenAad(row.id))).toBe(
      'biz-token-for-second-code-456',
    );
  });

  it('a failed code exchange is surfaced and stores nothing', async () => {
    const { client } = await signupOwner();
    const ids = meta.add();
    meta.failures.set('GET /oauth/access_token', {
      status: 400,
      code: 100,
      message: 'Invalid code',
    });
    try {
      const res = await client.post('/whatsapp/embedded-signup', body(ids));
      expect(res.status).toBe(502);
      expect(await owner.wabaAccount.count({ where: { wabaId: ids.wabaId } })).toBe(0);
    } finally {
      meta.failures.delete('GET /oauth/access_token');
    }
  });
});

describe('tenant isolation', () => {
  it('a number connected to one org cannot be connected by another', async () => {
    const a = await signupOwner();
    const b = await signupOwner();
    const ids = meta.add();
    await manualConnect(a.client, ids);
    const res = await b.client.post('/whatsapp/manual-connect', {
      accessToken: USER_TOKEN,
      ...ids,
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe(ErrorCode.WHATSAPP_ALREADY_CONNECTED);
    // The rejected attempt did not disturb the owner.
    const row = await owner.phoneNumber.findFirstOrThrow({
      where: { phoneNumberId: ids.phoneNumberId, status: 'connected' },
    });
    expect(row.orgId).toBe(a.orgId);
  });

  it('another org cannot see, sync, register, or disconnect a number by id', async () => {
    const a = await signupOwner();
    const b = await signupOwner();
    const { phone } = await manualConnect(a.client);

    expect((await b.client.get('/whatsapp/phone-numbers')).body).toEqual([]);
    expect((await b.client.post(`/whatsapp/phone-numbers/${phone.id}/sync`)).status).toBe(404);
    expect((await b.client.post(`/whatsapp/phone-numbers/${phone.id}/register`)).status).toBe(404);
    expect((await b.client.delete(`/whatsapp/phone-numbers/${phone.id}`)).status).toBe(404);
    const row = await owner.phoneNumber.findUniqueOrThrow({ where: { id: phone.id } });
    expect(row.status).toBe('connected');
  });

  it('a disconnected number can move to another org', async () => {
    const a = await signupOwner();
    const b = await signupOwner();
    const ids = meta.add();
    const { phone } = await manualConnect(a.client, ids);
    expect((await a.client.delete(`/whatsapp/phone-numbers/${phone.id}`)).status).toBe(204);
    const moved = await b.client.post('/whatsapp/manual-connect', {
      accessToken: USER_TOKEN,
      ...ids,
    });
    expect(moved.status).toBe(201);
  });
});

describe('permissions', () => {
  it('agents can list numbers but not manage them', async () => {
    const { client } = await signupOwner();
    const { phone } = await manualConnect(client);
    const email = uniqueEmail('agent');
    await client.post('/team/invitations', { email, role: 'agent' });
    const agent = new Client(t.app);
    await agent.post('/invitations/accept', {
      token: tokenFromMail(t.mailer, email),
      name: 'Agent',
      password: 'correct-horse-battery',
    });

    expect((await agent.get('/whatsapp/phone-numbers')).status).toBe(200);
    for (const res of [
      await agent.get('/whatsapp/config'),
      await agent.post('/whatsapp/manual-connect', { accessToken: USER_TOKEN, ...meta.add() }),
      await agent.post(`/whatsapp/phone-numbers/${phone.id}/sync`),
      await agent.delete(`/whatsapp/phone-numbers/${phone.id}`),
      await agent.get('/whatsapp/webhook-events'),
    ]) {
      expect(res.status).toBe(403);
    }
  });

  it('requires a login', async () => {
    expect((await new Client(t.app).get('/whatsapp/phone-numbers')).status).toBe(401);
  });
});

describe('sync and disconnect', () => {
  it('sync refreshes quality and tier through the cached client', async () => {
    const { client } = await signupOwner();
    const { phone, phoneNumberId } = await manualConnect(client);
    meta.setPhone(phoneNumberId, { quality_rating: 'YELLOW', messaging_limit_tier: 'TIER_2K' });
    const res = await client.post(`/whatsapp/phone-numbers/${phone.id}/sync`);
    expect(res.body).toMatchObject({ qualityRating: 'YELLOW', messagingTier: 'TIER_2K' });
  });

  it('disconnect wipes credentials, unsubscribes, and stops routing', async () => {
    const { client } = await signupOwner();
    const { phone, wabaId, phoneNumberId } = await manualConnect(client);
    expect((await client.delete(`/whatsapp/phone-numbers/${phone.id}`)).status).toBe(204);

    const row = await owner.phoneNumber.findUniqueOrThrow({ where: { id: phone.id } });
    expect(row).toMatchObject({
      status: 'disconnected',
      accessTokenEnc: null,
      registrationPinEnc: null,
    });
    expect(meta.calls).toContainEqual({
      method: 'DELETE',
      path: `/${wabaId}/subscribed_apps`,
      auth: `Bearer ${USER_TOKEN}`,
    });
    const route = await owner.$queryRaw<unknown[]>`
      SELECT * FROM webhook_route_lookup(${phoneNumberId}, ${wabaId})`;
    expect(route).toEqual([]);
    // A cached client must not survive the disconnect.
    expect((await client.post(`/whatsapp/phone-numbers/${phone.id}/sync`)).status).toBe(404);
  });

  it('a Meta outage does not block disconnecting', async () => {
    const { client } = await signupOwner();
    const { phone, wabaId } = await manualConnect(client);
    meta.failures.set(`DELETE /${wabaId}/subscribed_apps`, {
      status: 500,
      code: 1,
      message: 'Down',
    });
    expect((await client.delete(`/whatsapp/phone-numbers/${phone.id}`)).status).toBe(204);
    const row = await owner.phoneNumber.findUniqueOrThrow({ where: { id: phone.id } });
    expect(row.accessTokenEnc).toBeNull();
  });
});

describe('webhook events view and replay', () => {
  async function routedEvent(orgId: string, phoneNumberId: string) {
    await postWebhook(delivery(metaId(), phoneNumberId));
    const [event] = await eventsFor(phoneNumberId);
    await owner.$executeRaw`SELECT webhook_event_mark(${event!.id}::uuid, 'routed'::"WebhookEventStatus", ${orgId}::uuid, NULL)`;
    return event!;
  }

  it('lists routed events for the org, without raw message content', async () => {
    const { client, orgId } = await signupOwner();
    const phone = metaId();
    const event = await routedEvent(orgId, phone);
    const res = await client.get('/whatsapp/webhook-events');
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({ id: event.id, status: 'routed', field: 'messages' });
    expect(res.body.items[0].payload).toBeUndefined();
  });

  it('paginates with a cursor', async () => {
    const { client, orgId } = await signupOwner();
    for (let i = 0; i < 3; i++) await routedEvent(orgId, metaId());
    const first = await client.get('/whatsapp/webhook-events?limit=2');
    expect(first.body.items).toHaveLength(2);
    const second = await client.get(
      `/whatsapp/webhook-events?limit=2&cursor=${first.body.nextCursor}`,
    );
    expect(second.body.items).toHaveLength(1);
    expect(second.body.nextCursor).toBeNull();
  });

  it('replay resets the event and queues a new job, and is audited', async () => {
    const { client, orgId } = await signupOwner();
    const event = await routedEvent(orgId, metaId());
    const add = vi.spyOn(queues.webhookEvents, 'add');
    const res = await client.post(`/whatsapp/webhook-events/${event.id}/replay`);
    expect(res.status).toBe(202);
    expect(add).toHaveBeenCalledWith(
      'route',
      { eventId: event.id },
      expect.objectContaining({ jobId: expect.stringContaining(`${event.id}-r`) }),
    );
    add.mockRestore();
    const row = await owner.webhookEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(row.status).toBe('received');
    const logs = await client.get('/orgs/current/audit-logs');
    expect(logs.body.items.map((l: { action: string }) => l.action)).toContain(
      'whatsapp.webhook_replayed',
    );
  });

  it("another org cannot see or replay an org's events", async () => {
    const a = await signupOwner();
    const b = await signupOwner();
    const event = await routedEvent(a.orgId, metaId());
    expect((await b.client.get('/whatsapp/webhook-events')).body.items).toEqual([]);
    expect((await b.client.post(`/whatsapp/webhook-events/${event.id}/replay`)).status).toBe(404);
  });
});
