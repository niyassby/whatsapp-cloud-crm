import { randomUUID } from 'node:crypto';
import { type DbClient, withTenant, whatsappChannelId } from '@wacrm/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sendOutboundMessage } from '../src/processors/outbound';
import { syncTemplates, templateSyncTargets } from '../src/processors/templates';
import { routeWebhookEvent } from '../src/processors/webhook-events';
import { buildDeps, connectNumber, createOrg, db, metaId, ownerDb } from './support';

let client: DbClient;
let owner: DbClient;

beforeAll(() => {
  client = db();
  owner = ownerDb();
});
afterAll(async () => {
  await client.$disconnect();
  await owner.$disconnect();
});

async function setup() {
  const orgId = await createOrg(client);
  const number = await connectNumber(client, orgId);
  const wabaAccountId = await withTenant(client, { orgId }, async (tx) => {
    const phone = await tx.phoneNumber.findFirstOrThrow({ where: { id: number.id } });
    return phone.wabaAccountId;
  });
  return { orgId, number, wabaAccountId, ...buildDeps(client) };
}

async function template(
  s: { orgId: string; wabaAccountId: string },
  over: Record<string, unknown> = {},
) {
  return withTenant(client, { orgId: s.orgId }, (tx) =>
    tx.messageTemplate.create({
      data: {
        orgId: s.orgId,
        wabaAccountId: s.wabaAccountId,
        name: `t_${metaId()}`,
        language: 'en_US',
        category: 'UTILITY',
        status: 'pending',
        metaTemplateId: metaId(),
        definition: { header: null, body: 'Hello there', footer: null, buttons: [] },
        statusAt: new Date('2026-01-01T00:00:00Z'),
        ...over,
      },
    }),
  );
}

const read = (orgId: string, id: string) =>
  withTenant(client, { orgId }, (tx) => tx.messageTemplate.findUniqueOrThrow({ where: { id } }));

/** Deliver a webhook through the real ingest function, the way the API stores it. */
async function deliver(
  deps: Parameters<typeof routeWebhookEvent>[0],
  wabaId: string,
  field: string,
  value: Record<string, unknown>,
  time?: number,
) {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [{ id: wabaId, ...(time ? { time } : {}), changes: [{ field, value }] }],
  };
  const [row] = await client.$queryRaw<{ id: string }[]>`
    SELECT id FROM webhook_event_ingest(
      ${randomUUID()}, ${wabaId}, ${null}::text, ${field}, ${JSON.stringify(payload)}::jsonb
    )`;
  return { id: row!.id, outcome: await routeWebhookEvent(deps, row!.id) };
}

