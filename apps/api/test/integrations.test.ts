/** Connections, webhooks, OAuth and the event log over real HTTP. The work itself is tested in the worker. */
import { randomUUID } from 'node:crypto';
import { buildRegistry, type ConnectorDefinition, hmacSha256 } from '@wacrm/connectors';
import { createPrismaClient, type DbClient, withTenant } from '@wacrm/db';
import { ErrorCode } from '@wacrm/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { QueuesService } from '../src/infra/queues.service';
import { buildApp, Client, type TestApp, tokenFromMail, uniqueEmail, urls } from './helpers';

/** An OAuth connector known only to this test. */
const oauthy: ConnectorDefinition = {
  key: 'oauthy',
  name: 'OAuthy',
  description: 'x',
  category: 'crm',
  auth: {
    type: 'oauth2',
    authorizeUrl: 'https://login.oauthy.test/authorize',
    tokenUrl: 'https://login.oauthy.test/token',
    scopes: ['contacts'],
    clientIdEnv: 'OAUTHY_CLIENT_ID',
    clientSecretEnv: 'OAUTHY_CLIENT_SECRET',
  },
};

let t: TestApp;
let owner: DbClient;
const tokenRequests: string[] = [];

beforeAll(async () => {
  process.env.OAUTHY_CLIENT_ID = 'client-1';
  process.env.OAUTHY_CLIENT_SECRET = 'client-secret';
  process.env.SHOPIFY_CLIENT_ID = 'shop-client';
  process.env.SHOPIFY_CLIENT_SECRET = 'shop-app-secret';
  t = await buildApp({
    connectors: buildRegistry({ demo: true, extra: [oauthy] }),
    env: { API_PUBLIC_URL: 'https://api.crm.test', WEBHOOK_ALLOW_PRIVATE_URLS: 'false' },
    fetch: (async (_url: string, init: RequestInit) => {
      tokenRequests.push(String(init.body));
      return new Response(
        JSON.stringify({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 }),
        { status: 200 },
      );
    }) as unknown as typeof fetch,
  });
  owner = createPrismaClient({ connectionString: urls.directUrl });
});
afterAll(async () => {
  await t?.close();
  await owner?.$disconnect();
  delete process.env.OAUTHY_CLIENT_ID;
  delete process.env.OAUTHY_CLIENT_SECRET;
  delete process.env.SHOPIFY_CLIENT_ID;
  delete process.env.SHOPIFY_CLIENT_SECRET;
});

async function workspace() {
  const client = new Client(t.app);
  const { orgId } = await client.signup();
  const join = async (role: 'agent' | 'admin') => {
    const email = uniqueEmail();
    await client.post('/team/invitations', { email, role });
    const member = new Client(t.app);
    await member.post('/invitations/accept', {
      token: tokenFromMail(t.mailer, email),
      name: `New ${role}`,
      password: 'correct-horse-battery',
    });
    return member;
  };
  return { client, orgId, join };
}

const demo = (c: Client, over: object = {}) =>
  c.post('/integrations/connections', {
    connectorKey: 'demo_store',
    name: 'My shop',
    credentials: { apiKey: 'k-123' },
    settings: { baseUrl: 'https://shop.example.com/api' },
    ...over,
  });

const hook = (url: string, body: string, headers: Record<string, string>) =>
  t.app.inject({
    method: 'POST',
    url: new URL(url).pathname,
    payload: body,
    headers: { 'content-type': 'application/json', ...headers },
  });

describe('connectors', () => {
  it('lists what can be connected, without code, and says when OAuth is not set up', async () => {
    const s = await workspace();
    const res = await s.client.get('/integrations/connectors');
    expect(res.body.map((c: { key: string }) => c.key)).toEqual([
      'custom_store',
      'demo_store',
      'google_sheets',
      'hubspot',
      'oauthy',
      'razorpay',
      'shopify',
      'stripe',
      'woocommerce',
    ]);
    expect(res.body.find((c: { key: string }) => c.key === 'demo_store')).toMatchObject({
      authType: 'api_key',
      receivesWebhooks: true,
      available: true,
    });
    expect(JSON.stringify(res.body)).not.toMatch(/function|=>/);
  });
});

