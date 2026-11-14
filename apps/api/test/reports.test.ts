/**
 * Phase 4.3 over HTTP: each report from the aggregates, CSV and PDF exports (audited), the
 * dashboard on the aggregates, schedules and who they may go to, plan and role gates, isolation.
 */
import { randomUUID } from 'node:crypto';
import { createPrismaClient, type DbClient, rollupAnalytics, withTenant } from '@wacrm/db';
import { localDate } from '@wacrm/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

interface Workspace {
  client: Client;
  orgId: string;
  userId: string;
}

async function workspace(plan?: string): Promise<Workspace> {
  const client = new Client(t.app);
  const { orgId, userId } = await client.signup();
  if (plan) {
    await withTenant(owner, { orgId }, async (tx) => {
      const p = await tx.plan.findUniqueOrThrow({ where: { code: plan } });
      await tx.subscription.update({
        where: { orgId },
        data: { planId: p.id, status: 'active', trialEndsAt: null },
      });
    });
  }
  return { client, orgId, userId };
}

/** A conversation today: two customer messages, one answered by the owner after 5 minutes. */
async function seed(ws: Workspace): Promise<void> {
  const now = Date.now();
  const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000);
  await withTenant(owner, { orgId: ws.orgId }, async (tx) => {
    const waba = await tx.wabaAccount.create({ data: { orgId: ws.orgId, wabaId: randomUUID() } });
    const phone = await tx.phoneNumber.create({
      data: {
        orgId: ws.orgId,
        wabaAccountId: waba.id,
        phoneNumberId: randomUUID(),
        status: 'connected',
        credentialSource: 'manual',
        verifiedName: 'Pickle Shop',
      },
    });
    const channel = await tx.channel.findUniqueOrThrow({ where: { phoneId: phone.id } });
    const contact = await tx.contact.create({ data: { orgId: ws.orgId, name: 'Ravi' } });
    const conversation = await tx.conversation.create({
      data: {
        orgId: ws.orgId,
        channelId: channel.id,
        phoneId: phone.id,
        contactId: contact.id,
        lastMessageAt: at(10),
      },
    });
    const base = { orgId: ws.orgId, conversationId: conversation.id, type: 'text' };
    await tx.message.createMany({
      data: [
        { ...base, id: randomUUID(), createdAt: at(20), direction: 'inbound', status: 'received' },
        { ...base, id: randomUUID(), createdAt: at(18), direction: 'inbound', status: 'received' },
        {
          ...base,
          id: randomUUID(),
          createdAt: at(15),
          direction: 'outbound',
          status: 'read',
          senderUserId: ws.userId,
        },
      ],
    });
    await rollupAnalytics(tx, ws.orgId, at(60 * 24), new Date());
  });
}

const today = async (ws: Workspace) => {
  const org = await ws.client.get('/orgs/current');
  return localDate(new Date(), org.body.timezone as string);
};

