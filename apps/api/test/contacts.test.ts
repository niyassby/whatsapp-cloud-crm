import { randomBytes, randomUUID } from 'node:crypto';
import { withTenant, whatsappChannelId } from '@wacrm/db';
import { createPrismaClient, type DbClient } from '@wacrm/db';
import { QueueName } from '@wacrm/shared';
import { Queue } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QueuesService } from '../src/infra/queues.service';
import { buildApp, Client, type TestApp, tokenFromMail, uniqueEmail, urls } from './helpers';

let t: TestApp;
let db: DbClient;

beforeAll(async () => {
  t = await buildApp();
  db = createPrismaClient({ connectionString: urls.appUrl });
});
afterAll(async () => {
  await t.close();
  await db.$disconnect();
});

async function owner() {
  const client = new Client(t.app);
  const account = await client.signup();
  return { client, orgId: account.orgId, userId: account.userId };
}

async function agentOf(ownerClient: Client) {
  const email = uniqueEmail('agent');
  const invite = await ownerClient.post('/team/invitations', { email, role: 'agent' });
  expect(invite.status).toBe(201);
  const client = new Client(t.app);
  const accepted = await client.post('/invitations/accept', {
    token: tokenFromMail(t.mailer, email),
    name: 'Agent',
    password: 'correct-horse-battery',
  });
  expect(accepted.status).toBe(200);
  return client;
}

const newContact = async (client: Client, over: Record<string, unknown> = {}) => {
  const res = await client.post('/contacts', { phone: '+919876543210', name: 'Asha', ...over });
  expect(res.status).toBe(201);
  return res.body;
};

let phoneCounter = 0;
const nextPhone = () => `+9198765${String(10_000 + phoneCounter++)}`;

describe('contact CRUD', () => {
  it('creates with a normalized number and reads it back', async () => {
    const { client } = await owner();
    const created = await newContact(client, { phone: '98765 43210', defaultCountry: 'IN' });
    expect(created).toMatchObject({
      waId: '919876543210',
      name: 'Asha',
      optInStatus: 'unknown',
      tags: [],
      customFields: {},
    });
    const read = await client.get(`/contacts/${created.id}`);
    expect(read.body.id).toBe(created.id);
  });

  it('refuses a bad number and a duplicate', async () => {
    const { client } = await owner();
    const bad = await client.post('/contacts', { phone: '12345' });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('INVALID_PHONE');
    const first = await newContact(client);
    const dup = await client.post('/contacts', { phone: '+91 98765 43210' });
    expect(dup.status).toBe(409);
    expect(dup.body).toMatchObject({ code: 'CONTACT_EXISTS', details: { contactId: first.id } });
  });

  it('keeps consent when a deleted contact is added back', async () => {
    const { client } = await owner();
    const contact = await newContact(client);
    await client.post(`/contacts/${contact.id}/consent`, { status: 'opted_out' });
    expect((await client.delete(`/contacts/${contact.id}`)).status).toBe(204);
    expect((await client.get(`/contacts/${contact.id}`)).status).toBe(404);
    const again = await client.post('/contacts', { phone: '+919876543210', name: 'New' });
    expect(again.status).toBe(201);
    expect(again.body).toMatchObject({ id: contact.id, name: 'New', optInStatus: 'opted_out' });
  });

  it('pages by cursor, searches and filters', async () => {
    const { client } = await owner();
    const tag = (await client.post('/contact-tags', { name: 'vip' })).body;
    const created: string[] = [];
    for (const name of ['Ana', 'Ben', 'Cam']) {
      const c = await newContact(client, { phone: nextPhone(), name });
      created.push(c.id);
    }
    await client.req('PUT', `/contacts/${created[0]}/tags`, { tagIds: [tag.id] });

    const first = await client.get('/contacts?limit=2');
    expect(first.body.items.map((c: { name: string }) => c.name)).toEqual(['Cam', 'Ben']);
    const second = await client.get(`/contacts?limit=2&cursor=${first.body.nextCursor}`);
    expect(second.body.items.map((c: { name: string }) => c.name)).toEqual(['Ana']);
    expect(second.body.nextCursor).toBeNull();

    const search = await client.get('/contacts?q=ben');
    expect(search.body.items).toHaveLength(1);
    const tagged = await client.get(`/contacts?tagId=${tag.id}`);
    expect(tagged.body.items.map((c: { id: string }) => c.id)).toEqual([created[0]]);
    expect((await client.get(`/contacts/count?tagId=${tag.id}`)).body).toEqual({ count: 1 });
    expect((await client.get('/contacts/count')).body).toEqual({ count: 3 });
  });
});

