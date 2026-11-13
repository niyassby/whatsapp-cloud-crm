/**
 * Phase 4.2 over HTTP: website chat end to end, Instagram connect and webhooks, the WhatsApp
 * modules against a scripted Graph, every module's plan flag, and isolation between workspaces.
 */
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createPrismaClient, type DbClient, withTenant } from '@wacrm/db';
import { ErrorCode, type PlanFeature } from '@wacrm/shared';
import { phoneTokenAad, SecretBox } from '@wacrm/shared/server';
import { InstagramClient } from '@wacrm/whatsapp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, Client, type TestApp, urls } from './helpers';

const ENCRYPTION_KEY = randomBytes(32).toString('base64');
const IG_SECRET = 'ig-app-secret-for-tests';
const secrets = new SecretBox(ENCRYPTION_KEY);
const metaId = () => String(Math.floor(Math.random() * 1e15) + 1e15);

/** Every Graph request the WhatsApp gateway makes, answered as Meta would. */
const graphCalls: { method: string; path: string; body: unknown }[] = [];
const graphFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const method = init?.method ?? 'GET';
  const path = url.pathname.replace(/^\/v\d+\.\d+/, '');
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
  graphCalls.push({ method, path, body });
  const json = (data: unknown) =>
    new Response(JSON.stringify(data), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  if (path.endsWith('/message_qrdls') && method === 'POST') {
    const code = `QR${randomUUID().slice(0, 8).toUpperCase()}`;
    return json({
      code,
      prefilled_message: body.prefilled_message,
      deep_link_url: `https://wa.me/message/${code}`,
    });
  }
  if (path.includes('/message_qrdls/')) return json({ success: true });
  if (path.endsWith('/product_catalogs')) return json({ data: [{ id: 'cat-1', name: 'Shop' }] });
  if (path === '/cat-1/products') {
    return json({
      data: [
        { id: '1', retailer_id: 'SKU-1', name: 'Mango pickle', price: '₹199.00', currency: 'INR' },
        { id: '2', retailer_id: 'SKU-2', name: 'Lime pickle', price: '₹149.00', currency: 'INR' },
      ],
      paging: { cursors: {} },
    });
  }
  if (path.endsWith('/groups') && method === 'POST')
    return json({ messaging_product: 'whatsapp', id: 'grp-1' });
  if (path === '/grp-1/invite_link')
    return json({ messaging_product: 'whatsapp', invite_link: 'https://chat.whatsapp.com/xyz' });
  if (path === '/grp-1/join_requests' && method === 'GET') {
    return json({
      data: [{ join_request_id: 'jr-1', wa_id: '919811112222', creation_timestamp: 1_700_000_000 }],
    });
  }
  if (path === '/grp-1/join_requests')
    return json({ messaging_product: 'whatsapp', approved_join_requests: ['jr-1'] });
  if (path === '/grp-1' && method === 'DELETE') return json({ success: true });
  if (path.endsWith('/call_permissions')) {
    return json({
      messaging_product: 'whatsapp',
      permission: { status: 'temporary' },
      actions: [
        { action_name: 'start_call', can_perform_action: true, limits: [] },
        { action_name: 'send_call_permission_request', can_perform_action: true, limits: [] },
      ],
    });
  }
  if (path.endsWith('/calls'))
    return json({
      messaging_product: 'whatsapp',
      calls: [{ id: `wacid.${randomUUID()}` }],
      success: true,
    });
  if (path.endsWith('/settings') && method === 'GET') {
    return json({
      calling: {
        status: 'DISABLED',
        call_icon_visibility: 'DEFAULT',
        callback_permission_status: 'DISABLED',
      },
    });
  }
  if (path.endsWith('/settings')) return json({ success: true });
  return json({ error: { message: `Unexpected ${method} ${path}`, code: 100 } });
}) as typeof fetch;

