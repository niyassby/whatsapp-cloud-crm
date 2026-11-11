/** Flow definitions, publishing, versions and runs over real HTTP. The engine is tested in the worker. */
import { randomBytes, randomUUID } from 'node:crypto';
import { createPrismaClient, type DbClient, withTenant } from '@wacrm/db';
import { ErrorCode, type FlowDefinitionInput } from '@wacrm/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { QueuesService } from '../src/infra/queues.service';
import { buildApp, Client, type TestApp, tokenFromMail, uniqueEmail, urls } from './helpers';

let t: TestApp;
let owner: DbClient;

beforeAll(async () => {
  t = await buildApp();
  owner = createPrismaClient({ connectionString: urls.directUrl });
});
afterAll(async () => {
  await t?.close();
  await owner?.$disconnect();
});

async function workspace() {
  const client = new Client(t.app);
  const { orgId, userId } = await client.signup();
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
  return { client, orgId, userId, join };
}

const DEF: FlowDefinitionInput = {
  trigger: { type: 'keyword', matchType: 'contains', keywords: ['hello'] },
  startNodeId: 'greet',
  nodes: [
    { id: 'greet', type: 'send_message', data: { text: 'Hi {{contact.name}}' } },
    { id: 'done', type: 'end' },
  ],
  edges: [{ id: 'e1', source: 'greet', sourceHandle: 'next', target: 'done' }],
};