describe('template status webhooks', () => {
  it('approves a template and tells the screen', async () => {
    const s = await setup();
    const t = await template(s);
    const { outcome } = await deliver(s.deps, s.number.wabaId, 'message_template_status_update', {
      event: 'APPROVED',
      message_template_id: Number(t.metaTemplateId),
      message_template_name: t.name,
      message_template_language: 'en-US',
      reason: 'NONE',
    });
    expect(outcome).toBe('processed');
    expect((await read(s.orgId, t.id)).status).toBe('approved');
    expect(s.publisher.of('template:updated')).toEqual([
      expect.objectContaining({ payload: { templateId: t.id } }),
    ]);
  });

  it('keeps the rejection reason and Meta’s recommendation', async () => {
    const s = await setup();
    const t = await template(s);
    await deliver(s.deps, s.number.wabaId, 'message_template_status_update', {
      event: 'REJECTED',
      message_template_id: Number(t.metaTemplateId),
      reason: 'INVALID_FORMAT',
      rejection_info: { reason: 'INVALID_FORMAT', recommendation: 'Fix the variables' },
    });
    expect(await read(s.orgId, t.id)).toMatchObject({
      status: 'rejected',
      rejectedReason: 'INVALID_FORMAT',
      statusDetail: 'Fix the variables',
    });
  });

  it('clears an old rejection once approved', async () => {
    const s = await setup();
    const t = await template(s, { status: 'rejected', rejectedReason: 'SCAM' });
    await deliver(s.deps, s.number.wabaId, 'message_template_status_update', {
      event: 'APPROVED',
      message_template_id: Number(t.metaTemplateId),
    });
    expect(await read(s.orgId, t.id)).toMatchObject({ status: 'approved', rejectedReason: null });
  });

  it.each([
    ['PAUSED', 'paused'],
    ['DISABLED', 'disabled'],
    ['IN_APPEAL', 'in_appeal'],
    ['PENDING_DELETION', 'pending_deletion'],
    ['ARCHIVED', 'archived'],
    ['LIMIT_EXCEEDED', 'limit_exceeded'],
    ['REINSTATED', 'approved'],
  ])('maps %s', async (event, status) => {
    const s = await setup();
    const t = await template(s);
    await deliver(s.deps, s.number.wabaId, 'message_template_status_update', {
      event,
      message_template_id: Number(t.metaTemplateId),
    });
    expect((await read(s.orgId, t.id)).status).toBe(status);
  });

  it('a late event cannot move a template backwards, as in a replay', async () => {
    const s = await setup();
    const t = await template(s, { status: 'paused', statusAt: new Date('2026-06-01T00:00:00Z') });
    await deliver(
      s.deps,
      s.number.wabaId,
      'message_template_status_update',
      { event: 'APPROVED', message_template_id: Number(t.metaTemplateId) },
      Math.floor(new Date('2026-05-01T00:00:00Z').getTime() / 1000),
    );
    expect((await read(s.orgId, t.id)).status).toBe('paused');
  });

  it('replaying the same event changes nothing twice', async () => {
    const s = await setup();
    const t = await template(s);
    const time = Math.floor(Date.now() / 1000);
    const { id } = await deliver(
      s.deps,
      s.number.wabaId,
      'message_template_status_update',
      { event: 'APPROVED', message_template_id: Number(t.metaTemplateId) },
      time,
    );
    // A processed event is skipped, which is also what stops a duplicate job.
    expect(await routeWebhookEvent(s.deps, id)).toBe('skipped');
    expect((await read(s.orgId, t.id)).status).toBe('approved');
  });

  it('asks for a full sync for a template it does not know', async () => {
    const s = await setup();
    await deliver(s.deps, s.number.wabaId, 'message_template_status_update', {
      event: 'APPROVED',
      message_template_id: Number(metaId()),
    });
    expect(s.syncs).toEqual([{ orgId: s.orgId, wabaAccountId: s.wabaAccountId }]);
  });

  it('cannot touch another workspace’s template', async () => {
    const a = await setup();
    const b = await setup();
    const t = await template(b);
    await deliver(a.deps, a.number.wabaId, 'message_template_status_update', {
      event: 'REJECTED',
      message_template_id: Number(t.metaTemplateId),
      reason: 'SCAM',
    });
    expect((await read(b.orgId, t.id)).status).toBe('pending');
  });
});

