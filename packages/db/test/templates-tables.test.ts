import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DbClient } from '../src/client';
import { withTenant } from '../src/tenant';
import { appClient, createTenant, ownerClient, type TenantFixture } from './fixtures';

let owner: DbClient;
let app: DbClient;
let a: TenantFixture;
let b: TenantFixture;
let wabaA: string;
let wabaB: string;
let templateB: string;

const asA = <T>(fn: Parameters<typeof withTenant<T>>[2]) =>
  withTenant(app, { orgId: a.orgId, userId: a.userId }, fn);

beforeAll(async () => {
  owner = ownerClient();
  app = appClient();
  a = await createTenant(owner);
  b = await createTenant(owner);
  wabaA = randomUUID();
  wabaB = randomUUID();
  templateB = randomUUID();
  await withTenant(app, { orgId: a.orgId, userId: a.userId }, (tx) =>
    tx.wabaAccount.create({ data: { id: wabaA, orgId: a.orgId, wabaId: randomUUID() } }),
  );
  await withTenant(app, { orgId: b.orgId, userId: b.userId }, async (tx) => {
    await tx.wabaAccount.create({ data: { id: wabaB, orgId: b.orgId, wabaId: randomUUID() } });
    await tx.messageTemplate.create({
      data: {
        id: templateB,
        orgId: b.orgId,
        wabaAccountId: wabaB,
        name: 'secret',
        language: 'en',
        category: 'UTILITY',
      },
    });
  });
});

afterAll(async () => {
  await app.$disconnect();
  await owner.$disconnect();
});

describe('message_templates: tenant isolation', () => {
  it('another org cannot read it', async () => {
    const seen = await asA(async (tx) => ({
      byId: await tx.messageTemplate.findUnique({ where: { id: templateB } }),
      byOrg: await tx.messageTemplate.count({ where: { orgId: b.orgId } }),
      all: await tx.messageTemplate.count(),
    }));
    expect(seen).toEqual({ byId: null, byOrg: 0, all: 0 });
  });

  it('another org cannot change or delete it', async () => {
    const changed = await asA((tx) =>
      tx.messageTemplate.updateMany({ where: { id: templateB }, data: { status: 'approved' } }),
    );
    const deleted = await asA((tx) => tx.messageTemplate.deleteMany({ where: { id: templateB } }));
    expect(changed.count).toBe(0);
    expect(deleted.count).toBe(0);
  });

  it('another org cannot write into it', async () => {
    await expect(
      asA((tx) =>
        tx.messageTemplate.create({
          data: {
            orgId: b.orgId,
            wabaAccountId: wabaB,
            name: 'evil',
            language: 'en',
            category: 'UTILITY',
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it('is invisible without an org context', async () => {
    const rows = await withTenant(app, { userId: a.userId } as never, (tx) =>
      tx.messageTemplate.count(),
    ).catch(() => 0);
    expect(rows).toBe(0);
  });
});

describe('template_sync_targets', () => {
  it('returns only ids', async () => {
    const rows = await app.$queryRaw<Record<string, unknown>[]>`
      SELECT * FROM template_sync_targets()`;
    for (const row of rows) expect(Object.keys(row).sort()).toEqual(['org_id', 'waba_account_id']);
  });
});