describe('connections', () => {
  it('connects with an API key, keeps it encrypted, and shows the webhook secret once', async () => {
    const s = await workspace();
    const spy = vi.spyOn(t.app.get(QueuesService), 'enqueueIntegrationJob');
    const res = await demo(s.client);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      connectorKey: 'demo_store',
      status: 'connected',
      name: 'My shop',
    });
    expect(res.body.webhookUrl).toMatch(
      /^https:\/\/api\.crm\.test\/integrations\/hooks\/[\w-]{32}$/,
    );
    expect(res.body.webhookSecret).toMatch(/^[\w-]{32}$/);
    expect(spy).toHaveBeenCalledWith({ kind: 'health', orgId: s.orgId, connectionId: res.body.id });
    spy.mockRestore();

    const row = await owner.integrationConnection.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(row.credentialsEnc).not.toContain('k-123');
    expect(row.credentialsEnc).not.toContain(res.body.webhookSecret);
    const again = await s.client.get(`/integrations/connections/${res.body.id}`);
    expect(again.body.webhookSecret).toBeUndefined();
    expect(JSON.stringify(again.body)).not.toContain('k-123');
  });

  it('refuses missing credentials and internal addresses', async () => {
    const s = await workspace();
    const missing = await demo(s.client, { credentials: {} });
    expect(missing.status).toBe(400);
    expect(missing.body).toMatchObject({
      code: ErrorCode.INTEGRATION_INVALID,
      message: 'API key is required',
    });
    const internal = await demo(s.client, { settings: { baseUrl: 'https://127.0.0.1/api' } });
    expect(internal.status).toBe(400);
    expect((await demo(s.client, { connectorKey: 'nope' })).status).toBe(404);
    expect((await demo(s.client, { connectorKey: 'oauthy' })).status).toBe(400);
  });

  it('new credentials reconnect it and keep the webhook secret; disconnecting wipes them', async () => {
    const s = await workspace();
    const { body } = await demo(s.client);
    await owner.integrationConnection.update({
      where: { id: body.id },
      data: { status: 'needs_reconnect', lastError: 'Signed out' },
    });
    const fixed = await s.client.patch(`/integrations/connections/${body.id}`, {
      credentials: { apiKey: 'k-456' },
    });
    expect(fixed.body).toMatchObject({ status: 'connected', lastError: null });

    // The original secret still verifies webhooks.
    const raw = JSON.stringify({ type: 'order.created', order: { id: '1' } });
    const signed = await hook(body.webhookUrl, raw, {
      'x-demo-signature': `sha256=${hmacSha256(body.webhookSecret, Buffer.from(raw), 'hex')}`,
    });
    expect(signed.statusCode).toBe(200);

    const off = await s.client.post(`/integrations/connections/${body.id}/disconnect`);
    expect(off.body).toMatchObject({ status: 'disconnected', webhookUrl: null });
    const row = await owner.integrationConnection.findUniqueOrThrow({ where: { id: body.id } });
    expect(row.credentialsEnc).toBeNull();
    const gone = await hook(body.webhookUrl, raw, {});
    expect(gone.statusCode).toBe(404);
  });
});

describe('webhooks', () => {
  it('stores a signed delivery once, queues it, and refuses a bad signature', async () => {
    const s = await workspace();
    const { body } = await demo(s.client);
    const raw = JSON.stringify({ type: 'order.created', order: { id: '42' } });
    const sign = (b: string, secret = body.webhookSecret) =>
      `sha256=${hmacSha256(secret, Buffer.from(b), 'hex')}`;
    const spy = vi.spyOn(t.app.get(QueuesService), 'enqueueIntegrationJob');

    const ok = await hook(body.webhookUrl, raw, {
      'x-demo-signature': sign(raw),
      'x-demo-delivery': 'd-1',
    });
    expect(ok.statusCode).toBe(200);
    const redelivered = await hook(body.webhookUrl, raw, {
      'x-demo-signature': sign(raw),
      'x-demo-delivery': 'd-1',
    });
    expect(redelivered.statusCode).toBe(200);
    const events = await s.client.get(`/integrations/connections/${body.id}/events`);
    expect(events.body.items).toHaveLength(1);
    expect(events.body.items[0]).toMatchObject({
      direction: 'inbound',
      status: 'received',
      payload: { body: { type: 'order.created', order: { id: '42' } }, via: 'webhook' },
    });
    // Signature headers are never kept.
    expect(JSON.stringify(events.body.items[0].payload.headers)).not.toContain('sha256=');
    // Still received on the redelivery, so it is queued again in case the first enqueue was lost.
    expect(spy).toHaveBeenCalledWith({
      kind: 'event',
      orgId: s.orgId,
      eventId: events.body.items[0].id,
    });
    spy.mockRestore();

    const tampered = await hook(body.webhookUrl, `${raw} `, { 'x-demo-signature': sign(raw) });
    expect(tampered.statusCode).toBe(401);
    const wrongKey = await hook(body.webhookUrl, raw, { 'x-demo-signature': sign(raw, 'guess') });
    expect(wrongKey.statusCode).toBe(401);
    const unknown = await hook(`https://x/integrations/hooks/${'a'.repeat(32)}`, raw, {});
    expect(unknown.statusCode).toBe(404);
  });

  it('only failed or ignored incoming events can be tried again', async () => {
    const s = await workspace();
    const { body } = await demo(s.client);
    const eventId = randomUUID();
    await withTenant(owner, { orgId: s.orgId }, (tx) =>
      tx.integrationEvent.create({
        data: {
          id: eventId,
          orgId: s.orgId,
          connectionId: body.id,
          direction: 'inbound',
          dedupeKey: 'x',
          status: 'failed',
          error: 'boom',
          payload: {},
        },
      }),
    );
    const replayed = await s.client.post(`/integrations/events/${eventId}/replay`);
    expect(replayed.body).toMatchObject({ status: 'received', error: null });
    expect((await s.client.post(`/integrations/events/${eventId}/replay`)).status).toBe(409);
  });
});