describe('reports', () => {
  let ws: Workspace;
  let day: string;

  beforeAll(async () => {
    ws = await workspace();
    await seed(ws);
    day = await today(ws);
  });

  it('conversations: volume, response time and open threads from the aggregates', async () => {
    const res = await ws.client.get(`/reports/conversations?from=${day}&to=${day}`);
    expect(res.status).toBe(200);
    expect(res.body.totals).toMatchObject({
      inbound: 2,
      outboundHuman: 1,
      responses: 1,
      medianResponseSeconds: 300,
      newConversations: 1,
      openNow: 1,
    });
    expect(res.body.byChannel[0]).toMatchObject({ name: 'Pickle Shop', kind: 'whatsapp' });
    expect(res.body.byHour).toHaveLength(24);
  });

  it('defaults to the last 30 days, and every report answers', async () => {
    for (const kind of ['conversations', 'agents', 'campaigns', 'templates', 'ads']) {
      const res = await ws.client.get(`/reports/${kind}`);
      expect(res.status, kind).toBe(200);
      expect(res.body.kind).toBe(kind);
    }
    const agents = await ws.client.get('/reports/agents');
    expect(agents.body.rows[0]).toMatchObject({ userId: ws.userId, messages: 1, responses: 1 });
    expect((await ws.client.get('/reports/nothing')).status).toBe(404);
  });

  it('refuses a backwards or too long range', async () => {
    expect(
      (await ws.client.get('/reports/conversations?from=2026-11-10&to=2026-11-01')).status,
    ).toBe(400);
    expect(
      (await ws.client.get('/reports/conversations?from=2024-01-01&to=2026-01-01')).status,
    ).toBe(400);
  });

  it('exports CSV and PDF, and records each export', async () => {
    const csv = await ws.client.get(
      `/reports/conversations/export?from=${day}&to=${day}&format=csv`,
    );
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.headers['content-disposition']).toContain(`conversations-${day}-to-${day}.csv`);
    expect(String(csv.body)).toContain('Messages from customers,2');

    const pdf = await ws.client.get(`/reports/agents/export?format=pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(String(pdf.body).startsWith('%PDF')).toBe(true);

    const audit = await ws.client.get('/orgs/current/audit-logs');
    const exports = audit.body.items.filter(
      (i: { action: string }) => i.action === 'report.exported',
    );
    expect(exports.map((e: { metadata: { format: string } }) => e.metadata.format).sort()).toEqual([
      'csv',
      'pdf',
    ]);
  });

  it('the dashboard reads the same aggregates', async () => {
    const res = await ws.client.get('/analytics/dashboard?days=7');
    expect(res.status).toBe(200);
    expect(res.body.totals).toEqual({ inbound: 2, outbound: 1 });
    expect(res.body.outbound).toMatchObject({ attempted: 1, read: 1, delivered: 1 });
    expect(res.body.responseTime).toEqual({ medianSeconds: 300, replied: 1 });
    expect(res.body.volume).toHaveLength(8);
  });

  it('another workspace sees none of it', async () => {
    const other = await workspace();
    const res = await other.client.get(`/reports/conversations?from=${day}&to=${day}`);
    expect(res.body.totals).toMatchObject({ inbound: 0, responses: 0, openNow: 0 });
    const agents = await other.client.get('/reports/agents');
    expect(agents.body.rows.map((r: { userId: string }) => r.userId)).toEqual([other.userId]);
  });
});

describe('schedules', () => {
  let ws: Workspace;

  beforeAll(async () => {
    ws = await workspace();
  });

  it('creates a weekly schedule for the next Monday at its hour, and lists it', async () => {
    const res = await ws.client.post('/reports/schedules', {
      name: 'Monday summary',
      report: 'conversations',
      frequency: 'weekly',
      format: 'pdf',
      recipientIds: [ws.userId],
      hour: 9,
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: 'Monday summary', active: true, lastRunAt: null });
    const next = new Date(res.body.nextRunAt as string);
    expect(next.getTime()).toBeGreaterThan(Date.now());
    expect(next.getTime() - Date.now()).toBeLessThanOrEqual(7 * 86_400_000);
    const list = await ws.client.get('/reports/schedules');
    expect(list.body.map((s: { id: string }) => s.id)).toContain(res.body.id);

    const run = await ws.client.post(`/reports/schedules/${res.body.id}/run`);
    expect(new Date(run.body.nextRunAt as string).getTime()).toBeLessThanOrEqual(Date.now());

    const off = await ws.client.patch(`/reports/schedules/${res.body.id}`, { active: false });
    expect(off.body.active).toBe(false);
    expect((await ws.client.delete(`/reports/schedules/${res.body.id}`)).status).toBe(204);
    expect((await ws.client.delete(`/reports/schedules/${res.body.id}`)).status).toBe(404);
  });

  it('only sends to owners and admins of this workspace', async () => {
    const outsider = await workspace();
    const res = await ws.client.post('/reports/schedules', {
      name: 'Leak',
      report: 'agents',
      frequency: 'daily',
      format: 'csv',
      recipientIds: [outsider.userId],
    });
    expect(res.status).toBe(400);
  });

  it('agents cannot read reports or manage schedules', async () => {
    const email = uniqueEmail();
    await ws.client.post('/team/invitations', { email, role: 'agent' });
    const agent = new Client(t.app);
    await agent.post('/invitations/accept', {
      token: tokenFromMail(t.mailer, email),
      name: 'Agent',
      password: 'correct-horse-battery',
    });
    expect((await agent.get('/reports/conversations')).status).toBe(403);
    expect((await agent.get('/reports/schedules')).status).toBe(403);
  });

  it('needs the reports feature on the plan', async () => {
    const free = await workspace('free');
    const res = await free.client.get('/reports/conversations');
    expect(res.status).toBe(402);
    expect(res.body.code).toBe('PLAN_FEATURE_UNAVAILABLE');
  });
});
