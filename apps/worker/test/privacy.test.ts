/**
 * Phase 4.4 in the worker: export and erasure requests, the end of a deletion grace period, the
 * purge a week later, expiring export files and message retention. Real Postgres, memory storage.
 */
import { randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { type DbClient, erasedAmong, withTenant } from '@wacrm/db';
import { identityHash } from '@wacrm/shared/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runPrivacyRequest, runPrivacyTick } from '../src/processors/privacy';
import { buildDeps, connectNumber, createOrg, db, ownerDb } from './support';

const SECRET = 'test-identity-secret';
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

const deps = () => {
  const built = buildDeps(client);
  return { ...built, deps: { ...built.deps, identitySecret: SECRET } };
};

/** A workspace with one contact who wrote in, with a photo. */
async function scene() {
  const orgId = await createOrg(client);
  const phone = await connectNumber(client, orgId);
  const ids = await withTenant(client, { orgId }, async (tx) => {
    const channel = await tx.channel.findUniqueOrThrow({ where: { phoneId: phone.id } });
    const contact = await tx.contact.create({
      data: { orgId, name: 'Kavya', waId: `9198${Math.floor(Math.random() * 1e8)}` },
    });
    const conversation = await tx.conversation.create({
      data: { orgId, channelId: channel.id, phoneId: phone.id, contactId: contact.id },
    });
    await tx.message.create({
      data: {
        orgId,
        conversationId: conversation.id,
        direction: 'inbound',
        type: 'image',
        status: 'received',
        body: 'Here is my ID card',
        mediaKey: `orgs/${orgId}/messages/id-card`,
      },
    });
    return { contactId: contact.id, waId: contact.waId as string };
  });
  return { orgId, phone, ...ids };
}

const request = (orgId: string, kind: string, contactId?: string) =>
  withTenant(client, { orgId }, (tx) =>
    tx.privacyRequest.create({ data: { orgId, kind, contactId: contactId ?? null } }),
  );

describe('requests', () => {
  it('exports a contact as one JSON file, kept for a week', async () => {
    const s = await scene();
    const ctx = deps();
    const r = await request(s.orgId, 'contact_export', s.contactId);
    expect(await runPrivacyRequest(ctx.deps, s.orgId, r.id)).toBe('done');
    // A second run (a retried job) finds it done.
    expect(await runPrivacyRequest(ctx.deps, s.orgId, r.id)).toBe('skipped');
    const row = await withTenant(client, { orgId: s.orgId }, (tx) =>
      tx.privacyRequest.findUniqueOrThrow({ where: { id: r.id } }),
    );
    expect(row.status).toBe('done');
    expect(row.expiresAt!.getTime() - Date.now()).toBeGreaterThan(6 * 86_400_000);
    const doc = JSON.parse((await ctx.storage.get(row.fileKey!)).toString());
    expect(doc.contact).toMatchObject({ name: 'Kavya', phone: `+${s.waId}` });
    expect(doc.conversations[0].messages[0].body).toBe('Here is my ID card');
  });

  it('erases a contact, deletes their files, and remembers the number only as a hash', async () => {
    const s = await scene();
    const ctx = deps();
    await ctx.storage.put(`orgs/${s.orgId}/messages/id-card`, Buffer.from('jpeg'), 'image/jpeg');
    const r = await request(s.orgId, 'contact_erase', s.contactId);
    expect(await runPrivacyRequest(ctx.deps, s.orgId, r.id)).toBe('done');
    expect(ctx.storage.objects.has(`orgs/${s.orgId}/messages/id-card`)).toBe(false);
    const seen = await withTenant(client, { orgId: s.orgId }, async (tx) => ({
      contact: await tx.contact.findUniqueOrThrow({ where: { id: s.contactId } }),
      message: await tx.message.findFirstOrThrow(),
      erased: await erasedAmong(tx, s.orgId, [identityHash(SECRET, s.orgId, s.waId)]),
    }));
    expect(seen.contact).toMatchObject({ name: 'Erased contact', waId: null });
    expect(seen.message).toMatchObject({ body: null, mediaKey: null });
    expect(seen.erased.size).toBe(1);
  });

  it('exports a whole workspace without credentials', async () => {
    const s = await scene();
    const ctx = deps();
    await owner.phoneNumber.update({
      where: { id: s.phone.id },
      data: { accessTokenEnc: 'v1.top-secret-ciphertext' },
    });
    const r = await request(s.orgId, 'org_export');
    expect(await runPrivacyRequest(ctx.deps, s.orgId, r.id)).toBe('done');
    const row = await withTenant(client, { orgId: s.orgId }, (tx) =>
      tx.privacyRequest.findUniqueOrThrow({ where: { id: r.id } }),
    );
    const text = gunzipSync(await ctx.storage.get(row.fileKey!)).toString();
    const lines = text
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { table: string });
    expect(lines.filter((l) => l.table === 'contacts')).toHaveLength(1);
    expect(lines.filter((l) => l.table === 'messages')).toHaveLength(1);
    expect(text).not.toContain('top-secret-ciphertext');
  });
});