describe('OAuth', () => {
  it('signs in, exchanges the code once, and stores the tokens encrypted', async () => {
    const s = await workspace();
    const start = await s.client.post('/integrations/oauth/start', {
      connectorKey: 'oauthy',
      name: 'CRM',
    });
    expect(start.status).toBe(200);
    const url = new URL(start.body.url);
    expect(url.origin).toBe('https://login.oauthy.test');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://api.crm.test/integrations/oauth/callback',
    );
    const state = url.searchParams.get('state')!;

    const back = await t.app.inject({
      method: 'GET',
      url: `/integrations/oauth/callback?code=c-1&state=${state}`,
    });
    expect(back.statusCode).toBe(302);
    expect(back.headers.location).toMatch(
      /^http:\/\/localhost:3000\/integrations\/[\w-]+\?connected=1$/,
    );
    expect(new URLSearchParams(tokenRequests.at(-1)).get('code')).toBe('c-1');
    const conns = await s.client.get('/integrations/connections');
    expect(conns.body).toHaveLength(1);
    expect(conns.body[0]).toMatchObject({
      connectorKey: 'oauthy',
      name: 'CRM',
      status: 'connected',
    });
    expect(new Date(conns.body[0].tokenExpiresAt).getTime()).toBeGreaterThan(Date.now());
    const row = await owner.integrationConnection.findFirstOrThrow({ where: { orgId: s.orgId } });
    expect(row.credentialsEnc).not.toContain('at-1');

    // The state works once.
    const replay = await t.app.inject({
      method: 'GET',
      url: `/integrations/oauth/callback?code=c-2&state=${state}`,
    });
    expect(replay.headers.location).toContain('error=');
    const forged = await t.app.inject({
      method: 'GET',
      url: '/integrations/oauth/callback?code=c&state=forged',
    });
    expect(forged.headers.location).toContain('error=');
    expect((await s.client.get('/integrations/connections')).body).toHaveLength(1);
  });

  it('a provider refusal comes back as a message, and creates nothing', async () => {
    const s = await workspace();
    const start = await s.client.post('/integrations/oauth/start', {
      connectorKey: 'oauthy',
      name: 'CRM',
    });
    const state = new URL(start.body.url).searchParams.get('state')!;
    const denied = await t.app.inject({
      method: 'GET',
      url: `/integrations/oauth/callback?error=access_denied&state=${state}`,
    });
    expect(denied.headers.location).toContain('error=access_denied');
    expect((await s.client.get('/integrations/connections')).body).toEqual([]);
  });
});

describe('access', () => {
  it('agents cannot manage integrations, and another workspace sees nothing', async () => {
    const a = await workspace();
    const b = await workspace();
    const agent = await a.join('agent');
    expect((await agent.get('/integrations/connections')).status).toBe(403);
    const { body } = await demo(a.client);
    expect((await b.client.get(`/integrations/connections/${body.id}`)).status).toBe(404);
    expect((await b.client.get('/integrations/connections')).body).toEqual([]);
    expect((await b.client.post(`/integrations/connections/${body.id}/disconnect`)).status).toBe(
      404,
    );
  });

  it('connecting needs the integrations feature; reading does not', async () => {
    const s = await workspace();
    const { body } = await demo(s.client);
    await owner.$executeRaw`
      UPDATE subscriptions SET plan_id = (SELECT id FROM plans WHERE code = 'starter'),
             status = 'active', trial_ends_at = NULL
      WHERE org_id = ${s.orgId}::uuid`;
    const refused = await demo(s.client);
    expect(refused.status).toBe(402);
    expect(refused.body.code).toBe(ErrorCode.PLAN_FEATURE_UNAVAILABLE);
    expect((await s.client.get(`/integrations/connections/${body.id}`)).status).toBe(200);
  });
});