describe('custom fields', () => {
  it('validates values against their type, and a null removes one', async () => {
    const { client } = await owner();
    const field = await client.post('/contact-fields', {
      key: 'age',
      label: 'Age',
      type: 'number',
    });
    expect(field.status).toBe(201);
    await client.post('/contact-fields', {
      key: 'plan',
      label: 'Plan',
      type: 'select',
      options: ['gold', 'silver'],
    });
    const contact = await newContact(client, { customFields: { age: '41', plan: 'gold' } });
    expect(contact.customFields).toEqual({ age: 41, plan: 'gold' });

    const bad = await client.patch(`/contacts/${contact.id}`, { customFields: { age: 'old' } });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toContain('Age');
    const unknown = await client.patch(`/contacts/${contact.id}`, { customFields: { nope: 1 } });
    expect(unknown.status).toBe(400);
    const notOption = await client.patch(`/contacts/${contact.id}`, {
      customFields: { plan: 'bronze' },
    });
    expect(notOption.status).toBe(400);

    const removed = await client.patch(`/contacts/${contact.id}`, { customFields: { age: null } });
    expect(removed.body.customFields).toEqual({ plan: 'gold' });
  });

  it('a select field needs options, and keys are unique', async () => {
    const { client } = await owner();
    const noOptions = await client.post('/contact-fields', {
      key: 'x',
      label: 'X',
      type: 'select',
    });
    expect(noOptions.status).toBe(400);
    await client.post('/contact-fields', { key: 'dup', label: 'Dup', type: 'text' });
    const again = await client.post('/contact-fields', { key: 'dup', label: 'Dup', type: 'text' });
    expect(again.status).toBe(409);
  });
});

describe('notes', () => {
  it('authors can delete their own; others need the manage permission', async () => {
    const { client } = await owner();
    const agent = await agentOf(client);
    const contact = await newContact(client);
    const mine = await agent.post(`/contacts/${contact.id}/notes`, { body: 'From agent' });
    expect(mine.status).toBe(201);
    const ownerNote = await client.post(`/contacts/${contact.id}/notes`, { body: 'From owner' });

    expect((await agent.delete(`/contacts/${contact.id}/notes/${ownerNote.body.id}`)).status).toBe(
      403,
    );
    expect((await agent.delete(`/contacts/${contact.id}/notes/${mine.body.id}`)).status).toBe(204);
    expect((await client.delete(`/contacts/${contact.id}/notes/${ownerNote.body.id}`)).status).toBe(
      204,
    );
    expect((await client.get(`/contacts/${contact.id}/notes`)).body).toEqual([]);
  });
});

