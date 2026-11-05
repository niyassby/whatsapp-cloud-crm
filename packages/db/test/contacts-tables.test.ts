import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DbClient } from '../src/client';
import { withTenant } from '../src/tenant';
import { appClient, createTenant, ownerClient, type TenantFixture } from './fixtures';

let owner: DbClient;
let app: DbClient;
let a: TenantFixture;
let b: TenantFixture;
let contactB: string;
let tagB: string;

const asA = <T>(fn: Parameters<typeof withTenant<T>>[2]) =>
  withTenant(app, { orgId: a.orgId, userId: a.userId }, fn);

beforeAll(async () => {
  owner = ownerClient();
  app = appClient();
  a = await createTenant(owner);
  b = await createTenant(owner);
  contactB = randomUUID();
  tagB = randomUUID();
  await withTenant(app, { orgId: b.orgId, userId: b.userId }, async (tx) => {
    await tx.contact.create({ data: { id: contactB, orgId: b.orgId, waId: '919800000099' } });
    await tx.tag.create({ data: { id: tagB, orgId: b.orgId, name: 'vip' } });
    await tx.contactTag.create({ data: { orgId: b.orgId, contactId: contactB, tagId: tagB } });
    await tx.contactField.create({
      data: { orgId: b.orgId, key: 'plan', label: 'Plan', type: 'text' },
    });
    await tx.contactNote.create({ data: { orgId: b.orgId, contactId: contactB, body: 'secret' } });
    await tx.contactConsentEvent.create({
      data: { orgId: b.orgId, contactId: contactB, status: 'opted_in', source: 'test' },
    });
    await tx.segment.create({ data: { orgId: b.orgId, name: 'S', filter: {} } });
    await tx.contactJob.create({ data: { orgId: b.orgId, kind: 'export', options: {} } });
  });
});

afterAll(async () => {
  await app.$disconnect();
  await owner.$disconnect();
});

describe('contact tables: tenant isolation', () => {
  it('another org sees none of the rows', async () => {
    const seen = await asA(async (tx) => ({
      contacts: await tx.contact.count({ where: { id: contactB } }),
      tags: await tx.tag.count({ where: { id: tagB } }),
      links: await tx.contactTag.count({ where: { contactId: contactB } }),
      fields: await tx.contactField.count({ where: { orgId: b.orgId } }),
      notes: await tx.contactNote.count({ where: { contactId: contactB } }),
      consent: await tx.contactConsentEvent.count({ where: { contactId: contactB } }),
      segments: await tx.segment.count({ where: { orgId: b.orgId } }),
      jobs: await tx.contactJob.count({ where: { orgId: b.orgId } }),
    }));
    expect(seen).toEqual({
      contacts: 0,
      tags: 0,
      links: 0,
      fields: 0,
      notes: 0,
      consent: 0,
      segments: 0,
      jobs: 0,
    });
  });

  it('another org cannot write rows into this org', async () => {
    await expect(
      asA((tx) => tx.tag.create({ data: { orgId: b.orgId, name: 'evil' } })),
    ).rejects.toThrow();
    await expect(
      asA((tx) =>
        tx.contactConsentEvent.create({
          data: { orgId: b.orgId, contactId: contactB, status: 'opted_in' },
        }),
      ),
    ).rejects.toThrow();
  });

  it('another org cannot change rows through a raw upsert', async () => {
    // The same number in another org is a separate contact, not a conflict with org B's row.
    await asA(
      (tx) => tx.$executeRaw`
        INSERT INTO contacts (id, org_id, wa_id, updated_at)
        VALUES (gen_random_uuid(), ${a.orgId}::uuid, '919800000099', now())
        ON CONFLICT (org_id, wa_id) DO NOTHING`,
    );
    const rows = await withTenant(app, { orgId: b.orgId, userId: b.userId }, (tx) =>
      tx.contact.findMany({ where: { waId: '919800000099' }, select: { id: true } }),
    );
    expect(rows).toEqual([{ id: contactB }]);
  });
});

describe('consent history', () => {
  it('is append-only for the app role', async () => {
    const asB = <T>(fn: Parameters<typeof withTenant<T>>[2]) =>
      withTenant(app, { orgId: b.orgId, userId: b.userId }, fn);
    await expect(
      asB((tx) =>
        tx.contactConsentEvent.updateMany({
          where: { contactId: contactB },
          data: { status: 'opted_out' },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      asB((tx) => tx.contactConsentEvent.deleteMany({ where: { contactId: contactB } })),
    ).rejects.toThrow();
  });
});

describe('contacts', () => {
  it('cannot be hard-deleted by the app role', async () => {
    await expect(
      withTenant(app, { orgId: b.orgId, userId: b.userId }, (tx) =>
        tx.contact.deleteMany({ where: { id: contactB } }),
      ),
    ).rejects.toThrow();
  });
});
