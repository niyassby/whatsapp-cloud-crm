/** Template manager API. Real Postgres and Redis; Meta is a scripted fake. */
import { randomBytes, randomUUID } from 'node:crypto';
import {
  createPrismaClient,
  creditWallet,
  type DbClient,
  ensureWallet,
  withTenant,
  whatsappChannelId,
} from '@wacrm/db';
import { ErrorCode } from '@wacrm/shared';
import { phoneTokenAad, SecretBox } from '@wacrm/shared/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, Client, type TestApp, tokenFromMail, uniqueEmail, urls } from './helpers';

const ENCRYPTION_KEY = randomBytes(32).toString('base64');
const secrets = new SecretBox(ENCRYPTION_KEY);
const metaId = () => String(Math.floor(Math.random() * 1e15) + 1e15);

interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  auth: string | null;
}

/** A scripted Graph API. Each test sets what Meta holds and how it answers. */
const graph = {
  calls: [] as Call[],
  list: [] as Record<string, unknown>[],
  failNext: null as { status: number; code: number; message: string } | null,
  reset() {
    this.calls = [];
    this.list = [];
    this.failNext = null;
  },
  of(method: string, suffix: string) {
    return this.calls.filter((c) => c.method === method && c.path.endsWith(suffix));
  },
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  const method = init?.method ?? 'GET';
  const raw = init?.body;
  let body: unknown = raw;
  if (typeof raw === 'string') {
    try {
      body = JSON.parse(raw);
    } catch {
      body = raw;
    }
  }
  const headers = new Headers(init?.headers);
  graph.calls.push({
    method,
    path: url.pathname,
    query: url.searchParams,
    body,
    auth: headers.get('authorization'),
  });
  if (method !== 'GET' && graph.failNext) {
    const { status, code, message } = graph.failNext;
    graph.failNext = null;
    return json({ error: { message, code, type: 'OAuthException' } }, status);
  }
  if (url.pathname.endsWith('/uploads')) return json({ id: 'upload:session-1' });
  if (url.pathname.includes('/upload:')) return json({ h: '4::sample-handle' });
  if (url.pathname.endsWith('/message_templates')) {
    if (method === 'POST') {
      return json({
        id: metaId(),
        status: 'PENDING',
        category: (body as { category: string }).category,
      });
    }
    if (method === 'DELETE') return json({ success: true });
    return json({ data: graph.list });
  }
  return json({ success: true });
}) as typeof fetch;

let t: TestApp;
let db: DbClient;