/** A scripted Instagram: login exchange, account, subscription. */
const igFetch = (async (input: string | URL) => {
  const url = String(input);
  const json = (data: unknown) =>
    new Response(JSON.stringify(data), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  if (url.includes('/me?'))
    return json({ user_id: '17841400000000001', username: 'pickle.shop', name: 'Pickle Shop' });
  if (url.includes('subscribed_apps')) return json({ success: true });
  return json({ error: { message: 'unexpected', code: 100 } });
}) as typeof fetch;

let t: TestApp;
let owner: DbClient;

beforeAll(async () => {
  t = await buildApp({
    env: {
      ENCRYPTION_KEY,
      INSTAGRAM_APP_ID: 'ig-app',
      INSTAGRAM_APP_SECRET: IG_SECRET,
      META_WEBHOOK_VERIFY_TOKEN: 'verify-me',
    },
    graph: { apiVersion: 'v25.0', fetch: graphFetch },
    instagram: new InstagramClient({
      appId: 'ig-app',
      appSecret: IG_SECRET,
      apiVersion: 'v25.0',
      baseUrl: 'https://ig.test',
      fetch: igFetch,
    }),
  });
  owner = createPrismaClient({ connectionString: urls.directUrl });
});
afterAll(async () => {
  await t?.close();
  await owner?.$disconnect();
});

interface Workspace {
  client: Client;
  orgId: string;
  phoneId: string;
}

/** A signed-up workspace (Growth trial) with one connected number. */
async function workspace(plan?: string): Promise<Workspace> {
  const client = new Client(t.app);
  const { orgId } = await client.signup();
  const phoneId = randomUUID();
  await withTenant(owner, { orgId }, async (tx) => {
    const waba = await tx.wabaAccount.create({ data: { orgId, wabaId: metaId() } });
    await tx.phoneNumber.create({
      data: {
        id: phoneId,
        orgId,
        wabaAccountId: waba.id,
        phoneNumberId: metaId(),
        status: 'connected',
        credentialSource: 'manual',
        accessTokenEnc: secrets.encrypt('token', phoneTokenAad(phoneId)),
        displayPhoneNumber: '+91 98000 00000',
      },
    });
    if (plan) {
      const p = await tx.plan.findUniqueOrThrow({ where: { code: plan } });
      await tx.subscription.update({
        where: { orgId },
        data: { planId: p.id, status: 'active', trialEndsAt: null },
      });
    }
  });
  return { client, orgId, phoneId };
}

describe('website chat', () => {
  let ws: Workspace;
  let key: string;

  beforeAll(async () => {
    ws = await workspace();
    const created = await ws.client.post('/channels/webchat', { name: 'Main site' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ kind: 'webchat', name: 'Main site', status: 'active' });
    key = created.body.widgetKey;
    expect(key).toMatch(/^wc_/);
  });

  const pub = (path: string, body: unknown) =>
    new Client(t.app).post(`/webchat/${key}/${path}`, body);

  it('serves the embed script', async () => {
    const res = await new Client(t.app).get('/webchat/widget.js');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('javascript');
    expect(String(res.body)).toContain('/widget/');
  });

  it('starts a visitor, takes their message into the inbox, and keeps notes out of the widget', async () => {
    const session = await pub('session', {});
    expect(session.status).toBe(200);
    expect(session.body).toMatchObject({ started: false, channel: { title: 'Chat with us' } });
    const token = session.body.token as string;

    const clientMessageId = randomUUID();
    const sent = await pub('messages', {
      token,
      clientMessageId,
      body: 'Do you deliver to Pune?',
      name: 'Riya',
    });
    expect(sent.status).toBe(201);
    expect(sent.body).toMatchObject({ from: 'visitor', body: 'Do you deliver to Pune?' });
    // A retried send is the same message.
    const again = await pub('messages', {
      token,
      clientMessageId,
      body: 'Do you deliver to Pune?',
    });
    expect(again.body.id).toBe(sent.body.id);

    const list = await ws.client.get('/inbox/conversations?status=any');
    const conv = list.body.items.find(
      (c: { channel: { kind: string } }) => c.channel.kind === 'webchat',
    );
    expect(conv).toMatchObject({
      contact: { name: 'Riya', waId: null },
      phoneNumber: null,
      windowExpiresAt: null,
    });

    // No reply window on website chat: an agent can always answer.
    const reply = await ws.client.post(`/inbox/conversations/${conv.id}/messages`, {
      type: 'text',
      clientMessageId: randomUUID(),
      body: 'Yes, we do!',
    });
    expect(reply.status).toBe(201);
    await ws.client.post(`/inbox/conversations/${conv.id}/notes`, {
      clientMessageId: randomUUID(),
      body: 'VIP, give a discount',
    });
    // Templates and files are WhatsApp's.
    const template = await ws.client.post(`/inbox/conversations/${conv.id}/messages`, {
      type: 'template',
      clientMessageId: randomUUID(),
      templateId: randomUUID(),
    });
    expect(template.status).toBe(400);

    const history = await pub('history', { token });
    expect(history.body.map((m: { body: string }) => m.body)).toEqual([
      'Do you deliver to Pune?',
      'Yes, we do!',
    ]);
    expect((await pub('session', { token })).body.started).toBe(true);
  });

  it('refuses a token made for another widget, and sites that are not allowed', async () => {
    const other = await ws.client.post('/channels/webchat', { name: 'Other' });
    const otherToken = (
      await new Client(t.app).post(`/webchat/${other.body.widgetKey}/session`, {})
    ).body.token;
    const res = await pub('messages', {
      token: otherToken,
      clientMessageId: randomUUID(),
      body: 'hi',
    });
    expect(res.status).toBe(401);

    await ws.client.patch(`/channels/${other.body.id}`, {
      config: { allowedOrigins: ['https://shop.example'] },
    });
    const fromElsewhere = await new Client(t.app).post(`/webchat/${other.body.widgetKey}/session`, {
      origin: 'https://evil.example',
    });
    expect(fromElsewhere.status).toBe(403);
    const fromShop = await new Client(t.app).post(`/webchat/${other.body.widgetKey}/session`, {
      origin: 'https://shop.example',
    });
    expect(fromShop.status).toBe(200);
  });

  it('closes when the channel is disconnected', async () => {
    const extra = await ws.client.post('/channels/webchat', { name: 'Temporary' });
    expect((await ws.client.delete(`/channels/${extra.body.id}`)).status).toBe(204);
    const res = await new Client(t.app).post(`/webchat/${extra.body.widgetKey}/session`, {});
    expect(res.status).toBe(404);
  });
});

describe('Instagram', () => {
  it('connects with a token, keeping the token out of every answer', async () => {
    const ws = await workspace();
    const res = await ws.client.post('/channels/instagram/token', {
      accessToken: 'IGQ-long-lived-token-abcdefghij',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      kind: 'instagram',
      name: '@pickle.shop',
      detail: '@pickle.shop',
    });
    expect(JSON.stringify(res.body)).not.toContain('IGQ-');
    expect(JSON.stringify((await ws.client.get('/channels')).body)).not.toContain('IGQ-');

    // The same account cannot be live in two workspaces.
    const other = await workspace();
    const taken = await other.client.post('/channels/instagram/token', {
      accessToken: 'IGQ-long-lived-token-abcdefghij',
    });
    expect(taken.status).toBe(409);
  });

  it('starts the login with a one-use state', async () => {
    const ws = await workspace();
    const res = await ws.client.post('/channels/instagram/start');
    expect(res.status).toBe(200);
    const url = new URL(res.body.url);
    expect(url.pathname).toBe('/oauth/authorize');
    expect(url.searchParams.get('scope')).toContain('instagram_business_manage_messages');
    const state = url.searchParams.get('state')!;
    const first = await new Client(t.app).get(
      `/channels/instagram/callback?state=${state}&error=access_denied`,
    );
    expect(first.status).toBe(302);
    expect(first.headers.location).toContain('instagram=cancelled');
    const replay = await new Client(t.app).get(
      `/channels/instagram/callback?state=${state}&code=abc`,
    );
    expect(replay.headers.location).toContain('instagram=expired');
  });

  it('stores a signed webhook and refuses a bad signature', async () => {
    const body = JSON.stringify({
      object: 'instagram',
      entry: [{ id: '17841400000000001', time: Date.now(), messaging: [] }],
    });
    const sign = (secret: string) =>
      `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
    const send = (signature: string) =>
      t.app.inject({
        method: 'POST',
        url: '/webhooks/instagram',
        payload: body,
        headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
      });
    expect((await send(sign('wrong'))).statusCode).toBe(401);
    expect((await send(sign(IG_SECRET))).statusCode).toBe(200);
    const [row] = await owner.$queryRaw<{ provider: string; waba_id: string }[]>`
      SELECT provider, waba_id FROM webhook_events WHERE waba_id = '17841400000000001' ORDER BY received_at DESC LIMIT 1`;
    expect(row).toEqual({ provider: 'instagram', waba_id: '17841400000000001' });
  });
});

describe('QR codes and short links', () => {
  it('creates a code with its link and QR image, and deletes it at Meta', async () => {
    const ws = await workspace();
    const res = await ws.client.post('/qr-codes', {
      phoneId: ws.phoneId,
      name: 'Counter',
      prefilledMessage: 'I want to order',
    });
    expect(res.status).toBe(201);
    expect(res.body[0]).toMatchObject({
      name: 'Counter',
      prefilledMessage: 'I want to order',
      deepLinkUrl: expect.stringMatching(/^https:\/\/wa\.me\/message\/QR/),
      conversationsStarted: 0,
    });
    expect(res.body[0].svg).toContain('<svg');
    expect((await ws.client.delete(`/qr-codes/${res.body[0].id}`)).status).toBe(204);
    expect(
      graphCalls.some((c) => c.method === 'DELETE' && c.path.includes('/message_qrdls/')),
    ).toBe(true);
    expect((await ws.client.get('/qr-codes')).body).toEqual([]);
  });
});

describe('catalog', () => {
  it('syncs the connected catalog and sends products into a conversation', async () => {
    const ws = await workspace();
    const synced = await ws.client.post('/catalog/sync', { phoneId: ws.phoneId });
    expect(synced.status).toBe(200);
    expect(synced.body).toMatchObject({ catalogId: 'cat-1' });
    expect(synced.body.products.map((p: { retailerId: string }) => p.retailerId)).toEqual([
      'SKU-2',
      'SKU-1',
    ]);

    const conversationId = await withTenant(owner, { orgId: ws.orgId }, async (tx) => {
      const contact = await tx.contact.create({ data: { orgId: ws.orgId, waId: '919811110000' } });
      const channel = await tx.channel.findUniqueOrThrow({ where: { phoneId: ws.phoneId } });
      const c = await tx.conversation.create({
        data: {
          orgId: ws.orgId,
          channelId: channel.id,
          phoneId: ws.phoneId,
          contactId: contact.id,
          windowExpiresAt: new Date(Date.now() + 3600_000),
        },
      });
      return c.id;
    });
    const sent = await ws.client.post(`/inbox/conversations/${conversationId}/products`, {
      kind: 'product_list',
      clientMessageId: randomUUID(),
      header: 'Pickles',
      body: 'Our bestsellers',
      sections: [{ title: 'Pickles', retailerIds: ['SKU-1', 'SKU-2'] }],
    });
    expect(sent.status).toBe(201);
    expect(sent.body).toMatchObject({
      type: 'product_list',
      status: 'queued',
      detail: { kind: 'products', count: 2 },
    });
  });
});

describe('groups and calling (Scale)', () => {
  it('creates a group with its invite link, and answers join requests', async () => {
    const ws = await workspace('scale');
    const created = await ws.client.post('/groups', {
      phoneId: ws.phoneId,
      subject: 'VIP customers',
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      groupId: 'grp-1',
      status: 'active',
      inviteLink: 'https://chat.whatsapp.com/xyz',
    });
    const requests = await ws.client.get(`/groups/${created.body.id}/join-requests`);
    expect(requests.body).toEqual([expect.objectContaining({ id: 'jr-1', waId: '919811112222' })]);
    const answered = await ws.client.post(`/groups/${created.body.id}/join-requests`, {
      approve: ['jr-1'],
    });
    expect(answered.status).toBe(200);
    expect((await ws.client.delete(`/groups/${created.body.id}`)).status).toBe(204);
    expect((await ws.client.get('/groups')).body).toEqual([]);
  });

  it('reads and changes calling settings, and starts a call with the browser offer', async () => {
    const ws = await workspace('scale');
    const settings = await ws.client.get(`/calling/settings?phoneId=${ws.phoneId}`);
    expect(settings.body).toEqual({ enabled: false, iconVisible: true, callbackPermission: false });
    const put = await ws.client.req('PUT', `/calling/settings?phoneId=${ws.phoneId}`, {
      enabled: true,
      iconVisible: true,
      callbackPermission: true,
    });
    expect(put.status).toBe(200);
    expect(graphCalls.at(-1)?.body).toEqual({
      calling: {
        status: 'ENABLED',
        call_icon_visibility: 'DEFAULT',
        callback_permission_status: 'ENABLED',
      },
    });

    const conversationId = await withTenant(owner, { orgId: ws.orgId }, async (tx) => {
      const contact = await tx.contact.create({ data: { orgId: ws.orgId, waId: '919811113333' } });
      const channel = await tx.channel.findUniqueOrThrow({ where: { phoneId: ws.phoneId } });
      return (
        await tx.conversation.create({
          data: {
            orgId: ws.orgId,
            channelId: channel.id,
            phoneId: ws.phoneId,
            contactId: contact.id,
          },
        })
      ).id;
    });
    const permission = await ws.client.get(
      `/inbox/conversations/${conversationId}/call-permission`,
    );
    expect(permission.body).toEqual({ status: 'temporary', canCall: true, canRequest: true });
    const call = await ws.client.post(`/inbox/conversations/${conversationId}/calls`, {
      sdp: 'v=0 browser offer',
    });
    expect(call.status).toBe(201);
    expect(call.body).toMatchObject({ direction: 'outbound', status: 'ringing', conversationId });
    expect(graphCalls.find((c) => c.path.endsWith('/calls'))?.body).toMatchObject({
      action: 'connect',
    });
  });
});

describe('ad attribution report', () => {
  it('groups referrals by ad, with new people and team replies', async () => {
    const ws = await workspace();
    await withTenant(owner, { orgId: ws.orgId }, async (tx) => {
      const contact = await tx.contact.create({ data: { orgId: ws.orgId, waId: '919811114444' } });
      const channel = await tx.channel.findUniqueOrThrow({ where: { phoneId: ws.phoneId } });
      const conv = await tx.conversation.create({
        data: {
          orgId: ws.orgId,
          channelId: channel.id,
          phoneId: ws.phoneId,
          contactId: contact.id,
        },
      });
      for (const [i, sourceType] of (['ad', 'ad', 'qr'] as const).entries()) {
        await tx.adReferral.create({
          data: {
            orgId: ws.orgId,
            conversationId: conv.id,
            contactId: contact.id,
            channelKind: 'whatsapp',
            sourceType,
            sourceId: sourceType === 'qr' ? 'qr-1' : 'ad-42',
            headline: 'Festive offer',
            newContact: i === 0,
            messageId: randomUUID(),
            messageCreatedAt: new Date(),
          },
        });
      }
    });
    const res = await ws.client.get('/analytics/ads?days=30');
    expect(res.status).toBe(200);
    expect(res.body.rows).toEqual([
      expect.objectContaining({
        sourceId: 'ad-42',
        headline: 'Festive offer',
        referrals: 2,
        conversations: 1,
        newContacts: 1,
        replied: 0,
      }),
    ]);
  });
});

describe('plan flags', () => {
  const blocked = async (
    ws: Workspace,
    req: () => Promise<{ status: number; body: { code?: string } }>,
  ) => {
    const res = await req();
    expect(res.status).toBe(402);
    expect(res.body.code).toBe(ErrorCode.PLAN_FEATURE_UNAVAILABLE);
    return ws;
  };

  it('keeps every module behind its feature', async () => {
    const free = await workspace('free');
    const checks: [PlanFeature, () => Promise<{ status: number; body: { code?: string } }>][] = [
      ['webchat', () => free.client.post('/channels/webchat', { name: 'x' })],
      ['instagram', () => free.client.post('/channels/instagram/start')],
      [
        'qr_codes',
        () =>
          free.client.post('/qr-codes', {
            phoneId: free.phoneId,
            name: 'x',
            prefilledMessage: 'x',
          }),
      ],
      ['catalog', () => free.client.post('/catalog/sync', { phoneId: free.phoneId })],
      ['ad_attribution', () => free.client.get('/analytics/ads')],
    ];
    for (const [, req] of checks) await blocked(free, req);

    // The Growth trial has the channels, but not groups or calling (Scale).
    const growth = await workspace();
    await blocked(growth, () =>
      growth.client.post('/groups', { phoneId: growth.phoneId, subject: 'x' }),
    );
    await blocked(growth, () =>
      growth.client.req('PUT', `/calling/settings?phoneId=${growth.phoneId}`, { enabled: true }),
    );
  });

  it('stops a website chat whose workspace lost the feature, without saying why', async () => {
    const ws = await workspace();
    const created = await ws.client.post('/channels/webchat', { name: 'Site' });
    await withTenant(owner, { orgId: ws.orgId }, async (tx) => {
      const p = await tx.plan.findUniqueOrThrow({ where: { code: 'free' } });
      await tx.subscription.update({
        where: { orgId: ws.orgId },
        data: { planId: p.id, status: 'active', trialEndsAt: null },
      });
    });
    const res = await new Client(t.app).post(`/webchat/${created.body.widgetKey}/session`, {});
    expect(res.status).toBe(404);
  });
});

describe('isolation', () => {
  it('keeps channels, QR codes, groups and reports to their workspace', async () => {
    const a = await workspace('scale');
    const b = await workspace('scale');
    const widget = await a.client.post('/channels/webchat', { name: 'A site' });
    const qr = await a.client.post('/qr-codes', {
      phoneId: a.phoneId,
      name: 'A code',
      prefilledMessage: 'hi',
    });
    const group = await a.client.post('/groups', { phoneId: a.phoneId, subject: 'A group' });

    expect((await b.client.get('/channels')).body.map((c: { id: string }) => c.id)).not.toContain(
      widget.body.id,
    );
    expect((await b.client.patch(`/channels/${widget.body.id}`, { name: 'Stolen' })).status).toBe(
      404,
    );
    expect((await b.client.delete(`/channels/${widget.body.id}`)).status).toBe(404);
    expect((await b.client.get('/qr-codes')).body).toEqual([]);
    expect((await b.client.delete(`/qr-codes/${qr.body[0].id}`)).status).toBe(404);
    expect((await b.client.get('/groups')).body).toEqual([]);
    expect((await b.client.delete(`/groups/${group.body.id}`)).status).toBe(404);
    // A number from another workspace cannot be used for anything.
    expect(
      (await b.client.post('/qr-codes', { phoneId: a.phoneId, name: 'x', prefilledMessage: 'x' }))
        .status,
    ).toBe(404);
    expect((await b.client.post('/catalog/sync', { phoneId: a.phoneId })).status).toBe(404);

    // A's widget writes only into A.
    const token = (await new Client(t.app).post(`/webchat/${widget.body.widgetKey}/session`, {}))
      .body.token;
    await new Client(t.app).post(`/webchat/${widget.body.widgetKey}/messages`, {
      token,
      clientMessageId: randomUUID(),
      body: 'For A',
    });
    const bInbox = (await b.client.get('/inbox/conversations?status=any')).body.items;
    expect(bInbox).toEqual([]);
  });
});