describe('consent', () => {
  it('opting in needs proof; opting out does not', async () => {
    const { client } = await owner();
    const contact = await newContact(client);
    const noProof = await client.post(`/contacts/${contact.id}/consent`, {
      status: 'opted_in',
      source: 'Form',
    });
    expect(noProof.status).toBe(400);
    const unknown = await client.post(`/contacts/${contact.id}/consent`, { status: 'unknown' });
    expect(unknown.status).toBe(400);

    const yes = await client.post(`/contacts/${contact.id}/consent`, {
      status: 'opted_in',
      source: 'Form',
      proof: 'Ticked the box on example.com/join',
    });
    expect(yes.body).toMatchObject({ optInStatus: 'opted_in', optInSource: 'Form' });
    expect(yes.body.optInAt).toBeTruthy();

    const no = await client.post(`/contacts/${contact.id}/consent`, { status: 'opted_out' });
    expect(no.body.optInStatus).toBe('opted_out');
    expect(no.body.optOutAt).toBeTruthy();
    // Saying the same thing again adds nothing.
    await client.post(`/contacts/${contact.id}/consent`, { status: 'opted_out' });

    const history = await client.get(`/contacts/${contact.id}/consent`);
    expect(history.body.map((e: { status: string }) => e.status)).toEqual([
      'opted_out',
      'opted_in',
    ]);
    expect(history.body[1].proof).toContain('example.com');
    expect(history.body[0].actorName).toBeTruthy();
  });

  it('manages the opt-out keyword list', async () => {
    const { client } = await owner();
    const before = await client.get('/contact-settings/opt-out-keywords');
    expect(before.body.isDefault).toBe(true);
    expect(before.body.keywords).toContain('stop');
    const after = await client.req('PUT', '/contact-settings/opt-out-keywords', {
      keywords: ['Band Karo', 'band karo', 'stop'],
    });
    expect(after.body).toEqual({ keywords: ['band karo', 'stop'], isDefault: false });
    expect(
      (await client.req('PUT', '/contact-settings/opt-out-keywords', { keywords: [] })).status,
    ).toBe(400);
  });
});