beforeAll(async () => {
  t = await buildApp({
    env: { ENCRYPTION_KEY },
    graph: { apiVersion: 'v25.0', appId: 'app-1', fetch: fakeFetch },
  });
  db = createPrismaClient({ connectionString: urls.directUrl });
  await db.rateCard.createMany({
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
  await t?.close();
  await db?.$disconnect();
});
beforeEach(() => graph.reset());

interface Workspace {
  client: Client;
  orgId: string;
  wabaAccountId: string;
  wabaId: string;
}

async function workspace(): Promise<Workspace> {
  const client = new Client(t.app);
  const { orgId } = await client.signup();
  const wabaId = metaId();
  const wabaAccountId = await withTenant(db, { orgId }, async (tx) => {
    const waba = await tx.wabaAccount.create({ data: { orgId, wabaId } });
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
    return waba.id;
  });
  return { client, orgId, wabaAccountId, wabaId };
}

const draft = (over: Record<string, unknown> = {}) => ({
  name: `order_ready_${randomBytes(3).toString('hex')}`,
  language: 'en_US',
  category: 'UTILITY',
  definition: { body: 'Hi {{1}}, your order is ready to collect.' },
  samples: { 'body.1': 'Asha' },
  ...over,
});

const create = async (w: Workspace, over: Record<string, unknown> = {}) => {
  const res = await w.client.post('/templates', draft(over));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
};

async function submitted(w: Workspace, over: Record<string, unknown> = {}) {
  const template = await create(w, over);
  const res = await w.client.post(`/templates/${template.id}/submit`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  graph.calls = [];
  return res.body;
}

const setStatus = (w: Workspace, id: string, status: string) =>
  withTenant(db, { orgId: w.orgId }, (tx) =>
    tx.messageTemplate.update({ where: { id }, data: { status } }),
  );

function uploadParts(filename: string, mime: string, bytes: Buffer) {
  const boundary = `----test${randomBytes(8).toString('hex')}`;
  return {
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
          `Content-Type: ${mime}\r\n\r\n`,
      ),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

async function uploadHeader(w: Workspace, id: string, filename: string, mime: string, size = 16) {
  const { payload, headers } = uploadParts(filename, mime, randomBytes(size));
  const res = await t.app.inject({
    method: 'POST',
    url: `/templates/${id}/header-media`,
    payload,
    headers: { ...headers, authorization: `Bearer ${w.client.accessToken}` },
  });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

describe('drafts', () => {
  it('saves a draft without calling Meta', async () => {
    const w = await workspace();
    const template = await create(w);
    expect(template).toMatchObject({
      status: 'draft',
      metaTemplateId: null,
      wabaAccountId: w.wabaAccountId,
      parameterFormat: 'positional',
      supported: true,
    });
    expect(graph.calls).toEqual([]);
  });

  it('refuses what Meta would reject, naming the field', async () => {
    const w = await workspace();
    const res = await w.client.post(
      '/templates',
      draft({ definition: { body: '{{1}} is ready' }, samples: { 'body.1': 'x' } }),
    );
    expect(res.status).toBe(400);
    expect(res.body.details.issues[0]).toMatchObject({
      path: 'definition.body',
      message: expect.stringContaining('cannot start or end'),
    });
    const noSample = await w.client.post('/templates', draft({ samples: {} }));
    expect(noSample.status).toBe(400);
    expect(noSample.body.details.issues[0].path).toBe('samples.body.1');
  });

  it('allows one name per language per account', async () => {
    const w = await workspace();
    await create(w, { name: 'welcome_note' });
    const again = await w.client.post('/templates', draft({ name: 'welcome_note' }));
    expect(again.status).toBe(409);
    await create(w, { name: 'welcome_note', language: 'hi' });
  });

  it('needs a connected WhatsApp account', async () => {
    const client = new Client(t.app);
    await client.signup();
    const res = await client.post('/templates', draft());
    expect(res.status).toBe(409);
    expect(res.body.code).toBe(ErrorCode.NUMBER_NOT_CONNECTED);
  });

  it('can change anything while a draft, including the name', async () => {
    const w = await workspace();
    const template = await create(w);
    const res = await w.client.patch(`/templates/${template.id}`, {
      name: 'renamed_one',
      language: 'hi',
      category: 'MARKETING',
      definition: { body: 'Hello {{first_name}}, big news for you.' },
      samples: { 'body.first_name': 'Asha', 'body.1': 'stale' },
      variableMapping: {
        'body.first_name': { source: 'contact', field: 'first_name' },
        'body.1': { source: 'static', value: 'stale' },
      },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      name: 'renamed_one',
      language: 'hi',
      category: 'MARKETING',
      parameterFormat: 'named',
      // Leftovers from removed variables are dropped.
      samples: { 'body.first_name': 'Asha' },
      variableMapping: { 'body.first_name': { source: 'contact', field: 'first_name' } },
    });
    expect(graph.calls).toEqual([]);
  });

  it('deletes a draft locally', async () => {
    const w = await workspace();
    const template = await create(w);
    expect((await w.client.delete(`/templates/${template.id}`)).status).toBe(204);
    expect((await w.client.get(`/templates/${template.id}`)).status).toBe(404);
    expect(graph.calls).toEqual([]);
  });
});

describe('submitting', () => {
  it('sends Meta the documented shape and stores its answer', async () => {
    const w = await workspace();
    const template = await create(w, {
      definition: {
        header: { format: 'TEXT', text: 'Order {{1}}' },
        body: 'Hi {{1}}, your order is ready.',
        footer: 'Thanks',
        buttons: [{ type: 'URL', text: 'Track', url: 'https://example.com/t/{{1}}' }],
      },
      samples: { 'header.1': '42', 'body.1': 'Asha', 'button.0.1': 'abc' },
    });
    const res = await w.client.post(`/templates/${template.id}/submit`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('pending');
    expect(res.body.metaTemplateId).toBeTruthy();

    const [call] = graph.of('POST', `/${w.wabaId}/message_templates`);
    expect(call?.body).toEqual({
      name: template.name,
      language: 'en_US',
      category: 'UTILITY',
      parameter_format: 'positional',
      components: [
        { type: 'HEADER', format: 'TEXT', text: 'Order {{1}}', example: { header_text: ['42'] } },
        {
          type: 'BODY',
          text: 'Hi {{1}}, your order is ready.',
          example: { body_text: [['Asha']] },
        },
        { type: 'FOOTER', text: 'Thanks' },
        {
          type: 'BUTTONS',
          buttons: [
            { type: 'URL', text: 'Track', url: 'https://example.com/t/{{1}}', example: ['abc'] },
          ],
        },
      ],
    });
  });

  it("shows Meta's error, and leaves the draft as it was", async () => {
    const w = await workspace();
    const template = await create(w);
    graph.failNext = {
      status: 400,
      code: 100,
      message: 'Content in This Language Already Exists',
    };
    const res = await w.client.post(`/templates/${template.id}/submit`);
    expect(res.status).toBe(502);
    expect(res.body.message).toContain('Already Exists');
    expect((await w.client.get(`/templates/${template.id}`)).body.status).toBe('draft');
  });

  it('cannot submit twice', async () => {
    const w = await workspace();
    const template = await submitted(w);
    const res = await w.client.post(`/templates/${template.id}/submit`);
    expect(res.status).toBe(409);
    expect(graph.calls).toEqual([]);
  });

  it('audits it', async () => {
    const w = await workspace();
    await submitted(w);
    const audit = await w.client.get('/orgs/current/audit-logs?limit=20');
    expect(audit.body.items.map((a: { action: string }) => a.action)).toContain(
      'template.submitted',
    );
  });
});

describe('media headers', () => {
  const imageDraft = {
    definition: { header: { format: 'IMAGE' }, body: 'Our new menu is out today.' },
    samples: {},
  };

  it('needs a file before submitting', async () => {
    const w = await workspace();
    const template = await create(w, imageDraft);
    const res = await w.client.post(`/templates/${template.id}/submit`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(ErrorCode.TEMPLATE_INVALID);
    expect(graph.calls).toEqual([]);
  });

  it('uploads the sample by the resumable steps and passes the handle on', async () => {
    const w = await workspace();
    const template = await create(w, imageDraft);
    const up = await uploadHeader(w, template.id, 'menu.jpg', 'image/jpeg');
    expect(up.status).toBe(200);
    expect(up.body.headerMedia).toEqual({ mimeType: 'image/jpeg', filename: 'menu.jpg' });
    // Nothing goes to Meta until it is submitted.
    expect(graph.calls).toEqual([]);

    const res = await w.client.post(`/templates/${template.id}/submit`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const [open] = graph.of('POST', '/app-1/uploads');
    expect(open?.query.get('file_type')).toBe('image/jpeg');
    expect(open?.query.get('file_length')).toBe('16');
    expect(open?.query.get('file_name')).toBe('menu.jpg');
    const [send] = graph.of('POST', '/upload:session-1');
    expect(send?.auth).toBe('OAuth token');
    const [created] = graph.of('POST', '/message_templates');
    expect(created?.body).toMatchObject({
      components: [
        { type: 'HEADER', format: 'IMAGE', example: { header_handle: ['4::sample-handle'] } },
        { type: 'BODY' },
      ],
    });
  });

  it('applies type and size limits, and refuses non-media headers', async () => {
    const w = await workspace();
    const template = await create(w, imageDraft);
    const wrongType = await uploadHeader(w, template.id, 'a.gif', 'image/gif');
    expect(wrongType.status).toBe(400);
    expect(wrongType.body.code).toBe(ErrorCode.MEDIA_NOT_ALLOWED);
    const tooBig = await uploadHeader(w, template.id, 'a.jpg', 'image/jpeg', 5 * 1024 * 1024 + 1);
    expect(tooBig.status).toBe(400);
    const plain = await create(w);
    expect((await uploadHeader(w, plain.id, 'a.jpg', 'image/jpeg')).status).toBe(400);
  });

  it('gives a short-lived link, and no storage key in any response', async () => {
    const w = await workspace();
    const template = await create(w, imageDraft);
    const up = await uploadHeader(w, template.id, 'menu.jpg', 'image/jpeg');
    expect(JSON.stringify(up.body)).not.toContain('orgs/');
    const link = await w.client.get(`/templates/${template.id}/header-media`);
    expect(link.status).toBe(200);
    expect(link.body.expiresIn).toBe(300);
  });
});

describe('editing a submitted template', () => {
  const edited = (over: Record<string, unknown> = {}) => ({
    category: 'UTILITY',
    definition: { body: 'Hello {{1}}, your order can be collected.' },
    samples: { 'body.1': 'Asha' },
    ...over,
  });

  it.each(['approved', 'rejected', 'paused'])('goes to Meta first when %s', async (status) => {
    const w = await workspace();
    const template = await submitted(w);
    await setStatus(w, template.id, status);
    const res = await w.client.patch(`/templates/${template.id}`, edited());
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      status: 'pending',
      definition: { body: 'Hello {{1}}, your order can be collected.' },
    });
    const [call] = graph.of('POST', `/${template.metaTemplateId}`);
    expect(call?.body).toMatchObject({ components: [{ type: 'BODY' }] });
  });

  it('saves nothing if Meta refuses', async () => {
    const w = await workspace();
    const template = await submitted(w);
    await setStatus(w, template.id, 'approved');
    graph.failNext = { status: 400, code: 100, message: 'You have reached the edit limit' };
    const res = await w.client.patch(`/templates/${template.id}`, edited());
    expect(res.status).toBe(502);
    expect(res.body.message).toContain('edit limit');
    const after = (await w.client.get(`/templates/${template.id}`)).body;
    expect(after).toMatchObject({ status: 'approved', definition: template.definition });
  });

  it.each(['pending', 'disabled', 'in_appeal', 'pending_deletion', 'archived'])(
    'refuses while %s',
    async (status) => {
      const w = await workspace();
      const template = await submitted(w);
      await setStatus(w, template.id, status);
      const res = await w.client.patch(`/templates/${template.id}`, edited());
      expect(res.status).toBe(409);
      expect(res.body.code).toBe(ErrorCode.TEMPLATE_NOT_EDITABLE);
      expect(graph.calls).toEqual([]);
    },
  );

  it('keeps the name and language, and an approved template keeps its category', async () => {
    const w = await workspace();
    const template = await submitted(w);
    await setStatus(w, template.id, 'approved');
    const renamed = await w.client.patch(`/templates/${template.id}`, edited({ name: 'other' }));
    expect(renamed.status).toBe(409);
    const recategorized = await w.client.patch(
      `/templates/${template.id}`,
      edited({ category: 'MARKETING' }),
    );
    expect(recategorized.status).toBe(409);
    expect(graph.calls).toEqual([]);
  });

  it('a mapping-only change stays local and keeps the template approved', async () => {
    const w = await workspace();
    const template = await submitted(w);
    await setStatus(w, template.id, 'approved');
    const res = await w.client.patch(`/templates/${template.id}`, {
      category: 'UTILITY',
      definition: template.definition,
      samples: template.samples,
      variableMapping: { 'body.1': { source: 'contact', field: 'first_name' } },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'approved',
      variableMapping: { 'body.1': { source: 'contact', field: 'first_name' } },
    });
    expect(graph.calls).toEqual([]);
  });

  it('refuses templates this app cannot represent', async () => {
    const w = await workspace();
    const template = await submitted(w);
    await withTenant(db, { orgId: w.orgId }, (tx) =>
      tx.messageTemplate.update({
        where: { id: template.id },
        data: { status: 'approved', supported: false },
      }),
    );
    const res = await w.client.patch(`/templates/${template.id}`, edited());
    expect(res.status).toBe(409);
    expect(res.body.message).toContain('WhatsApp Manager');
  });
});

describe('deleting a submitted template', () => {
  it('removes only this language at Meta, then locally', async () => {
    const w = await workspace();
    const template = await submitted(w);
    expect((await w.client.delete(`/templates/${template.id}`)).status).toBe(204);
    const [call] = graph.of('DELETE', `/${w.wabaId}/message_templates`);
    expect(call?.query.get('name')).toBe(template.name);
    expect(call?.query.get('hsm_id')).toBe(template.metaTemplateId);
    expect((await w.client.get(`/templates/${template.id}`)).status).toBe(404);
  });

  it('keeps it if Meta refuses', async () => {
    const w = await workspace();
    const template = await submitted(w);
    graph.failNext = { status: 400, code: 100, message: 'Disabled templates cannot be deleted' };
    const res = await w.client.delete(`/templates/${template.id}`);
    expect(res.status).toBe(502);
    expect((await w.client.get(`/templates/${template.id}`)).status).toBe(200);
  });
});

describe('syncing with Meta', () => {
  const remote = (over: Record<string, unknown> = {}) => ({
    id: metaId(),
    name: 'from_meta',
    language: 'en_US',
    category: 'UTILITY',
    status: 'APPROVED',
    components: [{ type: 'BODY', text: 'Hi {{1}}, thanks.', example: { body_text: [['Asha']] } }],
    ...over,
  });

  it('brings in templates made in Meta tools', async () => {
    const w = await workspace();
    graph.list = [remote(), remote({ name: 'code', category: 'AUTHENTICATION' })];
    const res = await w.client.post('/templates/sync');
    expect(res.body).toEqual({ changed: 2 });
    const list = await w.client.get('/templates');
    const byName = Object.fromEntries(list.body.items.map((x: { name: string }) => [x.name, x]));
    expect(byName.from_meta).toMatchObject({
      status: 'approved',
      supported: true,
      definition: { body: 'Hi {{1}}, thanks.' },
      samples: { 'body.1': 'Asha' },
    });
    expect(byName.code.supported).toBe(false);
  });

  it('applies rejection reasons, and a second run changes nothing', async () => {
    const w = await workspace();
    graph.list = [remote({ status: 'REJECTED', rejected_reason: 'PROMOTIONAL' })];
    await w.client.post('/templates/sync');
    expect((await w.client.post('/templates/sync')).body).toEqual({ changed: 0 });
    const list = await w.client.get('/templates?status=rejected');
    expect(list.body.items[0]).toMatchObject({ rejectedReason: 'PROMOTIONAL' });
  });

  it('finishes a submit that crashed after Meta accepted it', async () => {
    const w = await workspace();
    const template = await create(w, { name: 'half_done' });
    graph.list = [remote({ name: 'half_done', status: 'PENDING' })];
    await w.client.post('/templates/sync');
    const after = (await w.client.get(`/templates/${template.id}`)).body;
    expect(after.status).toBe('pending');
    expect(after.metaTemplateId).toBe(graph.list[0]?.id);
  });

  it('keeps the local mapping and marks what Meta no longer has', async () => {
    const w = await workspace();
    const template = await submitted(w, {
      variableMapping: { 'body.1': { source: 'contact', field: 'first_name' } },
    });
    // Submitted long enough ago that being absent means it is really gone.
    await withTenant(db, { orgId: w.orgId }, (tx) =>
      tx.messageTemplate.update({
        where: { id: template.id },
        data: { submittedAt: new Date(Date.now() - 3600_000) },
      }),
    );
    graph.list = [];
    await w.client.post('/templates/sync');
    const after = (await w.client.get(`/templates/${template.id}`)).body;
    expect(after).toMatchObject({
      status: 'deleted',
      variableMapping: { 'body.1': { source: 'contact', field: 'first_name' } },
    });
    expect((await w.client.get('/templates')).body.items).toEqual([]);
  });

  it('does not mistake a just-submitted template for a deleted one', async () => {
    const w = await workspace();
    const template = await submitted(w);
    graph.list = [];
    await w.client.post('/templates/sync');
    expect((await w.client.get(`/templates/${template.id}`)).body.status).toBe('pending');
  });

  it('leaves drafts alone', async () => {
    const w = await workspace();
    const template = await create(w);
    graph.list = [];
    await w.client.post('/templates/sync');
    expect((await w.client.get(`/templates/${template.id}`)).body.status).toBe('draft');
  });
});

describe('the inbox picker', () => {
  it('fills variables from the contact, and an agent can send', async () => {
    const w = await workspace();
    const { conversationId } = await withTenant(db, { orgId: w.orgId }, async (tx) => {
      const phone = await tx.phoneNumber.findFirstOrThrow({ where: { orgId: w.orgId } });
      const contact = await tx.contact.create({
        data: {
          orgId: w.orgId,
          waId: '919876543210',
          name: 'Asha Rao',
          customFields: { plan: 'gold' },
        },
      });
      const c = await tx.conversation.create({
        data: {
          orgId: w.orgId,
          phoneId: phone.id,
          channelId: await whatsappChannelId(tx, phone.id),
          contactId: contact.id,
        },
      });
      await tx.wabaAccount.update({
        where: { id: w.wabaAccountId },
        data: { templatesSyncedAt: new Date() },
      });
      await ensureWallet(tx, w.orgId, 'INR');
      await creditWallet(tx, { orgId: w.orgId, amountMicros: 1_000_000, idempotencyKey: 'seed' });
      return { conversationId: c.id };
    });
    const template = await submitted(w, {
      definition: {
        body: 'Hi {{1}}, your {{2}} plan renews soon for {{3}} today.',
        buttons: [{ type: 'COPY_CODE', example: 'SAVE10' }],
      },
      samples: { 'body.1': 'Asha', 'body.2': 'gold', 'body.3': 'you' },
      variableMapping: {
        'body.1': { source: 'contact', field: 'first_name' },
        'body.2': { source: 'custom', key: 'plan' },
      },
    });
    await setStatus(w, template.id, 'approved');

    const email = uniqueEmail('agent');
    await w.client.post('/team/invitations', { email, role: 'agent' });
    const agent = new Client(t.app);
    await agent.post('/invitations/accept', {
      token: tokenFromMail(t.mailer, email),
      name: 'Agent',
      password: 'correct-horse-battery',
    });

    const res = await agent.get(`/inbox/conversations/${conversationId}/templates`);
    expect(res.status).toBe(200);
    expect(res.body[0].cost).toEqual({ micros: 1, currency: 'INR' });
    expect(res.body[0].variables).toEqual([
      { key: 'body.1', label: 'Body {{1}}', value: 'Asha' },
      { key: 'body.2', label: 'Body {{2}}', value: 'gold' },
      { key: 'body.3', label: 'Body {{3}}', value: '' },
      { key: 'button.0.code', label: 'Offer code', value: 'SAVE10' },
    ]);

    const sent = await agent.post(`/inbox/conversations/${conversationId}/messages`, {
      type: 'template',
      clientMessageId: randomUUID(),
      templateId: template.id,
      variables: {
        'body.1': 'Asha',
        'body.2': 'gold\n\n',
        'body.3': 'you',
        'button.0.code': 'SAVE10',
      },
    });
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    expect(sent.body.body).toBe('Hi Asha, your gold plan renews soon for you today.');
    const row = await withTenant(db, { orgId: w.orgId }, (tx) =>
      tx.message.findFirstOrThrow({ where: { id: sent.body.id } }),
    );
    expect(row.content).toMatchObject({
      templateName: template.name,
      category: 'UTILITY',
      components: [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: 'Asha' },
            // Line breaks removed, since Meta refuses them.
            { type: 'text', text: 'gold' },
            { type: 'text', text: 'you' },
          ],
        },
        {
          type: 'button',
          subType: 'copy_code',
          index: 0,
          parameters: [{ type: 'coupon_code', extra: { coupon_code: 'SAVE10' } }],
        },
      ],
    });
  });
});

describe('permissions and isolation', () => {
  it('agents can read templates but not change them', async () => {
    const w = await workspace();
    const template = await create(w);
    const email = uniqueEmail('agent');
    await w.client.post('/team/invitations', { email, role: 'agent' });
    const agent = new Client(t.app);
    await agent.post('/invitations/accept', {
      token: tokenFromMail(t.mailer, email),
      name: 'Agent',
      password: 'correct-horse-battery',
    });
    expect((await agent.get('/templates')).status).toBe(200);
    expect((await agent.get(`/templates/${template.id}`)).status).toBe(200);
    for (const res of [
      await agent.post('/templates', draft()),
      await agent.patch(`/templates/${template.id}`, draft()),
      await agent.post(`/templates/${template.id}/submit`),
      await agent.post('/templates/sync'),
      await agent.delete(`/templates/${template.id}`),
    ]) {
      expect(res.status).toBe(403);
    }
  });

  it('another workspace cannot see or touch a template', async () => {
    const a = await workspace();
    const b = await workspace();
    const template = await create(a);
    expect((await b.client.get(`/templates/${template.id}`)).status).toBe(404);
    expect((await b.client.patch(`/templates/${template.id}`, draft())).status).toBe(404);
    expect((await b.client.post(`/templates/${template.id}/submit`)).status).toBe(404);
    expect((await b.client.delete(`/templates/${template.id}`)).status).toBe(404);
    expect((await b.client.get(`/templates/${template.id}/header-media`)).status).toBe(404);
    expect((await b.client.get('/templates')).body.items).toEqual([]);
    // Nor can it create a template on another workspace's account.
    const onTheirs = await b.client.post('/templates', draft({ wabaAccountId: a.wabaAccountId }));
    expect(onTheirs.status).toBe(409);
    expect(graph.calls).toEqual([]);
  });
});
