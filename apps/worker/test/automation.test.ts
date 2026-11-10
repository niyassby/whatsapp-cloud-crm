/**
 * Phase 3.1 on real Postgres: rules run in the worker after the message is saved, reply at most
 * once per message however often it is delivered, and assign and time conversations.
 */
import { randomUUID } from 'node:crypto';
import { type DbClient, withTenant } from '@wacrm/db';
import type { AutomationSettingsInput } from '@wacrm/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkSla, runInboxAutomation, slaDueConversations } from '../src/processors/automation';
import { processMessagesChange } from '../src/processors/inbound';
import { buildDeps, connectNumber, createOrg, db, ownerDb } from './support';

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

const SETTINGS: AutomationSettingsInput = {
  welcomeEnabled: false,
  welcomeMessage: null,
  awayEnabled: false,
  awayMessage: null,
  businessHours: null,
  awayCooldownMinutes: 720,
  defaultAssignment: 'none',
  slaEnabled: false,
  slaFirstResponseMinutes: 60,
  slaEscalateAfterMinutes: null,
  slaReassignOnEscalate: false,
};

async function setup(settings: Partial<AutomationSettingsInput> = {}) {
  const orgId = await createOrg(client);
  const built = buildDeps(client);
  const number = await connectNumber(client, orgId);
  await withTenant(client, { orgId }, (tx) =>
    tx.automationSettings.create({
      data: {
        orgId,
        ...SETTINGS,
        ...settings,
        businessHours: (settings.businessHours ?? undefined) as object | undefined,
      },
    }),
  );

  /** A member of this org. Users are global, so they are made with the owner connection. */
  const member = async (
    name: string,
    over: { role?: 'owner' | 'admin' | 'agent'; available?: boolean; skills?: string[] } = {},
  ) => {
    const user = await owner.user.create({
      data: { email: `${randomUUID()}@automation.test`, name, passwordHash: 'x' },
    });
    await owner.membership.create({
      data: {
        orgId,
        userId: user.id,
        role: over.role ?? 'agent',
        available: over.available ?? true,
        skills: over.skills ?? [],
      },
    });
    return user.id;
  };

  const inbound = (from: string, text: string) => ({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: number.wabaId,
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '1', phone_number_id: number.phoneNumberId },
              contacts: [{ profile: { name: 'Priya' }, wa_id: from }],
              messages: [
                {
                  from,
                  id: `wamid.${randomUUID()}`,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: 'text',
                  text: { body: text },
                },
              ],
            },
          },
        ],
      },
    ],
  });

  /** What the webhook does, then what the automation queue does, as production runs them. */
  const say = async (text: string, from = '919876543210') => {
    const before = built.automation.length;
    await processMessagesChange(built.deps, orgId, inbound(from, text));
    for (const job of built.automation.slice(before)) await runInboxAutomation(built.deps, job);
  };

  const conversation = (waId = '919876543210') =>
    withTenant(client, { orgId }, (tx) =>
      tx.conversation.findFirstOrThrow({ where: { contact: { waId } } }),
    );
  const replies = () =>
    withTenant(client, { orgId }, (tx) =>
      tx.message.findMany({
        where: { orgId, direction: 'outbound' },
        orderBy: { createdAt: 'asc' },
      }),
    );
  const notifications = (userId: string) =>
    owner.notification.findMany({ where: { orgId, userId }, orderBy: { createdAt: 'asc' } });
  const rule = (data: object) =>
    withTenant(client, { orgId }, (tx) =>
      tx.autoReplyRule.create({ data: { orgId, matchType: 'contains', ...data } as never }),
    );
  const assignmentRule = (data: object) =>
    withTenant(client, { orgId }, (tx) =>
      tx.assignmentRule.create({ data: { orgId, strategy: 'round_robin', ...data } as never }),
    );
  return {
    orgId,
    number,
    say,
    member,
    conversation,
    replies,
    notifications,
    rule,
    assignmentRule,
    ...built,
  };
}

