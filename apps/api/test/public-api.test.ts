/** API keys, /v1, OpenAPI and managing webhooks, over real HTTP. Meta is faked. */
import { randomBytes, randomUUID } from 'node:crypto';
import {
  createPrismaClient,
  type DbClient,
  creditWallet,
  ensureWallet,
  withTenant,
} from '@wacrm/db';
import { API_SCOPES, type ApiScope, ErrorCode } from '@wacrm/shared';
import { phoneTokenAad, SecretBox, webhookSecretAad } from '@wacrm/shared/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { QueuesService } from '../src/infra/queues.service';
import { buildApp, Client, type TestApp, tokenFromMail, uniqueEmail, urls } from './helpers';

const ENCRYPTION_KEY = randomBytes(32).toString('base64');
const secrets = new SecretBox(ENCRYPTION_KEY);
const metaId = () => String(Math.floor(Math.random() * 1e15) + 1e15);
const CURRENCY = 'XPB';
const RATE = 1_000_000;

let t: TestApp;
let owner: DbClient;

beforeAll(async () => {
  t = await buildApp({
    env: {
      ENCRYPTION_KEY,
      WALLET_DEFAULT_CURRENCY: CURRENCY,
      WALLET_LOW_BALANCE_DEFAULT: '0',
      API_RATE_LIMIT_PER_MINUTE: '40',
    },
    graph: { apiVersion: 'v25.0', fetch: (async () => new Response('{}')) as typeof fetch },
  });
  owner = createPrismaClient({ connectionString: urls.directUrl });
  await owner.rateCard.createMany({
    data: [
      {
        country: '*',
        category: 'utility',
        currency: CURRENCY,
        rateMicros: BigInt(RATE),
        validFrom: new Date('2026-01-01'),
      },
    ],
    skipDuplicates: true,
  });
});
afterAll(async () => {
  await t?.close();
  await owner?.$disconnect();
});

async function workspace(opts: { numbers?: number } = {}) {
  const client = new Client(t.app);
  const { orgId, userId } = await client.signup();
  const ids = await withTenant(owner, { orgId }, async (tx) => {
    const waba = await tx.wabaAccount.create({
      data: { orgId, wabaId: metaId(), templatesSyncedAt: new Date() },
    });
    const phones: string[] = [];
    for (let i = 0; i < (opts.numbers ?? 1); i++) {
      const id = randomUUID();
      await tx.phoneNumber.create({
        data: {
          id,
          orgId,
          wabaAccountId: waba.id,
          phoneNumberId: metaId(),
          status: 'connected',
          credentialSource: 'manual',
          accessTokenEnc: secrets.encrypt('token', phoneTokenAad(id)),
        },
      });
      phones.push(id);
    }
    const template = await tx.messageTemplate.create({
      data: {
        orgId,
        wabaAccountId: waba.id,
        name: 'order_ready',
        language: 'en',
        category: 'UTILITY',
        status: 'approved',
        metaTemplateId: metaId(),
        definition: { header: null, body: 'Hi {{1}}, it is ready.', footer: null, buttons: [] },
      },
    });
    await ensureWallet(tx, orgId, CURRENCY, null);
    await creditWallet(tx, { orgId, amountMicros: 100 * RATE, idempotencyKey: 'seed' });
    return { phoneId: phones[0]!, templateId: template.id };
  });
  const makeKey = async (scopes: readonly ApiScope[] = API_SCOPES, over: object = {}) => {
    const res = await client.post('/api-keys', { name: 'Test key', scopes, ...over });
    expect(res.status).toBe(201);
    return res.body as { id: string; key: string; prefix: string };
  };
  return { client, orgId, userId, makeKey, ...ids };
}

const call = (
  key: string | undefined,
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  body?: object,
) =>
  t.app
    .inject({
      method,
      url,
      headers: key ? { authorization: `Bearer ${key}` } : {},
      ...(body ? { payload: body } : {}),
    })
    .then((res) => ({
      status: res.statusCode,
      headers: res.headers,
      body: res.body ? (JSON.parse(res.body) as Record<string, any>) : {}, // eslint-disable-line @typescript-eslint/no-explicit-any -- test convenience
    }));