describe('merge', () => {
  it('moves everything to the primary and lets the opt-out win', async () => {
    const { client, orgId } = await owner();
    const tag = (await client.post('/contact-tags', { name: 'vip' })).body;
    await client.post('/contact-fields', { key: 'city', label: 'City', type: 'text' });
    await client.post('/contact-fields', { key: 'plan', label: 'Plan', type: 'text' });
    const primary = await newContact(client, {
      phone: nextPhone(),
      name: 'Primary',
      email: undefined,
      customFields: { city: 'Kochi' },
    });
    const dup = await newContact(client, {
      phone: nextPhone(),
      name: 'Dup',
      email: 'dup@example.com',
      customFields: { city: 'Delhi', plan: 'gold' },
      tagIds: [tag.id],
    });
    await client.post(`/contacts/${primary.id}/consent`, {
      status: 'opted_in',
      source: 'Form',
      proof: 'Signed up',
    });
    await client.post(`/contacts/${dup.id}/consent`, { status: 'opted_out' });
    await client.post(`/contacts/${dup.id}/notes`, { body: 'Note on dup' });

    const merged = await client.post('/contacts/merge', {
      primaryId: primary.id,
      duplicateIds: [dup.id],
    });
    expect(merged.status).toBe(200);
    expect(merged.body).toMatchObject({
      name: 'Primary',
      email: 'dup@example.com',
      customFields: { city: 'Kochi', plan: 'gold' },
      optInStatus: 'opted_out',
    });
    expect(merged.body.tags.map((x: { name: string }) => x.name)).toEqual(['vip']);
    expect((await client.get(`/contacts/${dup.id}`)).status).toBe(404);
    expect((await client.get(`/contacts/${primary.id}/notes`)).body).toHaveLength(1);

    // Proof from both records survives.
    const sources = (await client.get(`/contacts/${primary.id}/consent`)).body.map(
      (e: { source: string }) => e.source,
    );
    expect(sources).toEqual(expect.arrayContaining(['Form', 'manual', 'merge']));
    expect((await client.get('/contacts/count')).body).toEqual({ count: 1 });

    const row = await withTenant(db, { orgId }, (tx) =>
      tx.contact.findUniqueOrThrow({ where: { id: dup.id } }),
    );
    expect(row.mergedIntoId).toBe(primary.id);
  });

  it('carries consent over when nobody opted out', async () => {
    const { client } = await owner();
    const primary = await newContact(client, { phone: nextPhone() });
    const dup = await newContact(client, { phone: nextPhone() });
    await client.post(`/contacts/${dup.id}/consent`, {
      status: 'opted_in',
      source: 'Form',
      proof: 'Signed up',
    });
    const merged = await client.post('/contacts/merge', {
      primaryId: primary.id,
      duplicateIds: [dup.id],
    });
    expect(merged.body).toMatchObject({ optInStatus: 'opted_in', optInSource: 'merge' });
  });

  it('joins threads on the same number, without carrying the 24-hour window over', async () => {
    const { client, orgId } = await owner();
    const primary = await newContact(client, { phone: nextPhone() });
    const dup = await newContact(client, { phone: nextPhone() });
    const other = await newContact(client, { phone: nextPhone() });
    const open = new Date(Date.now() + 3_600_000);
    const ids = await withTenant(db, { orgId }, async (tx) => {
      const waba = await tx.wabaAccount.create({ data: { orgId, wabaId: randomUUID() } });
      const phones = await Promise.all(
        [0, 1].map(() =>
          tx.phoneNumber.create({
            data: {
              orgId,
              wabaAccountId: waba.id,
              phoneNumberId: randomUUID(),
              status: 'connected',
              credentialSource: 'manual',
            },
          }),
        ),
      );
      const target = await tx.conversation.create({
        data: {
          orgId,
          phoneId: phones[0]!.id,
          channelId: await whatsappChannelId(tx, phones[0]!.id),
          contactId: primary.id,
          unreadCount: 1,
        },
      });
      const source = await tx.conversation.create({
        data: {
          orgId,
          phoneId: phones[0]!.id,
          channelId: await whatsappChannelId(tx, phones[0]!.id),
          contactId: dup.id,
          unreadCount: 2,
          windowExpiresAt: open,
          lastMessageAt: new Date(),
          lastMessagePreview: 'from dup',
        },
      });
      const moved = await tx.conversation.create({
        data: {
          orgId,
          phoneId: phones[1]!.id,
          channelId: await whatsappChannelId(tx, phones[1]!.id),
          contactId: dup.id,
          windowExpiresAt: open,
        },
      });
      await tx.conversation.create({
        data: {
          orgId,
          phoneId: phones[1]!.id,
          channelId: await whatsappChannelId(tx, phones[1]!.id),
          contactId: other.id,
        },
      });
      await tx.message.create({
        data: {
          orgId,
          conversationId: source.id,
          direction: 'inbound',
          type: 'text',
          status: 'received',
          body: 'hello',
        },
      });
      return { target: target.id, source: source.id, moved: moved.id };
    });

    await client.post('/contacts/merge', { primaryId: primary.id, duplicateIds: [dup.id] });

    const state = await withTenant(db, { orgId }, async (tx) => ({
      target: await tx.conversation.findUniqueOrThrow({ where: { id: ids.target } }),
      source: await tx.conversation.findUniqueOrThrow({ where: { id: ids.source } }),
      moved: await tx.conversation.findUniqueOrThrow({ where: { id: ids.moved } }),
      inTarget: await tx.message.count({ where: { conversationId: ids.target } }),
    }));
    expect(state.inTarget).toBe(1);
    expect(state.target).toMatchObject({ unreadCount: 3, lastMessagePreview: 'from dup' });
    expect(state.target.windowExpiresAt).toBeNull();
    expect(state.source).toMatchObject({ unreadCount: 0, status: 'closed' });
    expect(state.moved.contactId).toBe(primary.id);
    expect(state.moved.windowExpiresAt).toBeNull();

    const list = await client.get('/contacts/' + primary.id + '/conversations');
    expect(list.body.map((c: { id: string }) => c.id).sort()).toEqual(
      [ids.target, ids.moved].sort(),
    );
    const inbox = await client.get('/inbox/conversations?status=any');
    expect(inbox.body.items.map((c: { id: string }) => c.id)).not.toContain(ids.source);
  });

  it('refuses a self-merge or a contact it cannot find', async () => {
    const { client } = await owner();
    const a = await newContact(client, { phone: nextPhone() });
    const self = await client.post('/contacts/merge', { primaryId: a.id, duplicateIds: [a.id] });
    expect(self.status).toBe(400);
    const missing = await client.post('/contacts/merge', {
      primaryId: a.id,
      duplicateIds: [randomUUID()],
    });
    expect(missing.status).toBe(404);
  });
});