describe('Shopify', () => {
  const connectShop = async (c: Client, shop: string) => {
    const start = await c.post('/integrations/oauth/start', {
      connectorKey: 'shopify',
      name: 'Shop',
      settings: { shop },
    });
    if (start.status !== 200) return { start };
    const state = new URL(start.body.url).searchParams.get('state')!;
    await t.app.inject({
      method: 'GET',
      url: `/integrations/oauth/callback?code=c&state=${state}`,
    });
    return { start };
  };

  it('installs by OAuth on the shop the owner names, written however they like', async () => {
    const s = await workspace();
    const spy = vi.spyOn(t.app.get(QueuesService), 'enqueueIntegrationJob');
    const { start } = await connectShop(s.client, 'https://Chai-House.myshopify.com/admin');
    const url = new URL(start.body.url);
    expect(url.origin).toBe('https://chai-house.myshopify.com');
    expect(url.pathname).toBe('/admin/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('shop-client');
    const conns = await s.client.get('/integrations/connections');
    expect(conns.body[0]).toMatchObject({
      connectorKey: 'shopify',
      settings: { shop: 'chai-house.myshopify.com' },
    });
    // Webhooks are registered by the worker, then the connection is checked.
    expect(spy.mock.calls.map((c) => (c[0] as { kind: string }).kind)).toEqual(['setup', 'health']);
    spy.mockRestore();

    const bad = await s.client.post('/integrations/oauth/start', {
      connectorKey: 'shopify',
      name: 'Shop',
      settings: { shop: 'evil.example.com' },
    });
    expect(bad.status).toBe(400);
  });

  it('per-shop webhooks are signed with the app secret; privacy webhooks find the shop', async () => {
    const s = await workspace();
    const shop = `s${randomUUID().slice(0, 8)}.myshopify.com`;
    await connectShop(s.client, shop);
    const [conn] = (await s.client.get('/integrations/connections')).body;
    const sign = (b: string, secret = 'shop-app-secret') =>
      hmacSha256(secret, Buffer.from(b), 'base64');

    const order = JSON.stringify({ id: 1, name: '#1001' });
    const ok = await hook(conn.webhookUrl, order, {
      'x-shopify-topic': 'orders/create',
      'x-shopify-hmac-sha256': sign(order),
      'x-shopify-webhook-id': 'w-1',
    });
    expect(ok.statusCode).toBe(200);
    const forged = await hook(conn.webhookUrl, order, {
      'x-shopify-topic': 'orders/create',
      'x-shopify-hmac-sha256': sign(order, 'guess'),
    });
    expect(forged.statusCode).toBe(401);

    const redact = JSON.stringify({ shop_id: 1, shop_domain: shop, customer: { id: 7 } });
    const app = (body: string, hmac: string) =>
      t.app.inject({
        method: 'POST',
        url: '/integrations/apps/shopify/hooks',
        payload: body,
        headers: {
          'content-type': 'application/json',
          'x-shopify-topic': 'customers/redact',
          'x-shopify-hmac-sha256': hmac,
        },
      });
    expect((await app(redact, sign(redact))).statusCode).toBe(200);
    expect((await app(redact, sign(redact, 'guess'))).statusCode).toBe(401);
    // A shop nobody connected is acknowledged, and stored nowhere.
    const stranger = JSON.stringify({ shop_domain: 'nobody.myshopify.com' });
    expect((await app(stranger, sign(stranger))).statusCode).toBe(200);
    const unknownApp = await t.app.inject({
      method: 'POST',
      url: '/integrations/apps/nope/hooks',
      payload: '{}',
      headers: { 'content-type': 'application/json' },
    });
    expect(unknownApp.statusCode).toBe(404);

    const events = await s.client.get(`/integrations/connections/${conn.id}/events`);
    expect(
      events.body.items.map((e: { payload: { via: string } }) => e.payload.via).sort(),
    ).toEqual(['app_webhook', 'webhook']);
  });
});