describe('API keys', () => {
  it('shows the key once, stores only a hash, and lists it without the secret', async () => {
    const s = await workspace();
    const created = await s.makeKey(['contacts:read']);
    expect(created.key).toMatch(/^wak_[a-f0-9]{16}_[\w-]{40,}$/);
    const row = await owner.apiKey.findFirstOrThrow({ where: { id: created.id } });
    expect(row.keyHash).not.toContain(created.key);
    expect(JSON.stringify(row)).not.toContain(created.key.split('_')[2]);

    const list = await s.client.get('/api-keys');
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ id: created.id, scopes: ['contacts:read'] });
    expect(JSON.stringify(list.body)).not.toContain(created.key);
    expect(list.body[0].key).toBeUndefined();
  });

  it('refuses no key, a wrong key, and a tampered key, all the same way', async () => {
    const s = await workspace();
    const { key } = await s.makeKey();
    const attempts = [
      undefined,
      'nonsense',
      'wak_0000000000000000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      `${key.slice(0, -1)}${key.endsWith('a') ? 'b' : 'a'}`,
    ];
    for (const attempt of attempts) {
      const res = await call(attempt, 'GET', '/v1/contacts');
      expect(res.status).toBe(401);
      expect(res.body.message).toBe(attempt ? 'Invalid API key' : 'Invalid API key');
    }
  });

  it('a session token does not work on /v1, and a key does not work on the dashboard API', async () => {
    const s = await workspace();
    const { key } = await s.makeKey();
    expect((await call(s.client.accessToken, 'GET', '/v1/contacts')).status).toBe(401);
    expect((await call(key, 'GET', '/contacts')).status).toBe(401);
    expect((await call(key, 'GET', '/api-keys')).status).toBe(401);
    expect(
      (await call(key, 'POST', '/api-keys', { name: 'x', scopes: ['tags:read'] })).status,
    ).toBe(401);
  });

  it('revoking takes effect at once, and is audited', async () => {
    const s = await workspace();
    const { id, key } = await s.makeKey();
    expect((await call(key, 'GET', '/v1/contacts')).status).toBe(200);
    expect((await s.client.delete(`/api-keys/${id}`)).status).toBe(200);
    expect((await call(key, 'GET', '/v1/contacts')).status).toBe(401);
    const log = await s.client.get('/orgs/current/audit-logs');
    const actions = log.body.items.map((i: { action: string }) => i.action);
    expect(actions).toEqual(expect.arrayContaining(['api_key.created', 'api_key.revoked']));
  });

  it('an expired key stops working', async () => {
    const s = await workspace();
    const { id, key } = await s.makeKey(API_SCOPES, { expiresInDays: 1 });
    expect((await call(key, 'GET', '/v1/contacts')).status).toBe(200);
    await owner.apiKey.update({ where: { id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await call(key, 'GET', '/v1/contacts')).status).toBe(401);
  });

  it('enforces scopes', async () => {
    const s = await workspace();
    const { key } = await s.makeKey(['contacts:read']);
    expect((await call(key, 'GET', '/v1/contacts')).status).toBe(200);
    const denied = await call(key, 'POST', '/v1/contacts', { phone: '+919876543210' });
    expect(denied.status).toBe(403);
    expect(denied.body.details.missing).toEqual(['contacts:write']);
    expect((await call(key, 'GET', '/v1/templates')).status).toBe(403);
    expect((await call(key, 'POST', '/v1/messages', {})).status).toBe(403);
  });

  it('records when it was last used, without a write on every request', async () => {
    const s = await workspace();
    const { id, key } = await s.makeKey();
    await call(key, 'GET', '/v1/contacts');
    const first = await owner.apiKey.findUniqueOrThrow({ where: { id } });
    expect(first.lastUsedAt).toBeInstanceOf(Date);
    await call(key, 'GET', '/v1/contacts');
    const second = await owner.apiKey.findUniqueOrThrow({ where: { id } });
    expect(second.lastUsedAt).toEqual(first.lastUsedAt);
  });

  it('limits requests per key, and says so in headers', async () => {
    const s = await workspace();
    const { key } = await s.makeKey();
    const other = await s.makeKey();
    const first = await call(key, 'GET', '/v1/tags');
    expect(first.headers['x-ratelimit-limit']).toBe('40');
    expect(first.headers['x-ratelimit-remaining']).toBe('39');
    let last = first;
    for (let i = 0; i < 40; i++) last = await call(key, 'GET', '/v1/tags');
    expect(last.status).toBe(429);
    expect(last.body.code).toBe(ErrorCode.RATE_LIMITED);
    expect(last.headers['retry-after']).toBe('60');
    // Another key is counted separately.
    expect((await call(other.key, 'GET', '/v1/tags')).status).toBe(200);
  });

  it('a plan without the public API cannot make or use keys', async () => {
    const s = await workspace();
    const { key } = await s.makeKey();
    const starter = await owner.plan.findUniqueOrThrow({ where: { code: 'starter' } });
    await owner.subscription.update({
      where: { orgId: s.orgId },
      data: { planId: starter.id, status: 'active', trialEndsAt: null },
    });
    const use = await call(key, 'GET', '/v1/contacts');
    expect(use.status).toBe(402);
    expect(use.body.code).toBe(ErrorCode.PLAN_FEATURE_UNAVAILABLE);
    const make = await s.client.post('/api-keys', { name: 'x', scopes: ['tags:read'] });
    expect(make.status).toBe(402);
  });

  it('only owners and admins manage keys', async () => {
    const s = await workspace();
    const email = uniqueEmail();
    await s.client.post('/team/invitations', { email, role: 'agent' });
    const agent = new Client(t.app);
    await agent.post('/invitations/accept', {
      token: tokenFromMail(t.mailer, email),
      name: 'Agent',
      password: 'correct-horse-battery',
    });
    expect((await agent.get('/api-keys')).status).toBe(403);
    expect((await agent.post('/api-keys', { name: 'x', scopes: ['tags:read'] })).status).toBe(403);
    expect((await agent.get('/webhook-endpoints')).status).toBe(403);
  });
});

