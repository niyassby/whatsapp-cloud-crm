import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DbClient } from '../src/client';
import { withTenant } from '../src/tenant';
import { appClient, createTenant, ownerClient, type TenantFixture } from './fixtures';

let owner: DbClient;
let app: DbClient;
let a: TenantFixture;
let b: TenantFixture;
let otherUser: string;

beforeAll(async () => {
  owner = ownerClient();
  app = appClient();
  a = await createTenant(owner);
  b = await createTenant(owner);
  const user = await owner.user.create({
    data: { email: `${randomUUID()}@notify.test`, name: 'Colleague', passwordHash: 'x' },
  });
  otherUser = user.id;
  await owner.membership.create({ data: { orgId: b.orgId, userId: otherUser, role: 'agent' } });
  await withTenant(app, { orgId: b.orgId, userId: b.userId }, async (tx) => {
    await tx.automationSettings.create({ data: { orgId: b.orgId, welcomeEnabled: true } });
    await tx.autoReplyRule.create({
      data: { orgId: b.orgId, name: 'Theirs', matchType: 'contains', keywords: ['x'], reply: 'y' },
    });
    await tx.assignmentRule.create({
      data: { orgId: b.orgId, name: 'Theirs', strategy: 'round_robin', skill: 'x' },
    });
    await tx.notification.createMany({
      data: [
        { orgId: b.orgId, userId: b.userId, kind: 'sla_breached', title: 'For B owner' },
        { orgId: b.orgId, userId: otherUser, kind: 'sla_breached', title: 'For colleague' },
      ],
    });
  });
});

afterAll(async () => {
  await app.$disconnect();
  await owner.$disconnect();
});

const asA = <T>(fn: Parameters<typeof withTenant<T>>[2]) =>
  withTenant(app, { orgId: a.orgId, userId: a.userId }, fn);

describe('tenant isolation', () => {
  it('another org sees none of it', async () => {
    const seen = await asA(async (tx) => ({
      settings: await tx.automationSettings.count(),
      autoReplies: await tx.autoReplyRule.count(),
      assignment: await tx.assignmentRule.count(),
      notifications: await tx.notification.count(),
    }));
    expect(seen).toEqual({ settings: 0, autoReplies: 0, assignment: 0, notifications: 0 });
  });

  it('another org cannot change or delete it', async () => {
    const results = await asA(async (tx) => [
      await tx.autoReplyRule.updateMany({ data: { reply: 'pwned' } }),
      await tx.autoReplyRule.deleteMany(),
      await tx.assignmentRule.updateMany({ data: { skill: 'pwned' } }),
      await tx.automationSettings.updateMany({ data: { welcomeMessage: 'pwned' } }),
      await tx.notification.updateMany({ data: { readAt: new Date() } }),
    ]);
    expect(results.map((r) => r.count)).toEqual([0, 0, 0, 0, 0]);
  });

  it('another org cannot write into it', async () => {
    await expect(
      asA((tx) =>
        tx.autoReplyRule.create({
          data: { orgId: b.orgId, name: 'x', matchType: 'contains', reply: 'y' },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      asA((tx) =>
        tx.notification.createMany({
          data: [{ orgId: b.orgId, userId: b.userId, kind: 'sla_breached', title: 'Planted' }],
        }),
      ),
    ).rejects.toThrow();
  });
});

describe('notifications are private to their person', () => {
  it('each member sees only their own, even in the same org', async () => {
    const mine = await withTenant(app, { orgId: b.orgId, userId: b.userId }, (tx) =>
      tx.notification.findMany({ select: { title: true } }),
    );
    expect(mine).toEqual([{ title: 'For B owner' }]);
    const theirs = await withTenant(app, { orgId: b.orgId, userId: otherUser }, (tx) =>
      tx.notification.findMany({ select: { title: true } }),
    );
    expect(theirs).toEqual([{ title: 'For colleague' }]);
  });

  it('nobody can mark someone else’s as read', async () => {
    const res = await withTenant(app, { orgId: b.orgId, userId: b.userId }, (tx) =>
      tx.notification.updateMany({
        where: { title: 'For colleague' },
        data: { readAt: new Date() },
      }),
    );
    expect(res.count).toBe(0);
  });

  it('with no person in context, none are visible, but the worker can still notify', async () => {
    await withTenant(app, { orgId: b.orgId }, async (tx) => {
      expect(await tx.notification.count()).toBe(0);
      await tx.notification.createMany({
        data: [{ orgId: b.orgId, userId: otherUser, kind: 'conversation_assigned', title: 'New' }],
      });
    });
  });

  it('cannot be deleted by the app', async () => {
    await expect(
      withTenant(app, { orgId: b.orgId, userId: b.userId }, (tx) => tx.notification.deleteMany()),
    ).rejects.toThrow();
  });
});

describe('the SLA scheduler function', () => {
  it('answers ids only', async () => {
    const rows = await app.$queryRaw<Record<string, unknown>[]>`
      SELECT * FROM sla_due_conversations(10)`;
    for (const row of rows) expect(Object.keys(row).sort()).toEqual(['id', 'org_id']);
  });
});