describe('where rules run', () => {
  it('the inbound pipeline only queues them, so a webhook never waits on a rule', async () => {
    const s = await setup({ welcomeEnabled: true, welcomeMessage: 'Welcome!' });
    await processMessagesChange(s.deps, s.orgId, {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: s.number.wabaId,
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '1', phone_number_id: s.number.phoneNumberId },
                contacts: [{ profile: { name: 'A' }, wa_id: '919876543210' }],
                messages: [
                  {
                    from: '919876543210',
                    id: `wamid.${randomUUID()}`,
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    type: 'text',
                    text: { body: 'Hello' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(s.automation).toHaveLength(1);
    expect(await s.replies()).toEqual([]);
    await runInboxAutomation(s.deps, s.automation[0]!);
    expect(await s.replies()).toHaveLength(1);
  });

  it('a redelivered webhook queues the rules again, but they act only once', async () => {
    const s = await setup({ welcomeEnabled: true, welcomeMessage: 'Welcome!' });
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: s.number.wabaId,
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '1', phone_number_id: s.number.phoneNumberId },
                contacts: [{ profile: { name: 'A' }, wa_id: '919876543210' }],
                messages: [
                  {
                    from: '919876543210',
                    id: `wamid.${randomUUID()}`,
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    type: 'text',
                    text: { body: 'Hello' },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    await processMessagesChange(s.deps, s.orgId, payload);
    await processMessagesChange(s.deps, s.orgId, payload);
    expect(s.automation).toHaveLength(2);
    expect(s.automation[0]!.messageId).toBe(s.automation[1]!.messageId);
    const results = await Promise.all(s.automation.map((j) => runInboxAutomation(s.deps, j)));
    expect(results.sort()).toEqual(['done', 'skipped']);
    expect(await s.replies()).toHaveLength(1);
  });
});

describe('auto-replies', () => {
  it('a keyword reply goes out through the outbound queue, marked as automated', async () => {
    const s = await setup();
    await s.rule({ name: 'Price', keywords: ['price'], reply: 'Plans start at 999.' });
    await s.say('What is the PRICE?');
    const [reply] = await s.replies();
    expect(reply).toMatchObject({
      type: 'text',
      status: 'queued',
      body: 'Plans start at 999.',
      senderUserId: null,
      content: { automation: 'keyword' },
    });
    expect(s.outbound).toEqual([
      { orgId: s.orgId, messageId: reply!.id, createdAt: reply!.createdAt.toISOString() },
    ]);
    expect(s.publisher.of('message:new').length).toBeGreaterThan(1);
  });

  it('the first rule in priority order answers, and only one', async () => {
    const s = await setup();
    await s.rule({ name: 'Late', keywords: ['order'], reply: 'Second', priority: 50 });
    await s.rule({ name: 'Early', keywords: ['order'], reply: 'First', priority: 10 });
    await s.say('where is my order');
    expect((await s.replies()).map((m) => m.body)).toEqual(['First']);
  });

  it('exact, regex, inactive rules and other numbers', async () => {
    const s = await setup();
    await s.rule({ name: 'Exact', matchType: 'exact', keywords: ['menu'], reply: 'The menu' });
    await s.rule({
      name: 'Regex',
      matchType: 'regex',
      pattern: '^order\\s*#?\\d{4,}$',
      reply: 'Looking it up',
    });
    await s.rule({ name: 'Off', keywords: ['hello'], reply: 'Off', active: false });
    await s.rule({ name: 'Elsewhere', keywords: ['hello'], reply: 'Other', phoneId: randomUUID() });
    await s.say('show me the menu');
    await s.say('Order #10421');
    await s.say('hello');
    expect((await s.replies()).map((m) => m.body)).toEqual(['Looking it up']);
  });

  it('a welcome goes once, to a new conversation', async () => {
    const s = await setup({ welcomeEnabled: true, welcomeMessage: 'Welcome to the shop!' });
    await s.say('hi');
    await s.say('are you there?');
    expect((await s.replies()).map((m) => m.body)).toEqual(['Welcome to the shop!']);
  });

  it('outside business hours, an away message once per cooldown', async () => {
    const closed = { days: {} };
    const s = await setup({
      awayEnabled: true,
      awayMessage: 'We are closed. Back at 9.',
      businessHours: closed,
      awayCooldownMinutes: 60,
    });
    await s.say('hello?');
    await s.say('anyone?');
    expect((await s.replies()).map((m) => m.body)).toEqual(['We are closed. Back at 9.']);
  });

  it('inside business hours, no away message', async () => {
    const always = {
      days: Object.fromEntries(
        ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [
          d,
          [{ from: '00:00', to: '24:00' }],
        ]),
      ),
    };
    const s = await setup({ awayEnabled: true, awayMessage: 'Closed', businessHours: always });
    await s.say('hello?');
    expect(await s.replies()).toEqual([]);
  });

  it('a keyword answer replaces the away message', async () => {
    const s = await setup({
      awayEnabled: true,
      awayMessage: 'Closed',
      businessHours: { days: {} },
    });
    await s.rule({ name: 'Hours', keywords: ['hours'], reply: 'We open at 9.' });
    await s.say('what are your hours');
    expect((await s.replies()).map((m) => m.body)).toEqual(['We open at 9.']);
  });

  it('never more than three automated replies an hour, so two bots cannot loop', async () => {
    const s = await setup();
    await s.rule({ name: 'Echo', keywords: ['ping'], reply: 'pong' });
    for (let i = 0; i < 6; i++) await s.say('ping');
    expect(await s.replies()).toHaveLength(3);
  });

  it('nothing automatic to someone who said STOP', async () => {
    const s = await setup({ welcomeEnabled: true, welcomeMessage: 'Welcome!' });
    await s.rule({ name: 'Stop', keywords: ['stop'], reply: 'Sorry to see you go' });
    await s.say('STOP');
    expect(await s.replies()).toEqual([]);
  });
});

describe('assignment', () => {
  it('round-robin across available agents, in turn', async () => {
    const s = await setup({ defaultAssignment: 'round_robin' });
    const a = await s.member('A');
    const b = await s.member('B');
    await s.member('Away', { available: false });
    await s.say('one', '919800000001');
    await s.say('two', '919800000002');
    await s.say('three', '919800000003');
    const assigned = await Promise.all(
      ['919800000001', '919800000002', '919800000003'].map(
        async (n) => (await s.conversation(n)).assigneeId,
      ),
    );
    const sorted = [a, b].sort();
    expect(assigned).toEqual([sorted[0], sorted[1], sorted[0]]);
  });

  it('load-based gives it to whoever has the fewest open conversations', async () => {
    const s = await setup({ defaultAssignment: 'load_based' });
    const busy = await s.member('Busy');
    const free = await s.member('Free');
    await s.say('first', '919800000001');
    await withTenant(client, { orgId: s.orgId }, (tx) =>
      tx.conversation.updateMany({ data: { assigneeId: busy } }),
    );
    await s.say('second', '919800000002');
    expect((await s.conversation('919800000002')).assigneeId).toBe(free);
  });

  it('a skill rule sends it to people with that skill', async () => {
    const s = await setup({ defaultAssignment: 'round_robin' });
    await s.member('General');
    const hindi = await s.member('Hindi speaker', { skills: ['hindi'] });
    await s.assignmentRule({ name: 'Hindi', keywords: ['hindi'], skill: 'hindi' });
    await s.say('Can someone help in Hindi?');
    expect((await s.conversation()).assigneeId).toBe(hindi);
  });

  it('a tag rule follows the contact’s tag, and named agents', async () => {
    const s = await setup();
    const vipDesk = await s.member('VIP desk');
    await s.member('Other');
    const tag = await withTenant(client, { orgId: s.orgId }, async (tx) => {
      const t = await tx.tag.create({ data: { orgId: s.orgId, name: 'VIP' } });
      const contact = await tx.contact.create({ data: { orgId: s.orgId, waId: '919876543210' } });
      await tx.contactTag.create({ data: { orgId: s.orgId, contactId: contact.id, tagId: t.id } });
      return t;
    });
    await s.assignmentRule({ name: 'VIP', tagIds: [tag.id], agentIds: [vipDesk] });
    await s.say('hello');
    expect((await s.conversation()).assigneeId).toBe(vipDesk);
  });

  it('a rule with nobody available falls through to the next, then the default', async () => {
    const s = await setup({ defaultAssignment: 'load_based' });
    const away = await s.member('Away', { available: false, skills: ['billing'] });
    const anyone = await s.member('Anyone');
    await s.assignmentRule({ name: 'Billing', skill: 'billing' });
    await s.say('hello');
    expect((await s.conversation()).assigneeId).toBe(anyone);
    expect((await s.conversation()).assigneeId).not.toBe(away);
  });

  it('with no rule and no default, nobody is assigned', async () => {
    const s = await setup();
    await s.member('A');
    await s.say('hello');
    expect((await s.conversation()).assigneeId).toBeNull();
  });

  it('an assigned conversation keeps its agent', async () => {
    const s = await setup({ defaultAssignment: 'round_robin' });
    const first = await s.member('First');
    await s.say('hello');
    await s.member('Second');
    await s.say('again');
    expect((await s.conversation()).assigneeId).toBe(first);
  });

  it('tells the agent, and only them', async () => {
    const s = await setup({ defaultAssignment: 'round_robin' });
    const agent = await s.member('Agent');
    await s.say('I need help');
    const [n] = await s.notifications(agent);
    expect(n).toMatchObject({
      kind: 'conversation_assigned',
      title: 'New conversation with Priya',
    });
    expect(s.publisher.of('notification:new')).toEqual([
      expect.objectContaining({ payload: { userId: agent } }),
    ]);
  });

  it('round-robin stays fair when many arrive at once', async () => {
    const s = await setup({ defaultAssignment: 'round_robin' });
    await s.member('A');
    await s.member('B');
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        s.say(`hi ${i}`, `9198000000${String(i).padStart(2, '0')}`),
      ),
    );
    const counts = await withTenant(client, { orgId: s.orgId }, (tx) =>
      tx.conversation.groupBy({ by: ['assigneeId'], _count: { _all: true } }),
    );
    expect(counts.map((c) => c._count._all).sort()).toEqual([5, 5]);
  }, 60_000);
});

describe('SLA', () => {
  const overdue = (s: { orgId: string }) =>
    withTenant(client, { orgId: s.orgId }, (tx) =>
      tx.conversation.updateMany({ data: { slaDueAt: new Date(Date.now() - 1000) } }),
    );

  it('starts at the first unanswered message, and later ones do not move it', async () => {
    const s = await setup({ slaEnabled: true, slaFirstResponseMinutes: 30 });
    await s.say('hello');
    const first = await s.conversation();
    expect(first.awaitingReplySince).toBeInstanceOf(Date);
    const wait = first.slaDueAt!.getTime() - first.awaitingReplySince!.getTime();
    expect(wait).toBe(30 * 60_000);
    await s.say('hello again');
    expect((await s.conversation()).slaDueAt).toEqual(first.slaDueAt);
  });

  it('a breach tells the assignee, or the managers when nobody has it', async () => {
    const s = await setup({ slaEnabled: true, slaFirstResponseMinutes: 5 });
    const manager = await s.member('Manager', { role: 'admin' });
    const agent = await s.member('Agent');
    await s.say('hello');
    await overdue(s);
    expect(await checkSla(s.deps, s.orgId, (await s.conversation()).id)).toBe('breached');
    expect((await s.notifications(manager)).map((n) => n.kind)).toEqual(['sla_breached']);
    expect(await s.notifications(agent)).toEqual([]);
    expect(await s.conversation()).toMatchObject({ slaStage: 1, slaDueAt: null });
  });

  it('escalates later, and can reassign to someone available', async () => {
    const s = await setup({
      slaEnabled: true,
      slaFirstResponseMinutes: 5,
      slaEscalateAfterMinutes: 10,
      slaReassignOnEscalate: true,
      defaultAssignment: 'round_robin',
    });
    const manager = await s.member('Manager', { role: 'owner', available: false });
    const first = await s.member('First');
    await s.say('hello');
    expect((await s.conversation()).assigneeId).toBe(first);
    const second = await s.member('Second');

    await overdue(s);
    await checkSla(s.deps, s.orgId, (await s.conversation()).id);
    expect((await s.notifications(first)).map((n) => n.kind)).toEqual([
      'conversation_assigned',
      'sla_breached',
    ]);
    const breached = await s.conversation();
    expect(breached.slaDueAt!.getTime() - Date.now()).toBeGreaterThan(9 * 60_000);

    await overdue(s);
    expect(await checkSla(s.deps, s.orgId, breached.id)).toBe('escalated');
    const after = await s.conversation();
    expect(after).toMatchObject({ assigneeId: second, slaStage: 2, slaDueAt: null });
    expect((await s.notifications(manager)).map((n) => n.kind)).toEqual(['sla_escalated']);
    expect((await s.notifications(second)).map((n) => n.kind)).toEqual(['conversation_assigned']);
  });

  it('the scheduler finds due conversations across orgs, by id only', async () => {
    const s = await setup({ slaEnabled: true });
    await s.say('hello');
    await overdue(s);
    const due = await slaDueConversations({ db: client });
    const mine = due.find((d) => d.org_id === s.orgId);
    expect(mine).toEqual({ org_id: s.orgId, id: (await s.conversation()).id });
  });

  it('a check that is not due, or already handled, does nothing', async () => {
    const s = await setup({ slaEnabled: true, slaFirstResponseMinutes: 60 });
    await s.say('hello');
    expect(await checkSla(s.deps, s.orgId, (await s.conversation()).id)).toBe('skipped');
    await overdue(s);
    const id = (await s.conversation()).id;
    const results = await Promise.all([
      checkSla(s.deps, s.orgId, id),
      checkSla(s.deps, s.orgId, id),
    ]);
    expect(results.sort()).toEqual(['breached', 'skipped']);
  });

  it('closing the thread or turning the SLA off stops it', async () => {
    const s = await setup({ slaEnabled: true });
    await s.say('hello');
    await overdue(s);
    await withTenant(client, { orgId: s.orgId }, (tx) =>
      tx.conversation.updateMany({ data: { status: 'closed' } }),
    );
    expect(await checkSla(s.deps, s.orgId, (await s.conversation()).id)).toBe('cleared');
    expect((await s.conversation()).slaDueAt).toBeNull();
  });

  it('automated replies do not stop the clock', async () => {
    const s = await setup({ slaEnabled: true, welcomeEnabled: true, welcomeMessage: 'Hi!' });
    await s.say('hello');
    expect((await s.replies()).length).toBe(1);
    expect((await s.conversation()).awaitingReplySince).toBeInstanceOf(Date);
  });
});