describe('other template webhooks', () => {
  it('updates the category when Meta changes it', async () => {
    const s = await setup();
    const t = await template(s, { status: 'approved' });
    await deliver(s.deps, s.number.wabaId, 'template_category_update', {
      message_template_id: Number(t.metaTemplateId),
      previous_category: 'UTILITY',
      new_category: 'MARKETING',
    });
    expect((await read(s.orgId, t.id)).category).toBe('MARKETING');
  });

  it('warns about a coming category change without applying it', async () => {
    const s = await setup();
    const t = await template(s, { status: 'approved' });
    await deliver(s.deps, s.number.wabaId, 'template_category_update', {
      message_template_id: Number(t.metaTemplateId),
      new_category: 'UTILITY',
      correct_category: 'MARKETING',
      category_update_timestamp: 1746169200,
    });
    const after = await read(s.orgId, t.id);
    expect(after.category).toBe('UTILITY');
    expect(after.statusDetail).toContain('MARKETING');
  });

  it('records quality, and re-reads after an edit made elsewhere', async () => {
    const s = await setup();
    const t = await template(s, { status: 'approved' });
    await deliver(s.deps, s.number.wabaId, 'message_template_quality_update', {
      message_template_id: Number(t.metaTemplateId),
      previous_quality_score: 'GREEN',
      new_quality_score: 'RED',
    });
    expect((await read(s.orgId, t.id)).qualityScore).toBe('RED');

    await deliver(s.deps, s.number.wabaId, 'message_template_components_update', {
      message_template_id: Number(t.metaTemplateId),
      message_template_element: 'New text',
    });
    expect(s.syncs).toEqual([{ orgId: s.orgId, wabaAccountId: s.wabaAccountId }]);
  });

  it('a flag warns without stopping sends', async () => {
    const s = await setup();
    const t = await template(s, { status: 'approved' });
    await deliver(s.deps, s.number.wabaId, 'message_template_status_update', {
      event: 'FLAGGED',
      message_template_id: Number(t.metaTemplateId),
    });
    const after = await read(s.orgId, t.id);
    expect(after.status).toBe('approved');
    expect(after.statusDetail).toContain('Flagged');
  });
});

describe('reconciliation', () => {
  it('finds connected accounts across every workspace, and returns only ids', async () => {
    const a = await setup();
    const b = await setup();
    const targets = await templateSyncTargets({ db: client });
    expect(targets).toEqual(
      expect.arrayContaining([
        { org_id: a.orgId, waba_account_id: a.wabaAccountId },
        { org_id: b.orgId, waba_account_id: b.wabaAccountId },
      ]),
    );
    expect(Object.keys(targets[0]!).sort()).toEqual(['org_id', 'waba_account_id']);
  });

  it('skips accounts with no connected number', async () => {
    const s = await setup();
    await withTenant(client, { orgId: s.orgId }, (tx) =>
      tx.phoneNumber.updateMany({ data: { status: 'disconnected' } }),
    );
    const targets = await templateSyncTargets({ db: client });
    expect(targets.map((t) => t.org_id)).not.toContain(s.orgId);
    expect(await syncTemplates(s.deps, { orgId: s.orgId, wabaAccountId: s.wabaAccountId })).toBe(0);
  });

  it('catches a status change whose webhook was lost', async () => {
    const s = await setup();
    const t = await template(s);
    s.fake.templates.push({
      id: t.metaTemplateId,
      name: t.name,
      language: t.language,
      category: 'UTILITY',
      status: 'APPROVED',
      components: [{ type: 'BODY', text: 'Hello there' }],
    });
    const changed = await syncTemplates(s.deps, {
      orgId: s.orgId,
      wabaAccountId: s.wabaAccountId,
    });
    expect(changed).toBe(1);
    expect((await read(s.orgId, t.id)).status).toBe('approved');
    expect(s.publisher.of('template:updated')).toHaveLength(1);

    const waba = await withTenant(client, { orgId: s.orgId }, (tx) =>
      tx.wabaAccount.findUniqueOrThrow({ where: { id: s.wabaAccountId } }),
    );
    expect(waba.templatesSyncedAt).toBeInstanceOf(Date);
  });

  it('retries when Meta says it is worth retrying, and stops when it is not', async () => {
    const s = await setup();
    s.fake.failListing({ code: 'WA_RATE_LIMITED', message: 'Slow down', retryable: true });
    await expect(
      syncTemplates(s.deps, { orgId: s.orgId, wabaAccountId: s.wabaAccountId }),
    ).rejects.toThrow('Slow down');
  });
});

