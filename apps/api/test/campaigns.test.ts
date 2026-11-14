/** Campaigns, drips and the dashboard over real HTTP. The worker's half is in apps/worker/test. */
import { randomBytes, randomUUID } from 'node:crypto';
import {
  chargeMessage,
  creditWallet,
  createPrismaClient,
  type DbClient,
  ensureWallet,
  reserveFunds,
  rollupAnalytics,
  withTenant,
  whatsappChannelId,
} from '@wacrm/db';
import { ErrorCode } from '@wacrm/shared';
import { phoneTokenAad, SecretBox } from '@wacrm/shared/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { QueuesService } from '../src/infra/queues.service';
import { buildApp, Client, type TestApp, tokenFromMail, uniqueEmail, urls } from './helpers';

const ENCRYPTION_KEY = randomBytes(32).toString('base64');
const secrets = new SecretBox(ENCRYPTION_KEY);
const metaId = () => String(Math.floor(Math.random() * 1e15) + 1e15);
// Its own currency: suites share a database, and rate cards have no org.
const CURRENCY = 'XCP';
const RATE = 1_000_000;

let t: TestApp;
let owner: DbClient;

beforeAll(async () => {
  t = await buildApp({
    env: { ENCRYPTION_KEY, WALLET_DEFAULT_CURRENCY: CURRENCY, WALLET_LOW_BALANCE_DEFAULT: '0' },
    graph: {
      apiVersion: 'v25.0',
      fetch: (async () =>
        new Response(JSON.stringify({ error: { message: 'no' } }), {
          status: 400,
        })) as typeof fetch,
    },
  });
  owner = createPrismaClient({ connectionString: urls.directUrl });
  await owner.rateCard.createMany({
    data: [
      {
        country: '*',
        category: 'marketing',
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

async function scene(opts: { balance?: number; contacts?: number } = {}) {
  const client = new Client(t.app);
  const { orgId } = await client.signup();
  const ids = await withTenant(owner, { orgId }, async (tx) => {
    const waba = await tx.wabaAccount.create({
      data: { orgId, wabaId: metaId(), templatesSyncedAt: new Date() },
    });
    const phoneId = randomUUID();
    await tx.phoneNumber.create({
      data: {
        id: phoneId,
        orgId,
        wabaAccountId: waba.id,
        phoneNumberId: metaId(),
        status: 'connected',
        credentialSource: 'manual',
        messagingTier: 'TIER_UNLIMITED',
        accessTokenEnc: secrets.encrypt('token', phoneTokenAad(phoneId)),
      },
    });
    const template = await tx.messageTemplate.create({
      data: {
        orgId,
        wabaAccountId: waba.id,
        name: 'promo',
        language: 'en',
        category: 'MARKETING',
        status: 'approved',
        metaTemplateId: metaId(),
        definition: { header: null, body: 'Big sale today', footer: null, buttons: [] },
      },
    });
    const pending = await tx.messageTemplate.create({
      data: {
        orgId,
        wabaAccountId: waba.id,
        name: 'pending',
        language: 'en',
        category: 'MARKETING',
        status: 'pending',
        definition: { header: null, body: 'Not yet', footer: null, buttons: [] },
      },
    });
    const count = opts.contacts ?? 3;
    await tx.contact.createMany({
      data: Array.from({ length: count }, (_, i) => ({
        orgId,
        waId: String(919800000000 + i),
        optInStatus: 'opted_in' as const,
      })),
    });
    await tx.contact.create({ data: { orgId, waId: '919811111111', optInStatus: 'unknown' } });
    await ensureWallet(tx, orgId, CURRENCY, null);
    if (opts.balance) {
      await creditWallet(tx, { orgId, amountMicros: opts.balance, idempotencyKey: 'seed' });
    }
    return { phoneId, templateId: template.id, pendingTemplateId: pending.id };
  });
  const draft = async (over: object = {}) => {
    const res = await client.post('/campaigns', {
      name: 'Summer sale',
      phoneId: ids.phoneId,
      templateId: ids.templateId,
      ...over,
    });
    expect(res.status).toBe(201);
    return res.body as { id: string; status: string };
  };
  return { client, orgId, draft, ...ids };
}

const spyQueue = () => {
  const queues = t.app.get(QueuesService);
  return vi.spyOn(queues, 'enqueueCampaignJob');
};

describe('drafts', () => {
  it('creates, edits, lists and deletes', async () => {
    const s = await scene();
    const d = await s.draft();
    expect(d.status).toBe('draft');
    const edited = await s.client.patch(`/campaigns/${d.id}`, { name: 'Winter sale' });
    expect(edited.body.name).toBe('Winter sale');
    const list = await s.client.get('/campaigns');
    expect(list.body.items.map((c: { id: string }) => c.id)).toEqual([d.id]);
    expect((await s.client.delete(`/campaigns/${d.id}`)).status).toBe(204);
    expect((await s.client.get(`/campaigns/${d.id}`)).status).toBe(404);
  });

  it('refuses a template from another account', async () => {
    const s = await scene();
    const other = await scene();
    const res = await s.client.post('/campaigns', {
      name: 'Bad',
      phoneId: s.phoneId,
      templateId: other.templateId,
    });
    expect(res.status).toBe(404);
  });

  it('never returns the stored file key', async () => {
    const s = await scene();
    const d = await s.draft();
    await withTenant(owner, { orgId: s.orgId }, (tx) =>
      tx.campaign.update({
        where: { id: d.id },
        data: {
          audience: {
            type: 'csv',
            key: 'orgs/secret/key.csv',
            filename: 'list.csv',
            phoneColumn: 'p',
          },
        },
      }),
    );
    const res = await s.client.get(`/campaigns/${d.id}`);
    expect(res.body.campaign.audience).toEqual({ type: 'csv', filename: 'list.csv' });
    expect(JSON.stringify(res.body)).not.toContain('secret');
  });
});

describe('audience file', () => {
  const upload = async (client: Client, id: string, options: unknown, csv: string) => {
    const boundary = `----test${randomBytes(8).toString('hex')}`;
    const res = await t.app.inject({
      method: 'POST',
      url: `/campaigns/${id}/audience-csv`,
      payload: Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="options"\r\n\r\n${JSON.stringify(options)}\r\n` +
            `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="list.csv"\r\n` +
            'Content-Type: text/csv\r\n\r\n',
        ),
        Buffer.from(csv),
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
        authorization: `Bearer ${client.accessToken}`,
      },
    });
    return { status: res.statusCode, body: JSON.parse(res.body) };
  };

  it('stores the file, and refuses columns that are not in it', async () => {
    const s = await scene();
    const d = await s.draft();
    const bad = await upload(s.client, d.id, { phoneColumn: 'Mobile' }, 'Phone\n+919876543210\n');
    expect(bad.body.code).toBe(ErrorCode.CAMPAIGN_INVALID);
    const ok = await upload(s.client, d.id, { phoneColumn: 'Phone' }, 'Phone\n+919876543210\n');
    expect(ok.status).toBe(200);
    expect(ok.body.audience).toEqual({ type: 'csv', filename: 'list.csv' });
  });
});

describe('estimate', () => {
  it('counts who it reaches, who it skips, and the cost', async () => {
    const s = await scene({ balance: 2 * RATE, contacts: 3 });
    const d = await s.draft();
    const res = await s.client.post(`/campaigns/${d.id}/estimate`, {});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      total: 4,
      sendable: 3,
      skipped: { no_consent: 1 },
      estimateMicros: 3 * RATE,
      availableMicros: 2 * RATE,
      currency: CURRENCY,
      dailyRemaining: null,
    });
  });
});

describe('launch', () => {
  it('starts now: copies the audience and queues the job', async () => {
    const spy = spyQueue();
    const s = await scene();
    const d = await s.draft({ audience: { type: 'segment', filter: { match: 'any', rules: [] } } });
    const res = await s.client.post(`/campaigns/${d.id}/launch`, { when: 'now' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('preparing');
    expect(spy).toHaveBeenCalledWith({ kind: 'prepare', orgId: s.orgId, campaignId: d.id });
    const row = await withTenant(owner, { orgId: s.orgId }, (tx) =>
      tx.campaign.findUniqueOrThrow({ where: { id: d.id } }),
    );
    expect(row.audience).toMatchObject({
      type: 'segment',
      filterSnapshot: { segment: { match: 'any', rules: [] } },
    });
    spy.mockRestore();
  });

  it('schedules in the chosen time zone, and queues nothing yet', async () => {
    const spy = spyQueue();
    const s = await scene();
    const d = await s.draft();
    const res = await s.client.post(`/campaigns/${d.id}/launch`, {
      when: 'scheduled',
      localTime: '2099-01-15T09:00',
      timezone: 'Asia/Kolkata',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'scheduled',
      scheduledAt: '2099-01-15T03:30:00.000Z',
      timezone: 'Asia/Kolkata',
    });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('refuses a time in the past and an unknown time zone', async () => {
    const s = await scene();
    const d = await s.draft();
    const past = await s.client.post(`/campaigns/${d.id}/launch`, {
      when: 'scheduled',
      localTime: '2020-01-15T09:00',
      timezone: 'Asia/Kolkata',
    });
    expect(past.body.code).toBe(ErrorCode.CAMPAIGN_INVALID);
    const zone = await s.client.post(`/campaigns/${d.id}/launch`, {
      when: 'scheduled',
      localTime: '2099-01-15T09:00',
      timezone: 'Mars/Olympus',
    });
    expect(zone.status).toBe(400);
  });

  it('refuses a template that is not approved', async () => {
    const s = await scene();
    const d = await s.draft({ templateId: s.pendingTemplateId });
    const res = await s.client.post(`/campaigns/${d.id}/launch`, { when: 'now' });
    expect(res.body.code).toBe(ErrorCode.CAMPAIGN_INVALID);
  });

  it('a launched campaign cannot be edited, deleted or launched again', async () => {
    const s = await scene();
    const d = await s.draft();
    await s.client.post(`/campaigns/${d.id}/launch`, { when: 'now' });
    for (const res of [
      await s.client.patch(`/campaigns/${d.id}`, { name: 'x' }),
      await s.client.delete(`/campaigns/${d.id}`),
      await s.client.post(`/campaigns/${d.id}/launch`, { when: 'now' }),
    ]) {
      expect(res.status).toBe(409);
      expect(res.body.code).toBe(ErrorCode.CAMPAIGN_NOT_EDITABLE);
    }
  });
});

describe('pause, resume, cancel', () => {
  async function running(balance = 10 * RATE) {
    const s = await scene({ balance });
    const d = await s.draft();
    const contact = await withTenant(owner, { orgId: s.orgId }, (tx) =>
      tx.contact.findFirstOrThrow({ where: { orgId: s.orgId } }),
    );
    const holdId = await withTenant(owner, { orgId: s.orgId }, async (tx) => {
      const hold = await reserveFunds(tx, {
        orgId: s.orgId,
        amountMicros: 5 * RATE,
        referenceType: 'campaign',
        referenceId: d.id,
        idempotencyKey: `test:${d.id}`,
        expiresAt: new Date(Date.now() + 86_400_000),
      });
      await tx.campaign.update({
        where: { id: d.id },
        data: { status: 'running', reservationId: hold.id },
      });
      await tx.campaignRecipient.create({
        data: {
          orgId: s.orgId,
          campaignId: d.id,
          contactId: contact.id,
          phoneId: s.phoneId,
          estimateMicros: BigInt(RATE),
        },
      });
      return hold.id;
    });
    return { ...s, id: d.id, holdId };
  }
  const wallet = (s: { client: Client }) => s.client.get('/wallet').then((r) => r.body);

  it('pauses and resumes, replacing the hold with what is left', async () => {
    const spy = spyQueue();
    const s = await running();
    const paused = await s.client.post(`/campaigns/${s.id}/pause`, {});
    expect(paused.body).toMatchObject({ status: 'paused', pauseCode: 'manual' });
    expect((await wallet(s)).reservedMicros).toBe(5 * RATE);

    const resumed = await s.client.post(`/campaigns/${s.id}/resume`, {});
    expect(resumed.body).toMatchObject({ status: 'running', pauseCode: null });
    expect((await wallet(s)).reservedMicros).toBe(RATE);
    expect(spy).toHaveBeenCalledWith({ kind: 'dispatch', orgId: s.orgId, campaignId: s.id });
    spy.mockRestore();
  });

  it('resume refuses when the wallet still cannot cover it, and changes nothing', async () => {
    const s = await running(5 * RATE);
    await withTenant(owner, { orgId: s.orgId }, async (tx) => {
      await tx.campaign.update({
        where: { id: s.id },
        data: { status: 'paused', pauseCode: 'insufficient_funds' },
      });
      await tx.campaignRecipient.updateMany({
        where: { campaignId: s.id },
        data: { estimateMicros: BigInt(50 * RATE) },
      });
    });
    const res = await s.client.post(`/campaigns/${s.id}/resume`, {});
    expect(res.body.code).toBe(ErrorCode.INSUFFICIENT_BALANCE);
    const report = await s.client.get(`/campaigns/${s.id}`);
    expect(report.body.campaign.status).toBe('paused');
    expect((await wallet(s)).reservedMicros).toBe(5 * RATE);
  });

  it('cancel stops what is pending and returns the money', async () => {
    const s = await running();
    const res = await s.client.post(`/campaigns/${s.id}/cancel`, {});
    expect(res.body.status).toBe('cancelled');
    expect((await wallet(s)).reservedMicros).toBe(0);
    const report = await s.client.get(`/campaigns/${s.id}`);
    expect(report.body.counts).toMatchObject({ cancelled: 1, pending: 0 });
    const again = await s.client.post(`/campaigns/${s.id}/cancel`, {});
    expect(again.status).toBe(409);
  });

  it('audits each control', async () => {
    const s = await running();
    await s.client.post(`/campaigns/${s.id}/pause`, {});
    await s.client.post(`/campaigns/${s.id}/cancel`, {});
    const log = await s.client.get('/orgs/current/audit-logs');
    const actions = log.body.items.map((i: { action: string }) => i.action);
    expect(actions).toEqual(expect.arrayContaining(['campaign.paused', 'campaign.cancelled']));
  });
});

describe('report', () => {
  it('shows counts, the cost from the ledger, and a CSV without formulas', async () => {
    const s = await scene({ balance: 10 * RATE });
    const d = await s.draft();
    const { messageId } = await withTenant(owner, { orgId: s.orgId }, async (tx) => {
      const contact = await tx.contact.create({
        data: { orgId: s.orgId, waId: '919822222222', name: '=HYPERLINK("bad")' },
      });
      const id = randomUUID();
      await chargeMessage(tx, {
        orgId: s.orgId,
        messageId: id,
        category: 'MARKETING',
        country: null,
        windowOpen: false,
        defaults: { currency: CURRENCY, thresholdMicros: null },
      });
      await tx.campaignRecipient.create({
        data: {
          orgId: s.orgId,
          campaignId: d.id,
          contactId: contact.id,
          phoneId: s.phoneId,
          status: 'read',
          messageId: id,
          messageCreatedAt: new Date(),
          sentAt: new Date(),
        },
      });
      return { messageId: id };
    });
    expect(messageId).toBeTruthy();
    const report = await s.client.get(`/campaigns/${d.id}`);
    expect(report.body).toMatchObject({
      counts: { total: 1, sent: 1, delivered: 1, read: 1, replied: 0 },
      costMicros: RATE,
      currency: CURRENCY,
    });
    const recipients = await s.client.get(`/campaigns/${d.id}/recipients?status=read`);
    expect(recipients.body.items).toHaveLength(1);

    const csv = await t.app.inject({
      method: 'GET',
      url: `/campaigns/${d.id}/report.csv`,
      headers: { authorization: `Bearer ${s.client.accessToken}` },
    });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.body).toContain("'=HYPERLINK");
  });
});

describe('drips', () => {
  const save = (s: Awaited<ReturnType<typeof scene>>, over: object = {}) =>
    s.client.post('/drips', {
      name: 'Welcome',
      phoneId: s.phoneId,
      steps: [
        { delayMinutes: 0, templateId: s.templateId },
        { delayMinutes: 60, templateId: s.templateId },
      ],
      ...over,
    });

  it('saves steps in order, and enrolling twice adds nobody twice', async () => {
    const s = await scene({ contacts: 2 });
    const created = await save(s);
    expect(created.status).toBe(201);
    expect(created.body.steps.map((x: { position: number }) => x.position)).toEqual([0, 1]);
    const id = created.body.id;
    expect((await s.client.post(`/drips/${id}/status`, { status: 'active' })).body.status).toBe(
      'active',
    );

    const contacts = await withTenant(owner, { orgId: s.orgId }, (tx) =>
      tx.contact.findMany({ where: { orgId: s.orgId }, select: { id: true } }),
    );
    const contactIds = contacts.map((c) => c.id);
    const first = await s.client.post(`/drips/${id}/enroll`, { contactIds });
    expect(first.body.enrolled).toBe(3);
    const second = await s.client.post(`/drips/${id}/enroll`, { contactIds });
    expect(second.body.enrolled).toBe(0);
    expect((await s.client.get(`/drips/${id}`)).body.enrollments.active).toBe(3);
  });

  it('steps cannot change once people are enrolled', async () => {
    const s = await scene();
    const { id } = (await save(s)).body;
    const contact = await withTenant(owner, { orgId: s.orgId }, (tx) =>
      tx.contact.findFirstOrThrow({ where: { orgId: s.orgId } }),
    );
    const before = await s.client.req('PUT', `/drips/${id}`, {
      name: 'Renamed',
      phoneId: s.phoneId,
      steps: [{ delayMinutes: 5, templateId: s.templateId }],
    });
    expect(before.status).toBe(200);
    await s.client.post(`/drips/${id}/enroll`, { contactIds: [contact.id] });
    const after = await s.client.req('PUT', `/drips/${id}`, {
      name: 'Renamed',
      phoneId: s.phoneId,
      steps: [{ delayMinutes: 5, templateId: s.templateId }],
    });
    expect(after.body.code).toBe(ErrorCode.CAMPAIGN_NOT_EDITABLE);
  });

  it('refuses a step using another account’s template', async () => {
    const s = await scene();
    const other = await scene();
    const res = await save(s, {
      steps: [{ delayMinutes: 0, templateId: other.templateId }],
    });
    expect(res.body.code).toBe(ErrorCode.CAMPAIGN_INVALID);
  });
});

describe('dashboard', () => {
  it('reports volume, rates, response time and active conversations', async () => {
    const s = await scene();
    await withTenant(owner, { orgId: s.orgId }, async (tx) => {
      const contact = await tx.contact.findFirstOrThrow({ where: { orgId: s.orgId } });
      const c = await tx.conversation.create({
        data: {
          orgId: s.orgId,
          phoneId: s.phoneId,
          channelId: await whatsappChannelId(tx, s.phoneId),
          contactId: contact.id,
          status: 'open',
        },
      });
      const user = await tx.membership.findFirstOrThrow({ where: { orgId: s.orgId } });
      const at = (seconds: number) => new Date(Date.now() - 3_600_000 + seconds * 1000);
      const message = (data: object) =>
        tx.message.create({
          data: {
            orgId: s.orgId,
            conversationId: c.id,
            type: 'text',
            body: 'x',
            ...data,
          } as never,
        });
      await message({ direction: 'inbound', status: 'received', createdAt: at(0) });
      await message({
        direction: 'outbound',
        status: 'read',
        senderUserId: user.userId,
        createdAt: at(120),
      });
      await message({ direction: 'outbound', status: 'delivered', createdAt: at(200) });
      await message({ direction: 'outbound', status: 'failed', createdAt: at(300) });
      await message({ direction: 'internal', status: 'sent', createdAt: at(400) });
      // The dashboard reads the aggregates the worker keeps (Phase 4.3).
      await rollupAnalytics(tx, s.orgId, at(-60), new Date());
    });
    const res = await s.client.get('/analytics/dashboard?days=7');
    expect(res.status).toBe(200);
    expect(res.body.totals).toEqual({ inbound: 1, outbound: 3 });
    expect(res.body.volume).toHaveLength(8);
    expect(res.body.outbound).toMatchObject({ attempted: 3, delivered: 2, read: 1, failed: 1 });
    expect(res.body.outbound.deliveryRate).toBeCloseTo(2 / 3);
    expect(res.body.responseTime.replied).toBe(1);
    expect(res.body.responseTime.medianSeconds).toBeCloseTo(120, 0);
    expect(res.body.activeConversations).toBe(1);
  });

  it('shows empty rates, not a misleading zero, with no data', async () => {
    const s = await scene();
    const res = await s.client.get('/analytics/dashboard');
    expect(res.body.outbound.deliveryRate).toBeNull();
    expect(res.body.responseTime.medianSeconds).toBeNull();
  });
});

describe('access', () => {
  it('agents can neither run campaigns nor read the dashboard', async () => {
    const s = await scene();
    const d = await s.draft();
    const email = uniqueEmail();
    await s.client.post('/team/invitations', { email, role: 'agent' });
    const agent = new Client(t.app);
    const accepted = await agent.post('/invitations/accept', {
      token: tokenFromMail(t.mailer, email),
      name: 'Agent',
      password: 'correct-horse-battery',
    });
    expect(accepted.status).toBeLessThan(300);
    expect((await agent.get('/campaigns')).status).toBe(403);
    expect((await agent.post(`/campaigns/${d.id}/launch`, { when: 'now' })).status).toBe(403);
    expect((await agent.get('/drips')).status).toBe(403);
    expect((await agent.get('/analytics/dashboard')).status).toBe(403);
  });

  it('another workspace sees nothing', async () => {
    const s = await scene();
    const other = await scene();
    const d = await s.draft();
    expect((await other.client.get(`/campaigns/${d.id}`)).status).toBe(404);
    expect((await other.client.post(`/campaigns/${d.id}/cancel`, {})).status).toBe(404);
    expect((await other.client.get('/campaigns')).body.items).toEqual([]);
  });
});