describe('bulk actions', () => {
  it('adds and removes tags, opts out and deletes', async () => {
    const { client } = await owner();
    const tag = (await client.post('/contact-tags', { name: 'vip' })).body;
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await newContact(client, { phone: nextPhone() })).id);

    const bulk = (action: object, selected = ids) =>
      client.post('/contacts/bulk', { ids: selected, action });

    expect((await bulk({ type: 'add_tag', tagId: tag.id })).body).toEqual({ affected: 3 });
    expect((await bulk({ type: 'add_tag', tagId: tag.id })).body).toEqual({ affected: 0 });
    expect((await client.get(`/contacts/count?tagId=${tag.id}`)).body.count).toBe(3);
    expect((await bulk({ type: 'remove_tag', tagId: tag.id }, [ids[0]!])).body.affected).toBe(1);

    expect((await bulk({ type: 'opt_out' }, [ids[0]!, ids[1]!])).body.affected).toBe(2);
    expect((await bulk({ type: 'opt_out' }, [ids[0]!])).body.affected).toBe(0);
    expect((await client.get('/contacts/count?optIn=opted_out')).body.count).toBe(2);
    const history = await client.get(`/contacts/${ids[0]}/consent`);
    expect(history.body).toHaveLength(1);
    expect(history.body[0].source).toBe('bulk');

    expect((await bulk({ type: 'delete' }, [ids[2]!])).body.affected).toBe(1);
    expect((await client.get('/contacts/count')).body.count).toBe(2);
  });

  it('has no bulk opt-in', async () => {
    const { client } = await owner();
    const c = await newContact(client);
    const res = await client.post('/contacts/bulk', {
      ids: [c.id],
      action: { type: 'opt_in' },
    });
    expect(res.status).toBe(400);
  });
});

describe('segments', () => {
  it('saves a filter and returns correct counts, including after data changes', async () => {
    const { client } = await owner();
    const tag = (await client.post('/contact-tags', { name: 'vip' })).body;
    const a = await newContact(client, { phone: nextPhone(), tagIds: [tag.id] });
    const b = await newContact(client, { phone: nextPhone(), tagIds: [tag.id] });
    await newContact(client, { phone: nextPhone() });
    await client.post(`/contacts/${a.id}/consent`, {
      status: 'opted_in',
      source: 'Form',
      proof: 'Signed up',
    });

    const filter = {
      match: 'all',
      rules: [
        { field: 'tag', op: 'has', tagId: tag.id },
        { field: 'opt_in', op: 'is', value: 'opted_in' },
      ],
    };
    expect((await client.post('/segments/preview', { filter })).body).toEqual({ count: 1 });
    const segment = await client.post('/segments', { name: 'VIP opted in', filter });
    expect(segment.status).toBe(201);
    expect((await client.get(`/segments/${segment.body.id}/count`)).body).toEqual({ count: 1 });

    const listed = await client.get(`/contacts?segmentId=${segment.body.id}`);
    expect(listed.body.items.map((c: { id: string }) => c.id)).toEqual([a.id]);
    expect((await client.get(`/contacts/count?segmentId=${segment.body.id}`)).body.count).toBe(1);

    await client.post(`/contacts/${b.id}/consent`, {
      status: 'opted_in',
      source: 'Form',
      proof: 'Signed up',
    });
    expect((await client.get(`/segments/${segment.body.id}/count`)).body).toEqual({ count: 2 });

    const renamed = await client.patch(`/segments/${segment.body.id}`, { name: 'Renamed' });
    expect(renamed.body.name).toBe('Renamed');
    expect((await client.delete(`/segments/${segment.body.id}`)).status).toBe(204);
    expect((await client.get(`/contacts?segmentId=${segment.body.id}`)).status).toBe(404);
  });

  it('rejects a malformed filter', async () => {
    const { client } = await owner();
    const res = await client.post('/segments/preview', {
      filter: { rules: [{ field: 'sql', op: 'drop' }] },
    });
    expect(res.status).toBe(400);
  });
});