describe('sending a template', () => {
  async function queued(s: Awaited<ReturnType<typeof setup>>, over: Record<string, unknown> = {}) {
    const messageId = randomUUID();
    const createdAt = new Date();
    await withTenant(client, { orgId: s.orgId }, async (tx) => {
      const contact = await tx.contact.create({
        data: { orgId: s.orgId, waId: '919876543210', optInStatus: 'opted_in' },
      });
      const conversation = await tx.conversation.create({
        data: {
          orgId: s.orgId,
          phoneId: s.number.id,
          channelId: await whatsappChannelId(tx, s.number.id),
          contactId: contact.id,
        },
      });
      await tx.message.create({
        data: {
          id: messageId,
          createdAt,
          orgId: s.orgId,
          conversationId: conversation.id,
          direction: 'outbound',
          type: 'template',
          status: 'queued',
          ...over,
        },
      });
    });
    return { orgId: s.orgId, messageId, createdAt: createdAt.toISOString() };
  }

  it('sends the prepared components', async () => {
    const s = await setup();
    const components = [
      { type: 'body', parameters: [{ type: 'text', text: 'Asha', parameterName: 'first_name' }] },
      { type: 'button', subType: 'url', index: 0, parameters: [{ type: 'text', text: 'abc' }] },
    ];
    const job = await queued(s, {
      content: { templateName: 'promo', language: 'en_US', components, category: 'UTILITY' },
    });
    expect(await sendOutboundMessage(s.deps, job, { finalAttempt: true })).toBe('sent');
    expect(s.fake.calls[0]!.method).toBe('sendTemplate');
    expect(s.fake.calls[0]!.args[0]).toBe('919876543210');
    expect(s.fake.calls[0]!.args[1]).toEqual({ name: 'promo', language: 'en_US', components });
  });

  it('uploads a media header once and places it first', async () => {
    const s = await setup();
    await s.storage.put('orgs/x/header', Buffer.from('jpeg'), 'image/jpeg');
    const job = await queued(s, {
      mediaKey: 'orgs/x/header',
      mediaMime: 'image/jpeg',
      mediaFilename: 'menu.jpg',
      mediaStatus: 'stored',
      content: {
        templateName: 'menu',
        language: 'en_US',
        components: [{ type: 'body', parameters: [{ type: 'text', text: 'Asha' }] }],
        category: 'UTILITY',
        headerKind: 'image',
      },
    });
    expect(await sendOutboundMessage(s.deps, job, { finalAttempt: true })).toBe('sent');
    expect(s.fake.calls.map((c) => c.method)).toEqual(['uploadMedia', 'sendTemplate']);
    expect(s.fake.calls[1]!.args[1]).toMatchObject({
      components: [
        {
          type: 'header',
          parameters: [{ type: 'image', extra: { image: { id: 'uploaded-media-1' } } }],
        },
        { type: 'body' },
      ],
    });
  });

  it('names the file on a document header', async () => {
    const s = await setup();
    await s.storage.put('orgs/x/doc', Buffer.from('pdf'), 'application/pdf');
    const job = await queued(s, {
      mediaKey: 'orgs/x/doc',
      mediaMime: 'application/pdf',
      mediaFilename: 'invoice.pdf',
      mediaStatus: 'stored',
      content: {
        templateName: 'invoice',
        language: 'en_US',
        components: [],
        category: 'UTILITY',
        headerKind: 'document',
      },
    });
    await sendOutboundMessage(s.deps, job, { finalAttempt: true });
    expect(s.fake.calls[1]!.args[1]).toMatchObject({
      components: [
        {
          type: 'header',
          parameters: [
            {
              type: 'document',
              extra: { document: { id: 'uploaded-media-1', filename: 'invoice.pdf' } },
            },
          ],
        },
      ],
    });
  });

  it('leaves components out when a template has no variables', async () => {
    const s = await setup();
    const job = await queued(s, {
      content: { templateName: 'hello', language: 'en_US', components: [], category: 'UTILITY' },
    });
    await sendOutboundMessage(s.deps, job, { finalAttempt: true });
    expect(s.fake.calls[0]!.args[1]).toEqual({
      name: 'hello',
      language: 'en_US',
      components: undefined,
    });
  });
});