describe('contacts and tags', () => {
  it('create, read, change, consent and tags', async () => {
    const s = await workspace();
    const { key } = await s.makeKey();
    const created = await call(key, 'POST', '/v1/contacts', {
      phone: '+91 98765 43210',
      name: 'Asha',
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      waId: '919876543210',
      name: 'Asha',
      optInStatus: 'unknown',
    });
    const id = created.body.id as string;

    expect((await call(key, 'GET', `/v1/contacts/${id}`)).body.name).toBe('Asha');
    const changed = await call(key, 'PATCH', `/v1/contacts/${id}`, { name: 'Asha Rao' });
    expect(changed.body.name).toBe('Asha Rao');

    const noProof = await call(key, 'POST', `/v1/contacts/${id}/consent`, { status: 'opted_in' });
    expect(noProof.status).toBe(400);
    const consent = await call(key, 'POST', `/v1/contacts/${id}/consent`, {
      status: 'opted_in',
      source: 'Website form',
      proof: 'Submission 1042',
    });
    expect(consent.body.optInStatus).toBe('opted_in');

    const tag = await call(key, 'POST', '/v1/tags', { name: 'VIP' });
    expect(tag.status).toBe(201);
    const tagged = await call(key, 'POST', `/v1/contacts/${id}/tags`, { tagIds: [tag.body.id] });
    expect(tagged.body.tags).toEqual([{ id: tag.body.id, name: 'VIP' }]);
    expect((await call(key, 'GET', '/v1/tags')).body).toHaveLength(1);

    const list = await call(key, 'GET', '/v1/contacts?q=Asha');
    expect(list.body.items.map((c: { id: string }) => c.id)).toEqual([id]);
    expect(list.body.nextCursor).toBeNull();
  });

  it('returns only the public shape', async () => {
    const s = await workspace();
    const { key } = await s.makeKey();
    const { body } = await call(key, 'POST', '/v1/contacts', { phone: '+919876543210' });
    expect(Object.keys(body).sort()).toEqual(
      [
        'createdAt',
        'customFields',
        'email',
        'id',
        'lastActivityAt',
        'name',
        'optInStatus',
        'tags',
        'waId',
      ].sort(),
    );
  });

  it('plan limits apply', async () => {
    const s = await workspace();
    const { key } = await s.makeKey();
    const growth = await owner.plan.findUniqueOrThrow({ where: { code: 'growth' } });
    await owner.plan.update({ where: { id: growth.id }, data: { contacts: 0 } });
    const res = await call(key, 'POST', '/v1/contacts', { phone: '+919876543210' });
    await owner.plan.update({ where: { id: growth.id }, data: { contacts: 25000 } });
    expect(res.status).toBe(402);
  });
});