describe('the daily pass', () => {
  it('deletes a workspace after its grace period, purges it a week later, and expires exports', async () => {
    const s = await scene();
    const ctx = deps();
    // The owner asked 15 days ago; the 14 days are over.
    await owner.organization.update({
      where: { id: s.orgId },
      data: {
        deletionRequestedAt: new Date(Date.now() - 15 * 86_400_000),
        purgeAfter: new Date(Date.now() - 86_400_000),
      },
    });
    const exportReq = await request(s.orgId, 'contact_export', s.contactId);
    await runPrivacyRequest(ctx.deps, s.orgId, exportReq.id);
    await owner.privacyRequest.update({
      where: { id: exportReq.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const first = await runPrivacyTick(ctx.deps, { logRetentionDays: 180 });
    expect(first.deleted).toBeGreaterThanOrEqual(1);
    expect(first.expired).toBeGreaterThanOrEqual(1);
    const org = await owner.organization.findUniqueOrThrow({ where: { id: s.orgId } });
    expect(org.deletedAt).not.toBeNull();
    const number = await owner.phoneNumber.findUniqueOrThrow({ where: { id: s.phone.id } });
    expect(number.status).toBe('disconnected');
    const expired = await owner.privacyRequest.findUniqueOrThrow({ where: { id: exportReq.id } });
    expect(expired).toMatchObject({ status: 'expired', fileKey: null });
    expect([...ctx.storage.objects.keys()].some((k) => k.includes(exportReq.id))).toBe(false);

    // Not yet purged: the week after the soft delete has not passed.
    expect((await runPrivacyTick(ctx.deps, { logRetentionDays: 180 })).purged).toBe(0);
    await owner.organization.update({
      where: { id: s.orgId },
      data: { deletedAt: new Date(Date.now() - 8 * 86_400_000) },
    });
    await ctx.storage.put(`orgs/${s.orgId}/messages/x`, Buffer.from('x'), 'image/jpeg');
    const later = await runPrivacyTick(ctx.deps, { logRetentionDays: 180 });
    expect(later.purged).toBeGreaterThanOrEqual(1);
    expect(await owner.organization.findUnique({ where: { id: s.orgId } })).toBeNull();
    expect(await owner.contact.count({ where: { orgId: s.orgId } })).toBe(0);
    expect([...ctx.storage.objects.keys()].some((k) => k.startsWith(`orgs/${s.orgId}/`))).toBe(
      false,
    );
  });

  it('applies a workspace’s message retention period', async () => {
    const s = await scene();
    const ctx = deps();
    await withTenant(client, { orgId: s.orgId }, async (tx) => {
      const conv = await tx.conversation.findFirstOrThrow();
      await tx.message.create({
        data: {
          id: randomUUID(),
          createdAt: new Date(Date.now() - 45 * 86_400_000),
          orgId: s.orgId,
          conversationId: conv.id,
          direction: 'inbound',
          type: 'text',
          status: 'received',
          body: 'Old and private',
        },
      });
    });
    await owner.organization.update({ where: { id: s.orgId }, data: { messageRetentionDays: 30 } });
    const result = await runPrivacyTick(ctx.deps, { logRetentionDays: 180 });
    expect(result.messages).toBeGreaterThanOrEqual(1);
    const bodies = await withTenant(client, { orgId: s.orgId }, (tx) =>
      tx.message.findMany({ orderBy: { createdAt: 'asc' }, select: { body: true } }),
    );
    expect(bodies.map((b) => b.body)).toEqual([null, 'Here is my ID card']);
  });
});
