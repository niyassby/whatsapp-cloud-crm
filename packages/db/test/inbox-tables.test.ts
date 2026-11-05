/** Isolation for inbox tables, and proof the partitions cannot be used to get around RLS. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DbClient } from '../src/client';
import { withDbContext, withTenant } from '../src/tenant';
import { appClient, createTenant, ownerClient, type TenantFixture } from './fixtures';

let owner: DbClient;
let app: DbClient;
let a: TenantFixture;
let b: TenantFixture;

async function seedConversation(t: TenantFixture) {
  return withTenant(app, { orgId: t.orgId, userId: t.userId }, async (tx) => {
    const waba = await tx.wabaAccount.create({ data: { orgId: t.orgId, wabaId: randomUUID() } });
    const phone = await tx.phoneNumber.create({
      data: {
        orgId: t.orgId,
        wabaAccountId: waba.id,
        phoneNumberId: randomUUID(),
        credentialSource: 'manual',
        status: 'connected',
      },
    });
    const contact = await tx.contact.create({ data: { orgId: t.orgId, waId: randomUUID() } });
    const conversation = await tx.conversation.create({
      data: { orgId: t.orgId, phoneId: phone.id, contactId: contact.id },
    });
    const message = await tx.message.create({
      data: {
        orgId: t.orgId,
        conversationId: conversation.id,
        direction: 'inbound',
        type: 'text',
        status: 'received',
        body: `secret of ${t.orgId}`,
      },
    });
    return { conversation, contact, message, phone };
  });
}

let seededA: Awaited<ReturnType<typeof seedConversation>>;

beforeAll(async () => {
  owner = ownerClient();
  app = appClient();
  a = await createTenant(owner);
  b = await createTenant(owner);
  seededA = await seedConversation(a);
  await seedConversation(b);
});

afterAll(async () => {
  await app.$disconnect();
  await owner.$disconnect();
});

const asB = <T>(fn: Parameters<typeof withTenant<T>>[2]) =>
  withTenant(app, { orgId: b.orgId, userId: b.userId }, fn);

describe('inbox tables under RLS', () => {
  it('another org sees nothing by id, by filter, or with raw SQL', async () => {
    const res = await asB(async (tx) => ({
      contact: await tx.contact.findUnique({ where: { id: seededA.contact.id } }),
      conversation: await tx.conversation.findUnique({ where: { id: seededA.conversation.id } }),
      messages: await tx.message.findMany({ where: { orgId: a.orgId } }),
      byConversation: await tx.message.findMany({
        where: { conversationId: seededA.conversation.id },
      }),
      raw: await tx.$queryRaw<unknown[]>`SELECT * FROM messages WHERE org_id = ${a.orgId}::uuid`,
    }));
    expect(res).toEqual({
      contact: null,
      conversation: null,
      messages: [],
      byConversation: [],
      raw: [],
    });
  });

  it('nothing is visible without a context', async () => {
    const counts = await withDbContext(app, {}, async (tx) => [
      await tx.contact.count(),
      await tx.conversation.count(),
      await tx.message.count(),
      await tx.messageRef.count(),
      await tx.label.count(),
      await tx.cannedReply.count(),
    ]);
    expect(counts).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('another org cannot insert into or change this org', async () => {
    await expect(
      asB((tx) =>
        tx.message.create({
          data: {
            orgId: a.orgId,
            conversationId: seededA.conversation.id,
            direction: 'inbound',
            type: 'text',
            status: 'received',
          },
        }),
      ),
    ).rejects.toThrow();
    const updated = await asB(
      (tx) => tx.$executeRaw`UPDATE messages SET body = 'pwned' WHERE org_id = ${a.orgId}::uuid`,
    );
    expect(updated).toBe(0);
  });

  it('the app role cannot delete conversation history', async () => {
    await expect(
      withTenant(app, { orgId: a.orgId }, (tx) => tx.$executeRaw`DELETE FROM messages`),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      withTenant(app, { orgId: a.orgId }, (tx) => tx.$executeRaw`DELETE FROM message_refs`),
    ).rejects.toThrow(/permission denied/i);
  });

  it('references dedupe per org: two orgs can hold the same key', async () => {
    const ref = randomUUID();
    const data = (orgId: string) => ({
      orgId,
      kind: 'wamid',
      ref,
      messageId: randomUUID(),
      messageCreatedAt: new Date(),
    });
    const inA = await withTenant(app, { orgId: a.orgId }, (tx) =>
      tx.messageRef.createMany({ data: data(a.orgId), skipDuplicates: true }),
    );
    const again = await withTenant(app, { orgId: a.orgId }, (tx) =>
      tx.messageRef.createMany({ data: data(a.orgId), skipDuplicates: true }),
    );
    const inB = await asB((tx) =>
      tx.messageRef.createMany({ data: data(b.orgId), skipDuplicates: true }),
    );
    expect([inA.count, again.count, inB.count]).toEqual([1, 0, 1]);
  });
});

describe('partitions cannot be used to bypass RLS', () => {
  const partition = () => {
    const d = new Date();
    return `message_partitions.messages_${d.getUTCFullYear()}_${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  };

  it('the current partition really holds the data', async () => {
    const rows = await owner.$queryRawUnsafe<unknown[]>(`SELECT 1 FROM ${partition()} LIMIT 1`);
    expect(rows.length).toBe(1);
  });

  it('the app role cannot read a partition directly, even with an org context', async () => {
    await expect(
      withTenant(app, { orgId: b.orgId }, (tx) =>
        tx.$queryRawUnsafe(`SELECT body FROM ${partition()}`),
      ),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      withTenant(app, { orgId: b.orgId }, (tx) =>
        tx.$queryRawUnsafe('SELECT body FROM message_partitions.messages_default'),
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('the app role has no access to the partition schema at all', async () => {
    const [row] = await owner.$queryRaw<{ usage: boolean; create: boolean }[]>`
      SELECT has_schema_privilege('app_user', 'message_partitions', 'USAGE') AS usage,
             has_schema_privilege('app_user', 'message_partitions', 'CREATE') AS "create"`;
    expect(row).toEqual({ usage: false, create: false });
  });

  it('messages is partitioned, with RLS forced on the parent', async () => {
    const [row] = await owner.$queryRaw<{ kind: string; rls: boolean; forced: boolean }[]>`
      SELECT relkind::text AS kind, relrowsecurity AS rls, relforcerowsecurity AS forced
      FROM pg_class WHERE oid = 'public.messages'::regclass`;
    expect(row).toEqual({ kind: 'p', rls: true, forced: true });
  });

  it('a row outside every monthly partition lands in the default, never errors', async () => {
    const createdAt = new Date(Date.UTC(2040, 0, 1));
    const row = await withTenant(app, { orgId: a.orgId }, (tx) =>
      tx.message.create({
        data: {
          createdAt,
          orgId: a.orgId,
          conversationId: seededA.conversation.id,
          direction: 'inbound',
          type: 'text',
          status: 'received',
        },
      }),
    );
    const [where] = await owner.$queryRaw<{ partition: string }[]>`
      SELECT tableoid::regclass::text AS partition FROM messages
      WHERE id = ${row.id}::uuid AND created_at = ${createdAt}`;
    expect(where?.partition).toBe('message_partitions.messages_default');
  });

  it('the partition function rejects absurd month counts', async () => {
    await expect(
      app.$queryRaw`SELECT ensure_message_partitions(current_date, 500)`,
    ).rejects.toThrow(/between 1 and 24/);
  });
});