describe('another workspace', () => {
  it('sees nothing, by any route', async () => {
    const a = await workspace();
    const b = await workspace();
    const keyA = (await a.makeKey()).key;
    const keyB = (await b.makeKey()).key;
    const contact = await call(keyA, 'POST', '/v1/contacts', { phone: '+919876543210' });
    const message = await call(keyA, 'POST', '/v1/messages', {
      to: '+919876543210',
      type: 'template',
      templateId: a.templateId,
      variables: { 'body.1': 'Asha' },
    });

    expect((await call(keyB, 'GET', `/v1/contacts/${contact.body.id}`)).status).toBe(404);
    expect((await call(keyB, 'GET', '/v1/contacts')).body.items).toEqual([]);
    expect((await call(keyB, 'GET', `/v1/templates/${a.templateId}`)).status).toBe(404);
    expect((await call(keyB, 'GET', '/v1/conversations')).body.items).toEqual([]);
    expect(
      (await call(keyB, 'GET', `/v1/conversations/${message.body.conversationId}`)).status,
    ).toBe(404);
    expect(
      (await call(keyB, 'GET', `/v1/conversations/${message.body.conversationId}/messages`)).status,
    ).toBe(404);
    const crossSend = await call(keyB, 'POST', '/v1/messages', {
      to: '+919876543210',
      type: 'template',
      templateId: a.templateId,
    });
    expect(crossSend.status).toBe(404);
  });
});

