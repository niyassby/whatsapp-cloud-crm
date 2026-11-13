/** Rules and routing settings over real HTTP. The rules themselves are tested in the worker. */
import { randomUUID } from 'node:crypto';
import { createPrismaClient, type DbClient, withTenant, whatsappChannelId } from '@wacrm/db';
import { DEFAULT_AUTOMATION_SETTINGS, ErrorCode } from '@wacrm/shared';
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
    const me = await member.get('/auth/me');
    return { client: member, userId: me.body.user.id as string };
  };
  return { client, orgId, userId, join };
}

describe('settings', () => {
  it('start off, and save', async () => {
    const s = await workspace();
    const initial = await s.client.get('/automation/settings');
    expect(initial.body).toEqual({ ...DEFAULT_AUTOMATION_SETTINGS, timezone: 'UTC' });

    const saved = await s.client.req('PUT', '/automation/settings', {
      ...DEFAULT_AUTOMATION_SETTINGS,
      welcomeEnabled: true,
      welcomeMessage: 'Welcome!',
      awayEnabled: true,
      awayMessage: 'We are closed',
      businessHours: { days: { mon: [{ from: '09:00', to: '17:00' }] } },
      slaEnabled: true,
      slaFirstResponseMinutes: 15,
    });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({
      welcomeMessage: 'Welcome!',
      businessHours: { days: { mon: [{ from: '09:00', to: '17:00' }] } },
      slaFirstResponseMinutes: 15,
    });
    expect((await s.client.get('/automation/settings')).body.welcomeEnabled).toBe(true);
  });

  it('refuses what cannot work', async () => {
    const s = await workspace();
    const put = (body: object) =>
      s.client.req('PUT', '/automation/settings', { ...DEFAULT_AUTOMATION_SETTINGS, ...body });
    expect((await put({ welcomeEnabled: true })).status).toBe(400);
    expect((await put({ awayEnabled: true, awayMessage: 'Away' })).status).toBe(400);
    expect(
      (await put({ businessHours: { days: { mon: [{ from: '17:00', to: '09:00' }] } } })).status,
    ).toBe(400);
  });

  it('turning the SLA off stops running clocks', async () => {
    const s = await workspace();
    await withTenant(owner, { orgId: s.orgId }, async (tx) => {
      const waba = await tx.wabaAccount.create({ data: { orgId: s.orgId, wabaId: randomUUID() } });
      const phone = await tx.phoneNumber.create({
        data: {
          orgId: s.orgId,
          wabaAccountId: waba.id,
          phoneNumberId: randomUUID(),
          status: 'connected',
          credentialSource: 'manual',
        },
      });
      const contact = await tx.contact.create({ data: { orgId: s.orgId, waId: '919876543210' } });
      await tx.conversation.create({
        data: {
          orgId: s.orgId,
          phoneId: phone.id,
          channelId: await whatsappChannelId(tx, phone.id),
          contactId: contact.id,
          awaitingReplySince: new Date(),
          slaDueAt: new Date(Date.now() + 60_000),
        },
      });
    });
    await s.client.req('PUT', '/automation/settings', DEFAULT_AUTOMATION_SETTINGS);
    const row = await owner.conversation.findFirstOrThrow({ where: { orgId: s.orgId } });
    expect(row).toMatchObject({ slaDueAt: null, awaitingReplySince: null });
  });
});