describe('permissions', () => {
  it('agents work with single contacts, not whole-list operations', async () => {
    const { client } = await owner();
    const agent = await agentOf(client);
    const contact = await newContact(client);
    const other = await newContact(client, { phone: nextPhone() });

    expect((await agent.get('/contacts')).status).toBe(200);
    expect((await agent.patch(`/contacts/${contact.id}`, { name: 'Edited' })).status).toBe(200);
    expect((await agent.post('/contact-tags', { name: 'by agent' })).status).toBe(201);
    expect(
      (await agent.post(`/contacts/${contact.id}/consent`, { status: 'opted_out' })).status,
    ).toBe(200);

    for (const res of [
      await agent.delete(`/contacts/${contact.id}`),
      await agent.post('/contacts/merge', { primaryId: contact.id, duplicateIds: [other.id] }),
      await agent.post('/contacts/bulk', { ids: [contact.id], action: { type: 'delete' } }),
      await agent.post('/contact-jobs/export', {}),
      await agent.get('/contact-jobs'),
      await agent.post('/contact-fields', { key: 'x', label: 'X', type: 'text' }),
      await agent.post('/segments', { name: 'S', filter: { rules: [] } }),
      await agent.req('PUT', '/contact-settings/opt-out-keywords', { keywords: ['x'] }),
    ]) {
      expect(res.status).toBe(403);
    }
  });
});

describe('tenant isolation over HTTP', () => {
  it('another workspace cannot see or touch contacts', async () => {
    const a = await owner();
    const b = await owner();
    const contact = await newContact(a.client);
    const tag = (await a.client.post('/contact-tags', { name: 'vip' })).body;
    const segment = (await a.client.post('/segments', { name: 'S', filter: { rules: [] } })).body;
    const own = await newContact(b.client, { phone: nextPhone() });

    expect((await b.client.get(`/contacts/${contact.id}`)).status).toBe(404);
    expect((await b.client.patch(`/contacts/${contact.id}`, { name: 'x' })).status).toBe(404);
    expect((await b.client.delete(`/contacts/${contact.id}`)).status).toBe(404);
    expect((await b.client.get(`/contacts/${contact.id}/notes`)).status).toBe(404);
    expect((await b.client.get(`/contacts/${contact.id}/consent`)).status).toBe(404);
    expect(
      (await b.client.post(`/contacts/${contact.id}/consent`, { status: 'opted_out' })).status,
    ).toBe(404);
    expect((await b.client.get(`/segments/${segment.id}/count`)).status).toBe(404);
    expect((await b.client.get(`/contacts?segmentId=${segment.id}`)).status).toBe(404);
    expect(
      (await b.client.req('PUT', `/contacts/${own.id}/tags`, { tagIds: [tag.id] })).status,
    ).toBe(400);
    expect(
      (
        await b.client.post('/contacts/merge', {
          primaryId: own.id,
          duplicateIds: [contact.id],
        })
      ).status,
    ).toBe(404);
    const bulk = await b.client.post('/contacts/bulk', {
      ids: [contact.id],
      action: { type: 'delete' },
    });
    expect(bulk.body.affected).toBe(0);
    expect((await a.client.get(`/contacts/${contact.id}`)).status).toBe(200);
    expect((await b.client.get('/contacts/count')).body.count).toBe(1);
  });

  it('the same number can be a contact in two workspaces', async () => {
    const a = await owner();
    const b = await owner();
    const ca = await newContact(a.client);
    const cb = await newContact(b.client);
    expect(ca.waId).toBe(cb.waId);
    expect(ca.id).not.toBe(cb.id);
  });
});

function multipart(options: unknown, csv: string, filename = 'contacts.csv') {
  const boundary = `----test${randomBytes(8).toString('hex')}`;
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="options"\r\n\r\n${JSON.stringify(options)}\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        `Content-Type: text/csv\r\n\r\n`,
    ),
    Buffer.from(csv),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