describe('sending', () => {
  const template = (s: { templateId: string }, over: object = {}) => ({
    to: '+919876543210',
    type: 'template',
    templateId: s.templateId,
    variables: { 'body.1': 'Asha' },
    ...over,
  });

  it('sends a template to a new number: contact, thread, queue and charge', async () => {
    const spy = vi.spyOn(t.app.get(QueuesService), 'enqueueOutbound');
    const s = await workspace();
    const { key } = await s.makeKey();
    const res = await call(key, 'POST', '/v1/messages', template(s));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      direction: 'outbound',
      type: 'template',
      status: 'queued',
      body: 'Hi Asha, it is ready.',
    });
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();

    const contact = await withTenant(owner, { orgId: s.orgId }, (tx) =>
      tx.contact.findFirstOrThrow({ where: { orgId: s.orgId, waId: '919876543210' } }),
    );
    expect(contact.optInStatus).toBe('unknown');
    const thread = await call(key, 'GET', `/v1/conversations/${res.body.conversationId}`);
    expect(thread.body).toMatchObject({ status: 'closed', contact: { id: contact.id } });
    expect((await s.client.get('/wallet')).body.balanceMicros).toBe(99 * RATE);
  });

  it('finds a template by name and language', async () => {
    const s = await workspace();
    const { key } = await s.makeKey();
    const res = await call(key, 'POST', '/v1/messages', {
      to: '+919876543210',
      type: 'template',
      templateName: 'order_ready',
      language: 'en',
      variables: { 'body.1': 'Asha' },
    });
    expect(res.status).toBe(201);
    const missing = await call(key, 'POST', '/v1/messages', {
      to: '+919876543210',
      type: 'template',
      templateName: 'order_ready',
      language: 'fr',
    });
    expect(missing.status).toBe(404);
  });

  it('the same idempotency key sends and charges once', async () => {
    const s = await workspace();
    const { key } = await s.makeKey();
    const body = template(s, { idempotencyKey: 'order-1042' });
    const first = await call(key, 'POST', '/v1/messages', body);
    const second = await call(key, 'POST', '/v1/messages', body);
    expect(second.body.id).toBe(first.body.id);
    expect((await s.client.get('/wallet')).body.balanceMicros).toBe(99 * RATE);
  });

  it('text outside the 24-hour window is refused', async () => {
    const s = await workspace();
    const { key } = await s.makeKey();
    const res = await call(key, 'POST', '/v1/messages', {
      to: '+919876543210',
      type: 'text',
      body: 'Hello',
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe(ErrorCode.WINDOW_CLOSED);
  });

  it('text inside the window goes, with no sender, so it is not counted as a person replying', async () => {
    const s = await workspace();
    const { key } = await s.makeKey();
    const conversation = await withTenant(owner, { orgId: s.orgId }, async (tx) => {
      const contact = await tx.contact.create({ data: { orgId: s.orgId, waId: '919876543210' } });
      return tx.conversation.create({
        data: {
          orgId: s.orgId,
          phoneId: s.phoneId,
          contactId: contact.id,
          windowExpiresAt: new Date(Date.now() + 3_600_000),
        },
      });
    });
    const res = await call(key, 'POST', '/v1/messages', {
      to: '+919876543210',
      type: 'text',
      body: 'Hello',
    });
    expect(res.status).toBe(201);
    expect(res.body.conversationId).toBe(conversation.id);
    const row = await withTenant(owner, { orgId: s.orgId }, (tx) =>
      tx.message.findFirstOrThrow({ where: { conversationId: conversation.id } }),
    );
    expect(row.senderUserId).toBeNull();
  });

  it('with several numbers, you must say which', async () => {
    const s = await workspace({ numbers: 2 });
    const { key } = await s.makeKey();
    const res = await call(key, 'POST', '/v1/messages', template(s));
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('phoneNumberId');
    const chosen = await call(
      key,
      'POST',
      '/v1/messages',
      template(s, { phoneNumberId: s.phoneId }),
    );
    expect(chosen.status).toBe(201);
  });

  it('bad input is refused with a reason', async () => {
    const s = await workspace();
    const { key } = await s.makeKey();
    const send = (body: object) => call(key, 'POST', '/v1/messages', body);
    expect((await send({ to: 'x', type: 'text', body: 'Hi' })).status).toBe(400);
    expect((await send({ to: 'not a number!', type: 'text', body: 'Hi' })).status).toBe(400);
    expect((await send({ to: '+919876543210', type: 'text' })).status).toBe(400);
    expect((await send({ to: '+919876543210', type: 'template' })).status).toBe(400);
  });

  it('reads messages back, without internal notes', async () => {
    const s = await workspace();
    const { key } = await s.makeKey();
    const sent = await call(key, 'POST', '/v1/messages', template(s));
    await s.client.post(`/inbox/conversations/${sent.body.conversationId}/notes`, {
      clientMessageId: randomUUID(),
      body: 'Private note',
    });
    const list = await call(key, 'GET', `/v1/conversations/${sent.body.conversationId}/messages`);
    expect(list.status).toBe(200);
    expect(list.body.items.map((m: { id: string }) => m.id)).toEqual([sent.body.id]);
    expect(JSON.stringify(list.body)).not.toContain('Private note');
  });
});