describe('rules', () => {
  it('auto-replies: create, list in priority order, edit, delete', async () => {
    const s = await workspace();
    const make = (name: string, priority: number) =>
      s.client.post('/automation/auto-replies', {
        name,
        matchType: 'contains',
        keywords: ['price'],
        reply: 'From 999',
        priority,
      });
    const late = await make('Late', 50);
    expect(late.status).toBe(201);
    await make('Early', 10);
    const list = await s.client.get('/automation/auto-replies');
    expect(list.body.map((r: { name: string }) => r.name)).toEqual(['Early', 'Late']);

    const edited = await s.client.req('PUT', `/automation/auto-replies/${late.body.id}`, {
      ...late.body,
      reply: 'From 499',
    });
    expect(edited.body.reply).toBe('From 499');
    expect((await s.client.delete(`/automation/auto-replies/${late.body.id}`)).status).toBe(204);
    expect((await s.client.get('/automation/auto-replies')).body).toHaveLength(1);
  });

  it('refuses an unsafe pattern', async () => {
    const s = await workspace();
    const res = await s.client.post('/automation/auto-replies', {
      name: 'Bad',
      matchType: 'regex',
      pattern: '(a+)+$',
      reply: 'x',
    });
    expect(res.status).toBe(400);
  });

  it('assignment rules must name people from this workspace', async () => {
    const s = await workspace();
    const other = await workspace();
    const agent = await s.join('agent');
    const ok = await s.client.post('/automation/assignment-rules', {
      name: 'Desk',
      strategy: 'round_robin',
      agentIds: [agent.userId],
    });
    expect(ok.status).toBe(201);
    const stranger = await s.client.post('/automation/assignment-rules', {
      name: 'Desk',
      strategy: 'round_robin',
      agentIds: [other.userId],
    });
    expect(stranger.status).toBe(400);
  });

  it('another workspace cannot see or change them', async () => {
    const s = await workspace();
    const other = await workspace();
    const rule = await s.client.post('/automation/auto-replies', {
      name: 'Mine',
      matchType: 'exact',
      keywords: ['menu'],
      reply: 'Menu',
    });
    expect((await other.client.get('/automation/auto-replies')).body).toEqual([]);
    const edit = await other.client.req('PUT', `/automation/auto-replies/${rule.body.id}`, {
      ...rule.body,
      reply: 'pwned',
    });
    expect(edit.status).toBe(404);
    expect((await other.client.delete(`/automation/auto-replies/${rule.body.id}`)).status).toBe(
      404,
    );
  });
});

describe('people', () => {
  it('agents set their own availability, and managers set skills', async () => {
    const s = await workspace();
    const agent = await s.join('agent');
    expect(
      (await agent.client.req('PATCH', '/automation/me/availability', { available: false })).body,
    ).toEqual({ available: false });
    const members = await s.client.get('/team/members');
    const row = members.body.find((m: { userId: string }) => m.userId === agent.userId);
    expect(row).toMatchObject({ available: false, skills: [] });

    const skills = await s.client.req('PUT', `/automation/members/${row.id}/skills`, {
      skills: ['Hindi', 'billing', 'hindi'],
    });
    expect(skills.body).toEqual({ skills: ['hindi', 'billing'] });
    expect(
      (await agent.client.req('PUT', `/automation/members/${row.id}/skills`, { skills: ['x'] }))
        .status,
    ).toBe(403);
  });

  it('agents cannot change automation', async () => {
    const s = await workspace();
    const agent = await s.join('agent');
    expect((await agent.client.get('/automation/settings')).status).toBe(403);
    expect(
      (
        await agent.client.post('/automation/auto-replies', {
          name: 'x',
          matchType: 'exact',
          keywords: ['x'],
          reply: 'y',
        })
      ).status,
    ).toBe(403);
  });
});

describe('notifications', () => {
  it('each person sees and marks only their own', async () => {
    const s = await workspace();
    const agent = await s.join('agent');
    await withTenant(owner, { orgId: s.orgId }, (tx) =>
      tx.notification.createMany({
        data: [
          { orgId: s.orgId, userId: s.userId, kind: 'sla_breached', title: 'For owner' },
          {
            orgId: s.orgId,
            userId: agent.userId,
            kind: 'conversation_assigned',
            title: 'For agent',
          },
          { orgId: s.orgId, userId: agent.userId, kind: 'sla_breached', title: 'Also agent' },
        ],
      }),
    );
    const mine = await agent.client.get('/notifications');
    expect(mine.body.items.map((n: { title: string }) => n.title).sort()).toEqual([
      'Also agent',
      'For agent',
    ]);
    expect(mine.body.unread).toBe(2);

    const read = await agent.client.post('/notifications/read', { ids: [mine.body.items[0].id] });
    expect(read.body).toEqual({ marked: 1 });
    expect((await agent.client.get('/notifications')).body.unread).toBe(1);

    // Someone else's id marks nothing.
    const ownerList = await s.client.get('/notifications');
    expect(ownerList.body.items).toHaveLength(1);
    const cross = await agent.client.post('/notifications/read', {
      ids: [ownerList.body.items[0].id],
    });
    expect(cross.body).toEqual({ marked: 0 });

    expect((await agent.client.post('/notifications/read', { all: true })).body).toEqual({
      marked: 1,
    });
    expect((await s.client.get('/notifications')).body.unread).toBe(1);
  });

  it('refuses a bad request', async () => {
    const s = await workspace();
    const res = await s.client.post('/notifications/read', { ids: [] });
    expect(res.body.code).toBe(ErrorCode.VALIDATION_FAILED);
  });
});