async function upload(client: Client, options: unknown, csv: string, filename?: string) {
  const { payload, headers } = multipart(options, csv, filename);
  const res = await t.app.inject({
    method: 'POST',
    url: '/contact-jobs/import',
    payload,
    headers: { ...headers, authorization: `Bearer ${client.accessToken}` },
  });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

describe('import and export jobs', () => {
  const columns = { phone: 'Phone', fields: {} };

  it('stores the file and queues a job, without parsing it in the request', async () => {
    const { client, orgId } = await owner();
    const queues = t.app.get(QueuesService);
    // Far more rows than the API could parse quickly, and every one of them invalid: a request
    // that parsed the file would report that here.
    const big = `Phone\n${'nope\n'.repeat(200_000)}`;
    const started = Date.now();
    const res = await upload(client, { columns }, big);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      kind: 'import',
      status: 'queued',
      processedRows: 0,
      errorCount: 0,
      filename: 'contacts.csv',
    });
    expect(Date.now() - started).toBeLessThan(5_000);

    const job = await queues.contactJobs.getJob(res.body.id);
    expect(job?.data).toEqual({ orgId, jobId: res.body.id });
    const stored = await t.storage.get(`orgs/${orgId}/contact-jobs/${res.body.id}/source.csv`);
    expect(stored.length).toBe(Buffer.byteLength(big));
    expect((await client.get(`/contact-jobs/${res.body.id}`)).body.id).toBe(res.body.id);
    expect((await client.get('/contact-jobs')).body).toHaveLength(1);
  });

  it('uses a queue separate from inbox traffic', () => {
    expect(QueueName.CONTACT_JOBS).not.toBe(QueueName.OUTBOUND);
    expect(t.app.get(QueuesService).contactJobs).toBeInstanceOf(Queue);
  });

  it('refuses a missing column, an unknown field, bad options and other file types', async () => {
    const { client } = await owner();
    const csv = 'Phone,Name\n+919876543210,Asha\n';
    const missing = await upload(client, { columns: { phone: 'Mobile', fields: {} } }, csv);
    expect(missing.status).toBe(400);
    expect(missing.body.message).toContain('Mobile');

    const field = await upload(
      client,
      { columns: { phone: 'Phone', fields: { nope: 'Name' } } },
      csv,
    );
    expect(field.status).toBe(400);

    const noProof = await upload(client, { columns, consent: { source: 'Form' } }, csv);
    expect(noProof.status).toBe(400);

    const wrongType = await upload(client, { columns }, csv, 'contacts.xlsx');
    expect(wrongType.status).toBe(400);
  });

  it('starts an export with the segment resolved, and audits it', async () => {
    const { client, orgId } = await owner();
    const segment = (
      await client.post('/segments', {
        name: 'S',
        filter: { rules: [{ field: 'opt_in', op: 'is', value: 'opted_in' }] },
      })
    ).body;
    const res = await client.post('/contact-jobs/export', { segmentId: segment.id });
    expect(res.status).toBe(201);
    const row = await withTenant(db, { orgId }, (tx) =>
      tx.contactJob.findUniqueOrThrow({ where: { id: res.body.id } }),
    );
    expect(row.options).toMatchObject({ segment: { rules: [{ field: 'opt_in' }] } });

    const audit = await client.get('/orgs/current/audit-logs?limit=20');
    expect(audit.status).toBe(200);
    const actions = (audit.body.items as { action: string }[]).map((a) => a.action);
    expect(actions).toContain('contact.export_started');
  });

  it('gives a download link only when a file exists, and only to its workspace', async () => {
    const a = await owner();
    const b = await owner();
    const started = (await a.client.post('/contact-jobs/export', {})).body;
    expect((await a.client.post(`/contact-jobs/${started.id}/download`)).status).toBe(404);

    await withTenant(db, { orgId: a.orgId }, (tx) =>
      tx.contactJob.update({
        where: { id: started.id },
        data: {
          status: 'completed',
          resultKey: `orgs/${a.orgId}/contact-jobs/${started.id}/r.csv`,
        },
      }),
    );
    const link = await a.client.post(`/contact-jobs/${started.id}/download`);
    expect(link.status).toBe(200);
    expect(link.body.url).toBeTruthy();
    expect((await b.client.post(`/contact-jobs/${started.id}/download`)).status).toBe(404);
    expect((await b.client.get(`/contact-jobs/${started.id}`)).status).toBe(404);
  });
});