describe('templates and campaigns', () => {
  it('lists templates with their variables', async () => {
    const s = await workspace();
    const { key } = await s.makeKey();
    const { body } = await call(key, 'GET', '/v1/templates');
    expect(body.items[0]).toEqual({
      id: s.templateId,
      name: 'order_ready',
      language: 'en',
      category: 'UTILITY',
      status: 'approved',
      sendable: true,
      body: 'Hi {{1}}, it is ready.',
      variables: ['body.1'],
    });
  });

  it('creates, schedules, reports and cancels a campaign', async () => {
    const s = await workspace();
    const { key } = await s.makeKey();
    const draft = await call(key, 'POST', '/v1/campaigns', {
      name: 'Sale',
      phoneId: s.phoneId,
      templateId: s.templateId,
    });
    expect(draft.status).toBe(201);
    const id = draft.body.id as string;
    const launched = await call(key, 'POST', `/v1/campaigns/${id}/launch`, {
      when: 'scheduled',
      localTime: '2099-01-15T09:00',
      timezone: 'Asia/Kolkata',
    });
    expect(launched.body).toMatchObject({
      status: 'scheduled',
      scheduledAt: '2099-01-15T03:30:00.000Z',
    });
    const report = await call(key, 'GET', `/v1/campaigns/${id}`);
    expect(report.body).toMatchObject({ counts: { total: 0 }, costMicros: 0, currency: CURRENCY });
    expect((await call(key, 'POST', `/v1/campaigns/${id}/cancel`)).body.status).toBe('cancelled');
    expect((await call(key, 'GET', '/v1/campaigns')).body.items).toHaveLength(1);
  });

  it('a plan without campaigns cannot start one through the API either', async () => {
    const s = await workspace();
    const { key } = await s.makeKey();
    const noCampaigns = await owner.plan.create({
      data: {
        code: `api_only_${randomUUID().slice(0, 8)}`,
        name: 'API only',
        features: ['public_api'],
        isPublic: false,
      },
    });
    await owner.subscription.update({
      where: { orgId: s.orgId },
      data: { planId: noCampaigns.id, status: 'active', trialEndsAt: null },
    });
    const res = await call(key, 'POST', '/v1/campaigns', {
      name: 'Sale',
      phoneId: s.phoneId,
      templateId: s.templateId,
    });
    expect(res.status).toBe(402);
    expect(res.body.details.feature).toBe('campaigns');
    expect((await call(key, 'GET', '/v1/campaigns')).status).toBe(200);
  });
});

describe('OpenAPI', () => {
  it('is published, generated from the controllers, and covers every resource', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/v1/openapi.json' });
    expect(res.statusCode).toBe(200);
    const doc = JSON.parse(res.body);
    expect(doc.info.title).toBe('WhatsApp CRM API');
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining([
        '/v1/contacts',
        '/v1/contacts/{id}',
        '/v1/conversations',
        '/v1/conversations/{id}/messages',
        '/v1/messages',
        '/v1/templates',
        '/v1/campaigns',
        '/v1/tags',
      ]),
    );
    // Nothing from the dashboard's own API.
    expect(Object.keys(doc.paths).every((p) => p.startsWith('/v1/'))).toBe(true);
    const send = doc.paths['/v1/messages'].post;
    expect(send.requestBody.content['application/json'].schema.properties.to).toBeDefined();
    expect(
      send.responses['201'].content['application/json'].schema.properties.status,
    ).toBeDefined();
    expect(send.responses['429']).toBeDefined();
  });

  it('the docs page opens with no key', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/v1/docs' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('swagger');
  });
});