describe('flows', () => {
  it('a draft saves with problems, and publishes once they are fixed', async () => {
    const s = await workspace();
    const created = await s.client.post('/flows', { name: 'Greeter' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: 'Greeter', active: false, publishedVersion: null });
    const id = created.body.id as string;

    const broken = await s.client.req('PUT', `/flows/${id}`, {
      definition: {
        ...DEF,
        edges: [{ id: 'e1', source: 'greet', sourceHandle: 'nope', target: 'gone' }],
      },
    });
    expect(broken.status).toBe(200);
    expect(broken.body.issues.some((i: { level: string }) => i.level === 'error')).toBe(true);
    const refused = await s.client.post(`/flows/${id}/publish`);
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe(ErrorCode.FLOW_INVALID);
    expect(refused.body.details.issues.length).toBeGreaterThan(0);

    await s.client.req('PUT', `/flows/${id}`, { definition: DEF });
    const published = await s.client.post(`/flows/${id}/publish`);
    expect(published.status).toBe(200);
    expect(published.body).toMatchObject({
      publishedVersion: 1,
      hasUnpublishedChanges: false,
      triggerType: 'keyword',
    });
    // Publishing an unchanged draft makes no new version.
    expect((await s.client.post(`/flows/${id}/publish`)).body.publishedVersion).toBe(1);

    await s.client.req('PUT', `/flows/${id}`, {
      definition: {
        ...DEF,
        nodes: [{ ...DEF.nodes![0]!, data: { text: 'Hello again' } }, DEF.nodes![1]!],
      },
    });
    expect((await s.client.get(`/flows/${id}`)).body.hasUnpublishedChanges).toBe(true);
    expect((await s.client.post(`/flows/${id}/publish`)).body.publishedVersion).toBe(2);
    const versions = await s.client.get(`/flows/${id}/versions`);
    expect(versions.body.map((v: { version: number }) => v.version)).toEqual([2, 1]);
  });

  it('duplicates a flow as an unpublished copy, and reverts a draft to what is published', async () => {
    const s = await workspace();
    const { body } = await s.client.post('/flows', { name: 'Original', definition: DEF });
    await s.client.post(`/flows/${body.id}/publish`);
    const copy = await s.client.post(`/flows/${body.id}/duplicate`);
    expect(copy.status).toBe(201);
    expect(copy.body).toMatchObject({
      name: 'Original (copy)',
      active: false,
      publishedVersion: null,
      draft: { startNodeId: 'greet' },
    });

    await s.client.req('PUT', `/flows/${body.id}`, {
      definition: {
        ...DEF,
        nodes: [{ ...DEF.nodes![0]!, data: { text: 'Changed' } }, DEF.nodes![1]!],
      },
    });
    const reverted = await s.client.post(`/flows/${body.id}/revert`);
    expect(reverted.body.hasUnpublishedChanges).toBe(false);
    expect(reverted.body.draft.nodes[0].data.text).toBe('Hi {{contact.name}}');
    expect((await s.client.post(`/flows/${copy.body.id}/revert`)).status).toBe(400);
  });

  it('turns on only once published', async () => {
    const s = await workspace();
    const { body } = await s.client.post('/flows', { name: 'F', definition: DEF });
    expect((await s.client.req('PATCH', `/flows/${body.id}/active`, { active: true })).status).toBe(
      400,
    );
    await s.client.post(`/flows/${body.id}/publish`);
    const on = await s.client.req('PATCH', `/flows/${body.id}/active`, { active: true });
    expect(on.body.active).toBe(true);
  });

  it('checks what the flow points at when publishing', async () => {
    const s = await workspace();
    const { body } = await s.client.post('/flows', {
      name: 'Refs',
      definition: {
        ...DEF,
        nodes: [
          { id: 'greet', type: 'tag', data: { tagId: randomUUID() } },
          { id: 'done', type: 'send_template', data: { templateId: randomUUID() } },
        ],
      },
    });
    const res = await s.client.post(`/flows/${body.id}/publish`);
    expect(res.status).toBe(400);
    const messages = res.body.details.issues.map((i: { message: string }) => i.message);
    expect(messages).toEqual(
      expect.arrayContaining(['The tag no longer exists', 'The template no longer exists']),
    );
  });

  it('lists runs with their history, and stops one', async () => {
    const s = await workspace();
    const { body } = await s.client.post('/flows', { name: 'F', definition: DEF });
    await s.client.post(`/flows/${body.id}/publish`);
    const runId = randomUUID();
    await withTenant(owner, { orgId: s.orgId }, async (tx) => {
      const flow = await tx.flow.findUniqueOrThrow({ where: { id: body.id } });
      const contact = await tx.contact.create({
        data: { orgId: s.orgId, waId: '919811100011', name: 'Ira' },
      });
      await tx.flowRun.create({
        data: {
          id: runId,
          orgId: s.orgId,
          flowId: body.id,
          versionId: flow.publishedVersionId!,
          contactId: contact.id,
          status: 'waiting',
          currentNodeId: 'greet',
          variables: { size: 'L' },
        },
      });
      await tx.flowRunStep.create({
        data: { orgId: s.orgId, runId, nodeId: 'greet', nodeType: 'trigger', outcome: 'started' },
      });
    });
    const runs = await s.client.get(`/flows/${body.id}/runs`);
    expect(runs.body.items).toHaveLength(1);
    expect(runs.body.items[0]).toMatchObject({
      status: 'waiting',
      contact: { name: 'Ira' },
      variables: { size: 'L' },
      version: 1,
    });
    expect((await s.client.get(`/flows/${body.id}`)).body.activeRuns).toBe(1);

    const cancelled = await s.client.post(`/flows/runs/${runId}/cancel`);
    expect(cancelled.body).toMatchObject({ status: 'cancelled', endReason: 'cancelled_by_user' });
    const detail = await s.client.get(`/flows/runs/${runId}`);
    expect(detail.body.history.map((h: { outcome: string }) => h.outcome)).toEqual([
      'started',
      'cancelled',
    ]);
  });

  it('starting by hand queues an event for the worker', async () => {
    const s = await workspace();
    const { body } = await s.client.post('/flows', { name: 'F', definition: DEF });
    await s.client.post(`/flows/${body.id}/publish`);
    const contact = await s.client.post('/contacts', { phone: '+91 98111 00022' });
    expect(
      (await s.client.post(`/flows/${body.id}/runs`, { contactId: contact.body.id })).status,
    ).toBe(400);
    await s.client.req('PATCH', `/flows/${body.id}/active`, { active: true });
    const spy = vi.spyOn(t.app.get(QueuesService), 'enqueueFlowJob');
    const started = await s.client.post(`/flows/${body.id}/runs`, { contactId: contact.body.id });
    expect(started.status).toBe(202);
    expect(spy).toHaveBeenCalledWith({
      kind: 'event',
      orgId: s.orgId,
      event: { type: 'manual', flowId: body.id, contactId: contact.body.id },
    });
    spy.mockRestore();
  });

  it('adding a tag queues the flows it triggers', async () => {
    const s = await workspace();
    const tag = await s.client.post('/contact-tags', { name: 'lead' });
    const contact = await s.client.post('/contacts', { phone: '+91 98111 00033' });
    const spy = vi.spyOn(t.app.get(QueuesService), 'enqueueFlowJob');
    await s.client.req('PUT', `/contacts/${contact.body.id}/tags`, { tagIds: [tag.body.id] });
    // Setting the same tags again adds nothing, so nothing is queued.
    await s.client.req('PUT', `/contacts/${contact.body.id}/tags`, { tagIds: [tag.body.id] });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({
      kind: 'event',
      orgId: s.orgId,
      event: { type: 'tag_added', contactId: contact.body.id, tagId: tag.body.id },
    });
    spy.mockRestore();
  });

  it('a removed flow is gone from the list, and its runs stop', async () => {
    const s = await workspace();
    const { body } = await s.client.post('/flows', { name: 'Gone', definition: DEF });
    expect((await s.client.req('DELETE', `/flows/${body.id}`)).status).toBe(204);
    expect((await s.client.get('/flows')).body).toEqual([]);
    expect((await s.client.get(`/flows/${body.id}`)).status).toBe(404);
  });

  it('stores files for media steps under the workspace', async () => {
    const s = await workspace();
    const boundary = `----test${randomBytes(8).toString('hex')}`;
    const inject = await t.app.inject({
      method: 'POST',
      url: '/flows/media',
      payload: Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="menu.png"\r\n` +
            'Content-Type: image/png\r\n\r\n',
        ),
        Buffer.from('png'),
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
        authorization: `Bearer ${s.client.accessToken}`,
      },
    });
    const res = { status: inject.statusCode, body: JSON.parse(inject.body) };
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ kind: 'image', mimeType: 'image/png' });
    expect(res.body.mediaKey).toMatch(new RegExp(`^orgs/${s.orgId}/flows/`));
  });
});

describe('access', () => {
  it('agents cannot see or change flows', async () => {
    const s = await workspace();
    const agent = await s.join('agent');
    expect((await agent.get('/flows')).status).toBe(403);
    expect((await agent.post('/flows', { name: 'x' })).status).toBe(403);
  });

  it('another workspace sees nothing', async () => {
    const a = await workspace();
    const b = await workspace();
    const { body } = await a.client.post('/flows', { name: 'Mine', definition: DEF });
    expect((await b.client.get(`/flows/${body.id}`)).status).toBe(404);
    expect((await b.client.get('/flows')).body).toEqual([]);
    expect((await b.client.post(`/flows/${body.id}/publish`)).status).toBe(404);
  });

  it('needs the flows feature to make flows, but not to read them', async () => {
    const s = await workspace();
    const { body } = await s.client.post('/flows', { name: 'Kept', definition: DEF });
    await owner.$executeRaw`
      UPDATE subscriptions SET plan_id = (SELECT id FROM plans WHERE code = 'free'), status = 'active', trial_ends_at = NULL
      WHERE org_id = ${s.orgId}::uuid`;
    const refused = await s.client.post('/flows', { name: 'More' });
    expect(refused.status).toBe(402);
    expect(refused.body.code).toBe(ErrorCode.PLAN_FEATURE_UNAVAILABLE);
    expect((await s.client.get(`/flows/${body.id}`)).status).toBe(200);
  });
});
