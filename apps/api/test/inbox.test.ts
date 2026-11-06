/** Inbox API and realtime gateway. Real Postgres, Redis and sockets; Meta is faked. */
import { randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import {
  createPrismaClient,
  creditWallet,
  type DbClient,
  ensureWallet,
  withTenant,
} from '@wacrm/db';
import { ErrorCode } from '@wacrm/shared';
import { phoneTokenAad, SecretBox } from '@wacrm/shared/server';
import { io, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { QueuesService } from '../src/infra/queues.service';
import { buildApp, Client, type TestApp, tokenFromMail, uniqueEmail, urls } from './helpers';

const ENCRYPTION_KEY = randomBytes(32).toString('base64');
const secrets = new SecretBox(ENCRYPTION_KEY);
const metaId = () => String(Math.floor(Math.random() * 1e15) + 1e15);

const TEMPLATES = [
  {
    id: '1',
    name: 'welcome',
    language: 'en_US',
    category: 'UTILITY',
    status: 'APPROVED',
    components: [{ type: 'BODY', text: 'Hi {{1}}, your order {{2}} shipped' }],
  },
  {
    id: '2',
    name: 'pending_one',
    language: 'en_US',
    category: 'UTILITY',
    status: 'PENDING',
    components: [{ type: 'BODY', text: 'Not approved' }],
  },
  {
    id: '4',
    name: 'promo',
    language: 'en_US',
    category: 'MARKETING',
    status: 'APPROVED',
    components: [{ type: 'BODY', text: 'Big sale this week' }],
  },
  {
    id: '3',
    name: 'with_image',
    language: 'en_US',
    category: 'UTILITY',
    status: 'APPROVED',
    components: [
      { type: 'HEADER', format: 'IMAGE' },
      { type: 'BODY', text: 'Has an image header' },
    ],
  },
];

const fakeFetch = (async (input: string | URL | Request) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.pathname.endsWith('/message_templates')) {
    const name = url.searchParams.get('name');
    return new Response(
      JSON.stringify({ data: TEMPLATES.filter((t) => !name || t.name === name) }),
      { headers: { 'content-type': 'application/json' } },
    );
  }
  return new Response('{}', { headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

let t: TestApp;
let owner: DbClient;
let queues: QueuesService;
let baseUrl: string;
const sockets: Socket[] = [];

beforeAll(async () => {
  t = await buildApp({
    env: { ENCRYPTION_KEY },
    graph: { apiVersion: 'v25.0', fetch: fakeFetch },
  });
  await t.app.listen(0, '127.0.0.1');
  const { port } = t.app.getHttpServer().address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
  owner = createPrismaClient({ connectionString: urls.directUrl });
  queues = t.app.get(QueuesService);
  // Templates cost money now. What they cost is tested in wallet.test.ts.
  await owner.rateCard.createMany({
    data: ['marketing', 'utility'].map((category) => ({
      country: '*',
      category,
      currency: 'INR',
      rateMicros: 1n,
      validFrom: new Date('2026-01-01'),
    })),
    skipDuplicates: true,
  });
});

afterAll(async () => {
  for (const s of sockets) s.disconnect();
  await queues?.outbound.obliterate({ force: true });
  await t?.close();
  await owner?.$disconnect();
});

interface Org {
  client: Client;
  orgId: string;
  userId: string;
}

async function signup(): Promise<Org> {
  const client = new Client(t.app);
  const s = await client.signup();
  await withTenant(owner, { orgId: s.orgId }, async (tx) => {
    await ensureWallet(tx, s.orgId, 'INR');
    await creditWallet(tx, { orgId: s.orgId, amountMicros: 1_000_000, idempotencyKey: 'seed' });
  });
  return { client, orgId: s.orgId, userId: s.userId };
}

async function addAgent(org: Org) {
  const email = uniqueEmail('agent');
  await org.client.post('/team/invitations', { email, role: 'agent' });
  const agent = new Client(t.app);
  await agent.post('/invitations/accept', {
    token: tokenFromMail(t.mailer, email),
    name: 'Agent Smith',
    password: 'correct-horse-battery',
  });
  const me = await agent.get('/auth/me');
  return { client: agent, userId: me.body.user.id as string };
}

/** A connected number and a conversation, written the way the worker would. */
async function seedConversation(
  org: Org,
  opts: { windowOpen?: boolean; phoneStatus?: 'connected' | 'disconnected'; at?: Date } = {},
) {
  const { orgId } = org;
  return withTenant(owner, { orgId }, async (tx) => {
    const waba = await tx.wabaAccount.create({ data: { orgId, wabaId: metaId() } });
    const id = randomUUID();
    const phone = await tx.phoneNumber.create({
      data: {
        id,
        orgId,
        wabaAccountId: waba.id,
        phoneNumberId: metaId(),
        status: opts.phoneStatus ?? 'connected',
        credentialSource: 'manual',
        accessTokenEnc: secrets.encrypt('token', phoneTokenAad(id)),
      },
    });
    const contact = await tx.contact.create({
      data: { orgId, waId: metaId(), name: 'Asha' },
    });
    return tx.conversation.create({
      data: {
        orgId,
        phoneId: phone.id,
        contactId: contact.id,
        lastMessageAt: opts.at ?? new Date(),
        lastMessagePreview: 'Hello',
        unreadCount: 3,
        windowExpiresAt:
          opts.windowOpen === false
            ? new Date(Date.now() - 3600_000)
            : new Date(Date.now() + 3600_000),
      },
    });
  });
}

const text = (body = 'Hello back') => ({ type: 'text', clientMessageId: randomUUID(), body });

/** Opening the picker copies the account's templates from Meta on first use. */
async function templateId(org: Org, conversationId: string, name: string) {
  await org.client.get(`/inbox/conversations/${conversationId}/templates`);
  const row = await withTenant(owner, { orgId: org.orgId }, async (tx) => {
    const c = await tx.conversation.findUniqueOrThrow({
      where: { id: conversationId },
      select: { phone: { select: { wabaAccountId: true } } },
    });
    return tx.messageTemplate.findFirst({
      where: { name, wabaAccountId: c.phone.wabaAccountId },
      select: { id: true },
    });
  });
  return row?.id ?? randomUUID();
}

async function sendTemplate(
  org: Org,
  conversationId: string,
  name: string,
  variables: Record<string, string> = {},
) {
  return org.client.post(`/inbox/conversations/${conversationId}/messages`, {
    type: 'template',
    clientMessageId: randomUUID(),
    templateId: await templateId(org, conversationId, name),
    variables,
  });
}

function connect(token: string | undefined): Promise<Socket> {
  const socket = io(baseUrl, {
    path: '/socket.io',
    auth: { token },
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
  });
  sockets.push(socket);
  return new Promise((resolve, reject) => {
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', (err) => reject(err));
  });
}

const nextEvent = <T>(socket: Socket, event: string, timeoutMs = 3000) =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ${event} event`)), timeoutMs);
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });

/** Assert nothing arrives: gives the event time to reach the socket. */
const silent = async (socket: Socket, event: string) => {
  const handler = vi.fn();
  socket.on(event, handler);
  await new Promise((r) => setTimeout(r, 300));
  socket.off(event, handler);
  expect(handler).not.toHaveBeenCalled();
};

describe('conversation list', () => {
  it('filters by mine, unassigned and status', async () => {
    const org = await signup();
    const a = await seedConversation(org);
    const b = await seedConversation(org);
    const closed = await seedConversation(org);
    await org.client.patch(`/inbox/conversations/${a.id}`, { assigneeId: org.userId });
    await org.client.patch(`/inbox/conversations/${closed.id}`, { status: 'closed' });
    const ids = async (q: string) =>
      (await org.client.get(`/inbox/conversations?${q}`)).body.items.map(
        (c: { id: string }) => c.id,
      );

    expect((await ids('filter=all')).sort()).toEqual([a.id, b.id].sort());
    expect(await ids('filter=mine')).toEqual([a.id]);
    expect(await ids('filter=unassigned')).toEqual([b.id]);
    expect(await ids('status=closed')).toEqual([closed.id]);
    expect((await ids('status=any')).length).toBe(3);
  });

  it('pages by cursor, newest first, with no repeats', async () => {
    const org = await signup();
    const base = Date.now();
    const made = [];
    for (let i = 0; i < 5; i++) {
      made.push(await seedConversation(org, { at: new Date(base - i * 1000) }));
    }
    const first = await org.client.get('/inbox/conversations?limit=2');
    const second = await org.client.get(
      `/inbox/conversations?limit=2&cursor=${first.body.nextCursor}`,
    );
    const third = await org.client.get(
      `/inbox/conversations?limit=2&cursor=${second.body.nextCursor}`,
    );
    const seen = [...first.body.items, ...second.body.items, ...third.body.items].map(
      (c: { id: string }) => c.id,
    );
    expect(seen).toEqual(made.map((c) => c.id));
    expect(third.body.nextCursor).toBeNull();
  });

  it("never shows another org's conversations", async () => {
    const a = await signup();
    const b = await signup();
    const conv = await seedConversation(a);
    expect((await b.client.get('/inbox/conversations')).body.items).toEqual([]);
    expect((await b.client.get(`/inbox/conversations/${conv.id}`)).status).toBe(404);
    expect((await b.client.get(`/inbox/conversations/${conv.id}/messages`)).status).toBe(404);
    expect((await b.client.post(`/inbox/conversations/${conv.id}/messages`, text())).status).toBe(
      404,
    );
    expect(
      (
        await b.client.post(`/inbox/conversations/${conv.id}/notes`, {
          clientMessageId: randomUUID(),
          body: 'x',
        })
      ).status,
    ).toBe(404);
    expect(
      (await b.client.patch(`/inbox/conversations/${conv.id}`, { status: 'closed' })).status,
    ).toBe(404);
  });
});

describe('sending', () => {
  it('queues a text message and returns it as queued', async () => {
    const org = await signup();
    const conv = await seedConversation(org);
    const res = await org.client.post(`/inbox/conversations/${conv.id}/messages`, text('Hi'));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      direction: 'outbound',
      type: 'text',
      status: 'queued',
      body: 'Hi',
      senderUserId: org.userId,
    });
    const job = await queues.outbound.getJob(res.body.id);
    expect(job?.data).toMatchObject({ orgId: org.orgId, messageId: res.body.id });

    const after = await org.client.get(`/inbox/conversations/${conv.id}`);
    expect(after.body.lastMessagePreview).toBe('Hi');
  });

  it('the same clientMessageId sends only once', async () => {
    const org = await signup();
    const conv = await seedConversation(org);
    const body = text('Once');
    const first = await org.client.post(`/inbox/conversations/${conv.id}/messages`, body);
    const add = vi.spyOn(queues.outbound, 'add');
    const second = await org.client.post(`/inbox/conversations/${conv.id}/messages`, body);
    expect(second.body.id).toBe(first.body.id);
    expect(add).not.toHaveBeenCalled();
    add.mockRestore();
    const list = await org.client.get(`/inbox/conversations/${conv.id}/messages`);
    expect(list.body.items).toHaveLength(1);
  });

  it('shows a failure rather than leaving the message stuck when the queue is down', async () => {
    const org = await signup();
    const conv = await seedConversation(org);
    const add = vi.spyOn(queues.outbound, 'add').mockRejectedValueOnce(new Error('Redis down'));
    const res = await org.client.post(`/inbox/conversations/${conv.id}/messages`, text());
    add.mockRestore();
    expect(res.body.status).toBe('failed');
    expect(res.body.errorMessage).toMatch(/try again/);
  });

  it('validates input', async () => {
    const org = await signup();
    const conv = await seedConversation(org);
    const res = await org.client.post(`/inbox/conversations/${conv.id}/messages`, {
      type: 'text',
      clientMessageId: randomUUID(),
      body: '   ',
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(ErrorCode.VALIDATION_FAILED);
  });

  it('refuses to send from a disconnected number', async () => {
    const org = await signup();
    const conv = await seedConversation(org, { phoneStatus: 'disconnected' });
    const res = await org.client.post(`/inbox/conversations/${conv.id}/messages`, text());
    expect(res.status).toBe(409);
    expect(res.body.code).toBe(ErrorCode.NUMBER_NOT_CONNECTED);
  });
});

describe('24-hour window, enforced on the server', () => {
  const file = (name = 'a.jpg', type = 'image/jpeg', content = 'jpeg-bytes') => {
    const boundary = `----t${randomUUID()}`;
    const clientMessageId = randomUUID();
    const payload = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="clientMessageId"',
      '',
      clientMessageId,
      `--${boundary}`,
      `Content-Disposition: form-data; name="file"; filename="${name}"`,
      `Content-Type: ${type}`,
      '',
      content,
      `--${boundary}--`,
      '',
    ].join('\r\n');
    return { boundary, payload, clientMessageId };
  };
  const upload = (org: Org, conversationId: string, f = file()) =>
    t.app.inject({
      method: 'POST',
      url: `/inbox/conversations/${conversationId}/messages/media`,
      payload: f.payload,
      headers: {
        authorization: `Bearer ${org.client.accessToken}`,
        'content-type': `multipart/form-data; boundary=${f.boundary}`,
      },
    });

  it('blocks free text after the window closes, with nothing saved or queued', async () => {
    const org = await signup();
    const conv = await seedConversation(org, { windowOpen: false });
    const add = vi.spyOn(queues.outbound, 'add');
    const res = await org.client.post(`/inbox/conversations/${conv.id}/messages`, text());
    expect(res.status).toBe(409);
    expect(res.body.code).toBe(ErrorCode.WINDOW_CLOSED);
    expect(add).not.toHaveBeenCalled();
    add.mockRestore();
    expect((await org.client.get(`/inbox/conversations/${conv.id}/messages`)).body.items).toEqual(
      [],
    );
  });

  it('blocks media after the window closes', async () => {
    const org = await signup();
    const conv = await seedConversation(org, { windowOpen: false });
    const res = await upload(org, conv.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe(ErrorCode.WINDOW_CLOSED);
  });

  it('a conversation with no inbound message counts as closed', async () => {
    const org = await signup();
    const conv = await seedConversation(org);
    await owner.conversation.update({ where: { id: conv.id }, data: { windowExpiresAt: null } });
    const res = await org.client.post(`/inbox/conversations/${conv.id}/messages`, text());
    expect(res.body.code).toBe(ErrorCode.WINDOW_CLOSED);
  });

  it('allows an approved template after the window closes, rendering its text', async () => {
    const org = await signup();
    const conv = await seedConversation(org, { windowOpen: false });
    const res = await sendTemplate(org, conv.id, 'welcome', { 'body.1': 'Asha', 'body.2': '#42' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      type: 'template',
      status: 'queued',
      body: 'Hi Asha, your order #42 shipped',
    });
  });

  it.each([
    ['a template that is not approved', 'pending_one', {}],
    ['a template that does not exist', 'nope', {}],
    ['a media template with no file yet', 'with_image', {}],
    ['a missing value', 'welcome', { 'body.1': 'only one' }],
    ['a blank value', 'welcome', { 'body.1': 'Asha', 'body.2': '   ' }],
  ])('refuses %s', async (_, name, variables) => {
    const org = await signup();
    const conv = await seedConversation(org, { windowOpen: false });
    const res = await sendTemplate(org, conv.id, name, variables as Record<string, string>);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(ErrorCode.TEMPLATE_NOT_SENDABLE);
  });

  it('the picker lists only approved templates it can fill in', async () => {
    const org = await signup();
    const conv = await seedConversation(org);
    const res = await org.client.get(`/inbox/conversations/${conv.id}/templates`);
    expect(res.body.map((t: { name: string }) => t.name)).toEqual([
      'promo',
      'welcome',
      'with_image',
    ]);
    const welcome = res.body.find((t: { name: string }) => t.name === 'welcome');
    expect(welcome).toMatchObject({
      language: 'en_US',
      category: 'UTILITY',
      sendIssue: null,
      definition: { body: 'Hi {{1}}, your order {{2}} shipped' },
      variables: [
        { key: 'body.1', value: '' },
        { key: 'body.2', value: '' },
      ],
    });
    expect(res.body.find((t: { name: string }) => t.name === 'with_image').sendIssue).toContain(
      'header file',
    );
  });

  it('refuses a template from another account of the same workspace', async () => {
    const org = await signup();
    const first = await seedConversation(org);
    const second = await seedConversation(org);
    const id = await templateId(org, first.id, 'welcome');
    const res = await org.client.post(`/inbox/conversations/${second.id}/messages`, {
      type: 'template',
      clientMessageId: randomUUID(),
      templateId: id,
      variables: { 'body.1': 'a', 'body.2': 'b' },
    });
    expect(res.status).toBe(400);
  });

  describe('marketing consent', () => {
    const sendPromo = (org: Org, conversationId: string) =>
      sendTemplate(org, conversationId, 'promo');
    const contactIdOf = async (org: Org, conversationId: string) =>
      (await org.client.get(`/inbox/conversations/${conversationId}`)).body.contact.id as string;

    it('refuses marketing to a contact with no recorded consent', async () => {
      const org = await signup();
      const conv = await seedConversation(org);
      const res = await sendPromo(org, conv.id);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe(ErrorCode.CONTACT_NOT_OPTED_IN);
    });

    it('allows marketing once consent is recorded, and stops after an opt-out', async () => {
      const org = await signup();
      const conv = await seedConversation(org);
      const contactId = await contactIdOf(org, conv.id);
      await org.client.post(`/contacts/${contactId}/consent`, {
        status: 'opted_in',
        source: 'Form',
        proof: 'Signed up on the website',
      });
      const allowed = await sendPromo(org, conv.id);
      expect(allowed.status).toBe(201);

      await org.client.post(`/contacts/${contactId}/consent`, { status: 'opted_out' });
      const blocked = await sendPromo(org, conv.id);
      expect(blocked.status).toBe(409);
      expect(blocked.body.message).toContain('opted out');
    });

    it('still allows utility templates and replies to an opted-out contact', async () => {
      const org = await signup();
      const conv = await seedConversation(org);
      await org.client.post(`/contacts/${await contactIdOf(org, conv.id)}/consent`, {
        status: 'opted_out',
      });
      const utility = await sendTemplate(org, conv.id, 'welcome', {
        'body.1': 'Asha',
        'body.2': '#42',
      });
      expect(utility.status).toBe(201);
      const reply = await org.client.post(`/inbox/conversations/${conv.id}/messages`, {
        type: 'text',
        clientMessageId: randomUUID(),
        body: 'Your order is on its way',
      });
      expect(reply.status).toBe(201);
    });

    it('shows consent on the conversation', async () => {
      const org = await signup();
      const conv = await seedConversation(org);
      const res = await org.client.get(`/inbox/conversations/${conv.id}`);
      expect(res.body.contact.optInStatus).toBe('unknown');
    });
  });

  describe('media upload', () => {
    it('stores the file under the org and queues the message', async () => {
      const org = await signup();
      const conv = await seedConversation(org);
      const res = await upload(org, conv.id);
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body).toMatchObject({
        type: 'image',
        status: 'queued',
        media: { status: 'stored', mimeType: 'image/jpeg', filename: 'a.jpg', size: 10 },
      });
      const key = `orgs/${org.orgId}/messages/${body.id}`;
      expect(t.storage.objects.get(key)?.bytes.toString()).toBe('jpeg-bytes');
      // Internal storage details never reach the client.
      expect(JSON.stringify(body)).not.toContain('orgs/');
    });

    it('rejects a type WhatsApp does not accept, storing nothing', async () => {
      const org = await signup();
      const conv = await seedConversation(org);
      const before = t.storage.objects.size;
      const res = await upload(org, conv.id, file('x.svg', 'image/svg+xml', '<svg/>'));
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe(ErrorCode.MEDIA_NOT_ALLOWED);
      expect(t.storage.objects.size).toBe(before);
    });

    it('rejects a file over the limit for its type', async () => {
      const org = await signup();
      const conv = await seedConversation(org);
      const big = 'x'.repeat(5 * 1024 * 1024 + 10);
      const res = await upload(org, conv.id, file('big.jpg', 'image/jpeg', big));
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toMatch(/5 MB/);
    });

    it('gives a short-lived link, only inside the org', async () => {
      const org = await signup();
      const other = await signup();
      const conv = await seedConversation(org);
      const { id } = (await upload(org, conv.id)).json();
      const url = `/inbox/conversations/${conv.id}/messages/${id}/media`;
      const res = await org.client.get(url);
      expect(res.body.url).toContain(`orgs/${org.orgId}/messages/${id}`);
      expect(res.body.expiresIn).toBe(300);
      expect((await other.client.get(url)).status).toBe(404);
    });
  });
});

describe('internal notes', () => {
  it('stay in the thread, skip the window, and never reach the queue', async () => {
    const org = await signup();
    const conv = await seedConversation(org, { windowOpen: false });
    const add = vi.spyOn(queues.outbound, 'add');
    const res = await org.client.post(`/inbox/conversations/${conv.id}/notes`, {
      clientMessageId: randomUUID(),
      body: 'Customer is VIP',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      direction: 'internal',
      type: 'note',
      body: 'Customer is VIP',
    });
    expect(add).not.toHaveBeenCalled();
    add.mockRestore();
    const after = await org.client.get(`/inbox/conversations/${conv.id}`);
    expect(after.body.lastMessagePreview).toBe('Hello');
  });
});

describe('assignment, read state and labels', () => {
  it('admins assign anyone in the org, but not outsiders', async () => {
    const org = await signup();
    const agent = await addAgent(org);
    const outsider = await signup();
    const conv = await seedConversation(org);
    const ok = await org.client.patch(`/inbox/conversations/${conv.id}`, {
      assigneeId: agent.userId,
    });
    expect(ok.body.assignee).toEqual({ id: agent.userId, name: 'Agent Smith' });
    const bad = await org.client.patch(`/inbox/conversations/${conv.id}`, {
      assigneeId: outsider.userId,
    });
    expect(bad.status).toBe(400);
  });

  it('agents can take an unassigned conversation or release their own, nothing more', async () => {
    const org = await signup();
    const agent = await addAgent(org);
    const conv = await seedConversation(org);
    const url = `/inbox/conversations/${conv.id}`;

    expect((await agent.client.patch(url, { assigneeId: org.userId })).status).toBe(403);
    expect((await agent.client.patch(url, { assigneeId: agent.userId })).status).toBe(200);
    expect((await agent.client.patch(url, { assigneeId: null })).status).toBe(200);

    await org.client.patch(url, { assigneeId: org.userId });
    expect((await agent.client.patch(url, { assigneeId: agent.userId })).status).toBe(403);
    expect((await agent.client.patch(url, { assigneeId: null })).status).toBe(403);
  });

  it('marking read clears the shared unread count', async () => {
    const org = await signup();
    const conv = await seedConversation(org);
    const res = await org.client.post(`/inbox/conversations/${conv.id}/read`);
    expect(res.body.unreadCount).toBe(0);
  });

  it('labels: only this org’s labels can be attached', async () => {
    const org = await signup();
    const other = await signup();
    const conv = await seedConversation(org);
    const mine = await org.client.post('/inbox/labels', { name: 'VIP', color: '#ff0000' });
    const theirs = await other.client.post('/inbox/labels', { name: 'Theirs' });

    const url = `/inbox/conversations/${conv.id}/labels`;
    const ok = await org.client.req('PUT', url, { labelIds: [mine.body.id] });
    expect(ok.body.labels).toEqual([{ id: mine.body.id, name: 'VIP', color: '#ff0000' }]);
    const bad = await org.client.req('PUT', url, { labelIds: [theirs.body.id] });
    expect(bad.status).toBe(400);
    const empty = await org.client.req('PUT', url, { labelIds: [] });
    expect(empty.body.labels).toEqual([]);
  });

  it('duplicate label names and shortcuts are refused', async () => {
    const org = await signup();
    await org.client.post('/inbox/labels', { name: 'VIP' });
    expect((await org.client.post('/inbox/labels', { name: 'VIP' })).status).toBe(409);
    await org.client.post('/inbox/canned-replies', { shortcut: 'hi', body: 'Hello!' });
    const dup = await org.client.post('/inbox/canned-replies', { shortcut: 'HI', body: 'Again' });
    expect(dup.status).toBe(409);
    const list = await org.client.get('/inbox/canned-replies');
    expect(list.body.map((r: { shortcut: string }) => r.shortcut)).toEqual(['hi']);
  });

  it('agents can use but not manage labels and canned replies', async () => {
    const org = await signup();
    const agent = await addAgent(org);
    expect((await agent.client.get('/inbox/labels')).status).toBe(200);
    expect((await agent.client.post('/inbox/labels', { name: 'X' })).status).toBe(403);
    expect((await agent.client.get('/inbox/canned-replies')).status).toBe(200);
    expect(
      (await agent.client.post('/inbox/canned-replies', { shortcut: 'x', body: 'y' })).status,
    ).toBe(403);
  });
});

describe('realtime', () => {
  it('refuses a connection without a valid token', async () => {
    await expect(connect(undefined)).rejects.toThrow(ErrorCode.UNAUTHENTICATED);
    await expect(connect('not-a-jwt')).rejects.toThrow(ErrorCode.UNAUTHENTICATED);
  });

  it('delivers a new message live to everyone in the org', async () => {
    const org = await signup();
    const agent = await addAgent(org);
    const conv = await seedConversation(org);
    const ownerSocket = await connect(org.client.accessToken);
    const agentSocket = await connect(agent.client.accessToken);

    const toAgent = nextEvent<{ message: { body: string } }>(agentSocket, 'message:new');
    const toOwner = nextEvent<{ message: { body: string } }>(ownerSocket, 'message:new');
    const update = nextEvent<{ conversation: { lastMessagePreview: string } }>(
      agentSocket,
      'conversation:updated',
    );
    await org.client.post(`/inbox/conversations/${conv.id}/messages`, text('Live!'));

    expect((await toAgent).message.body).toBe('Live!');
    expect((await toOwner).message.body).toBe('Live!');
    expect((await update).conversation.lastMessagePreview).toBe('Live!');
  });

  it('never delivers an event to another org', async () => {
    const a = await signup();
    const b = await signup();
    const conv = await seedConversation(a);
    const bSocket = await connect(b.client.accessToken);
    await a.client.post(`/inbox/conversations/${conv.id}/messages`, text('Private'));
    await silent(bSocket, 'message:new');
  });

  it('relays typing inside the org only, not back to the sender', async () => {
    const org = await signup();
    const agent = await addAgent(org);
    const stranger = await signup();
    const conv = await seedConversation(org);
    const ownerSocket = await connect(org.client.accessToken);
    const agentSocket = await connect(agent.client.accessToken);
    const strangerSocket = await connect(stranger.client.accessToken);

    const received = nextEvent<Record<string, unknown>>(ownerSocket, 'typing');
    agentSocket.emit('typing', { conversationId: conv.id, isTyping: true });
    expect(await received).toEqual({
      conversationId: conv.id,
      userId: agent.userId,
      name: 'Agent Smith',
      isTyping: true,
    });
    await silent(strangerSocket, 'typing');
    await silent(agentSocket, 'typing');
  });

  it('reports who is online, and when they leave', async () => {
    const org = await signup();
    const agent = await addAgent(org);
    const ownerSocket = await connect(org.client.accessToken);

    const online = nextEvent<{ userId: string; online: boolean }>(ownerSocket, 'presence');
    const agentSocket = io(baseUrl, {
      path: '/socket.io',
      auth: { token: agent.client.accessToken },
      transports: ['websocket'],
      forceNew: true,
    });
    sockets.push(agentSocket);
    const state = nextEvent<{ userIds: string[] }>(agentSocket, 'presence:state');
    expect(await online).toEqual({ userId: agent.userId, online: true });
    expect((await state).userIds.sort()).toEqual([org.userId, agent.userId].sort());

    const offline = nextEvent<{ userId: string; online: boolean }>(ownerSocket, 'presence');
    agentSocket.disconnect();
    expect(await offline).toEqual({ userId: agent.userId, online: false });
  });

  it('removing a member cuts their live connection immediately', async () => {
    const org = await signup();
    const agent = await addAgent(org);
    const agentSocket = await connect(agent.client.accessToken);
    const members = await org.client.get('/team/members');
    const id = members.body.find((m: { userId: string }) => m.userId === agent.userId).id;

    const gone = nextEvent<string>(agentSocket, 'disconnect');
    await org.client.delete(`/team/members/${id}`);
    expect(await gone).toBe('io server disconnect');
    await expect(connect(agent.client.accessToken)).rejects.toThrow(
      ErrorCode.TENANT_CONTEXT_MISSING,
    );
  });

  it('logging out cuts the live connection', async () => {
    const org = await signup();
    const socket = await connect(org.client.accessToken);
    const gone = nextEvent<string>(socket, 'disconnect');
    await org.client.post('/auth/logout');
    expect(await gone).toBe('io server disconnect');
  });
});