describe('webhook endpoints', () => {
  const create = (s: { client: Client }, over: object = {}) =>
    s.client.post('/webhook-endpoints', {
      url: 'https://example.com/hook',
      events: ['message.received'],
      ...over,
    });

  it('shows the secret once, and stores it encrypted', async () => {
    const s = await workspace();
    const res = await create(s);
    expect(res.status).toBe(201);
    expect(res.body.secret).toMatch(/^whsec_/);
    const row = await owner.webhookEndpoint.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(row.secretEnc).not.toContain(res.body.secret);
    expect(secrets.decrypt(row.secretEnc, webhookSecretAad(row.id))).toBe(res.body.secret);

    const list = await s.client.get('/webhook-endpoints');
    expect(JSON.stringify(list.body)).not.toContain(res.body.secret);
    expect(JSON.stringify(list.body)).not.toContain('secretEnc');
  });

  it.each([
    ['http://example.com/hook'],
    ['https://localhost/hook'],
    ['https://169.254.169.254/latest/meta-data'],
    ['https://10.0.0.5/hook'],
    ['https://[::1]/hook'],
  ])('refuses %s', async (url) => {
    const s = await workspace();
    const res = await create(s, { url });
    expect(res.status).toBe(400);
    const patch = await create(s);
    const changed = await s.client.patch(`/webhook-endpoints/${patch.body.id}`, { url });
    expect(changed.status).toBe(400);
  });

  it('refuses an unknown event, and no events', async () => {
    const s = await workspace();
    expect((await create(s, { events: ['nonsense'] })).status).toBe(400);
    expect((await create(s, { events: [] })).status).toBe(400);
  });

  it('rotating replaces the secret', async () => {
    const s = await workspace();
    const { body } = await create(s);
    const rotated = await s.client.post(`/webhook-endpoints/${body.id}/rotate-secret`);
    expect(rotated.body.secret).not.toBe(body.secret);
    const row = await owner.webhookEndpoint.findUniqueOrThrow({ where: { id: body.id } });
    expect(secrets.decrypt(row.secretEnc, webhookSecretAad(row.id))).toBe(rotated.body.secret);
  });

  it('a change made through /v1 creates an event, and a test can be sent', async () => {
    const s = await workspace();
    const { body } = await create(s, { events: ['contact.created'] });
    const { key } = await s.makeKey();
    await call(key, 'POST', '/v1/contacts', { phone: '+919876543210', name: 'Asha' });
    await s.client.post(`/webhook-endpoints/${body.id}/test`);
    const log = await s.client.get(`/webhook-endpoints/${body.id}/deliveries`);
    const types = log.body.items.map((d: { eventType: string }) => d.eventType).sort();
    expect(types).toEqual(['contact.created', 'webhook.test']);
    expect(log.body.items.every((d: { status: string }) => d.status === 'pending')).toBe(true);
  });

  it('replaying adds a new delivery with the same event id, and keeps the first in the log', async () => {
    const s = await workspace();
    const { body } = await create(s);
    await s.client.post(`/webhook-endpoints/${body.id}/test`);
    const [first] = (await s.client.get(`/webhook-endpoints/${body.id}/deliveries`)).body.items;
    await owner.webhookDelivery.update({
      where: { id: first.id },
      data: { status: 'failed', nextAttemptAt: null, error: 'Down' },
    });
    const replay = await s.client.post(
      `/webhook-endpoints/${body.id}/deliveries/${first.id}/replay`,
    );
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({
      eventId: first.eventId,
      status: 'pending',
      attempts: 0,
      replayOfId: first.id,
    });
    const log = await s.client.get(`/webhook-endpoints/${body.id}/deliveries?status=failed`);
    expect(log.body.items.map((d: { id: string }) => d.id)).toEqual([first.id]);
  });

  it('another workspace cannot see, change or replay it', async () => {
    const s = await workspace();
    const other = await workspace();
    const { body } = await create(s);
    await s.client.post(`/webhook-endpoints/${body.id}/test`);
    const [delivery] = (await s.client.get(`/webhook-endpoints/${body.id}/deliveries`)).body.items;
    expect((await other.client.get('/webhook-endpoints')).body).toEqual([]);
    const attempts = [
      other.client.get(`/webhook-endpoints/${body.id}/deliveries`),
      other.client.patch(`/webhook-endpoints/${body.id}`, { active: false }),
      other.client.delete(`/webhook-endpoints/${body.id}`),
      other.client.post(`/webhook-endpoints/${body.id}/rotate-secret`),
      other.client.post(`/webhook-endpoints/${body.id}/test`),
      other.client.post(`/webhook-endpoints/${body.id}/deliveries/${delivery.id}/replay`),
    ];
    for (const res of await Promise.all(attempts)) expect(res.status).toBe(404);
    expect((await s.client.get('/webhook-endpoints')).body[0].active).toBe(true);
  });

  it('deleting removes it, with its log', async () => {
    const s = await workspace();
    const { body } = await create(s);
    await s.client.post(`/webhook-endpoints/${body.id}/test`);
    expect((await s.client.delete(`/webhook-endpoints/${body.id}`)).status).toBe(204);
    expect(await owner.webhookDelivery.count({ where: { endpointId: body.id } })).toBe(0);
  });
});
