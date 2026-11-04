/**
 * Cross-tenant isolation suite. These tests MUST always pass.
 * Every assertion runs on the app-role connection, i.e. exactly what production code uses.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DbClient } from '../src/client';
import { InvalidDbContextError, withDbContext, withTenant } from '../src/tenant';
import {
  appClient,
  createPartner,
  createTenant,
  ownerClient,
  type TenantFixture,
} from './fixtures';

let owner: DbClient;
let app: DbClient;
let a: TenantFixture;
let b: TenantFixture;

beforeAll(async () => {
  owner = ownerClient();
  app = appClient();
  const partnerId = await createPartner(owner);
  a = await createTenant(owner, { partnerId });
  b = await createTenant(owner);
});

afterAll(async () => {
  await app.$disconnect();
  await owner.$disconnect();
});

const asA = <T>(fn: Parameters<typeof withTenant<T>>[2]) =>
  withTenant(app, { orgId: a.orgId, userId: a.userId }, fn);

describe('without context', () => {
  it('sees no rows in any tenant table', async () => {
    const counts = await withDbContext(app, {}, async (tx) => [
      await tx.organization.count(),
      await tx.membership.count(),
      await tx.user.count(),
      await tx.apiKey.count(),
      await tx.auditLog.count(),
      await tx.partner.count(),
    ]);
    expect(counts).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('sees no rows outside a transaction either', async () => {
    expect(await app.organization.count()).toBe(0);
    expect(await app.apiKey.count()).toBe(0);
  });
});

describe('Prisma queries in org A', () => {
  it('only return org A rows', async () => {
    const result = await asA(async (tx) => ({
      orgs: await tx.organization.findMany({ select: { id: true } }),
      memberships: await tx.membership.findMany({ select: { orgId: true } }),
      apiKeys: await tx.apiKey.findMany({ select: { orgId: true } }),
      auditLogs: await tx.auditLog.findMany({ select: { orgId: true } }),
      users: await tx.user.findMany({ select: { id: true } }),
    }));
    expect(result.orgs).toEqual([{ id: a.orgId }]);
    expect(result.memberships).toEqual([{ orgId: a.orgId }]);
    expect(result.apiKeys).toEqual([{ orgId: a.orgId }]);
    expect(result.auditLogs.every((r) => r.orgId === a.orgId)).toBe(true);
    expect(result.users).toEqual([{ id: a.userId }]);
  });

  it('cannot fetch org B rows by id', async () => {
    const result = await asA(async (tx) => ({
      org: await tx.organization.findUnique({ where: { id: b.orgId } }),
      key: await tx.apiKey.findUnique({ where: { id: b.apiKeyId } }),
      log: await tx.auditLog.findUnique({ where: { id: b.auditLogId } }),
      user: await tx.user.findUnique({ where: { id: b.userId } }),
      viaFilter: await tx.membership.findMany({ where: { orgId: b.orgId } }),
    }));
    expect(result).toEqual({ org: null, key: null, log: null, user: null, viaFilter: [] });
  });

  it('cannot reach org B through relations', async () => {
    const user = await asA((tx) =>
      tx.user.findUnique({ where: { id: a.userId }, include: { memberships: true } }),
    );
    expect(user?.memberships.map((m) => m.orgId)).toEqual([a.orgId]);
  });

  it('cannot insert rows into org B', async () => {
    await expect(
      asA((tx) =>
        tx.apiKey.create({
          data: {
            orgId: b.orgId,
            name: 'evil',
            prefix: `pk_evil_${b.orgId}`,
            keyHash: `evil-${b.orgId}`,
          },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      asA((tx) => tx.auditLog.create({ data: { orgId: b.orgId, action: 'evil' } })),
    ).rejects.toThrow();
    await expect(
      asA((tx) =>
        tx.membership.create({ data: { orgId: b.orgId, userId: a.userId, role: 'owner' } }),
      ),
    ).rejects.toThrow();
  });

  it('cannot update or delete org B rows', async () => {
    const result = await asA(async (tx) => ({
      updKeys: await tx.apiKey.updateMany({ where: { orgId: b.orgId }, data: { name: 'pwned' } }),
      delKeys: await tx.apiKey.deleteMany({ where: { orgId: b.orgId } }),
      updOrg: await tx.organization.updateMany({ where: { id: b.orgId }, data: { name: 'pwned' } }),
      delMemberships: await tx.membership.deleteMany({ where: { orgId: b.orgId } }),
    }));
    expect(result).toEqual({
      updKeys: { count: 0 },
      delKeys: { count: 0 },
      updOrg: { count: 0 },
      delMemberships: { count: 0 },
    });
  });

  it('cannot move an org A row into org B', async () => {
    await expect(
      asA((tx) => tx.apiKey.update({ where: { id: a.apiKeyId }, data: { orgId: b.orgId } })),
    ).rejects.toThrow();
  });
});

describe('raw SQL in org A', () => {
  it('SELECT * only returns org A rows', async () => {
    const rows = await asA((tx) => tx.$queryRaw<{ org_id: string }[]>`SELECT org_id FROM api_keys`);
    expect(rows).toEqual([{ org_id: a.orgId }]);
  });

  it('explicit WHERE org_id = B returns nothing', async () => {
    const rows = await asA((tx) =>
      tx.$queryRawUnsafe<unknown[]>('SELECT * FROM memberships WHERE org_id = $1::uuid', b.orgId),
    );
    expect(rows).toEqual([]);
  });

  it('joins do not leak org B', async () => {
    const rows = await asA(
      (tx) =>
        tx.$queryRaw<{ id: string }[]>`
        SELECT o.id FROM organizations o
        JOIN memberships m ON m.org_id = o.id
        JOIN users u ON u.id = m.user_id`,
    );
    expect(rows).toEqual([{ id: a.orgId }]);
  });

  it('raw UPDATE / DELETE on org B affect zero rows', async () => {
    const result = await asA(async (tx) => [
      await tx.$executeRaw`UPDATE api_keys SET name = 'pwned' WHERE org_id = ${b.orgId}::uuid`,
      await tx.$executeRaw`DELETE FROM api_keys WHERE org_id = ${b.orgId}::uuid`,
      await tx.$executeRaw`UPDATE users SET name = 'pwned' WHERE id = ${b.userId}::uuid`,
    ]);
    expect(result).toEqual([0, 0, 0]);
  });

  it('cannot switch off row security', async () => {
    await expect(
      asA(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL row_security = off');
        return tx.$queryRaw`SELECT * FROM api_keys`;
      }),
    ).rejects.toThrow(/row-level security/i);
  });

  it('a malformed org id fails closed', async () => {
    await expect(
      withDbContext(app, {}, async (tx) => {
        await tx.$executeRawUnsafe("SELECT set_config('app.org_id', 'not-a-uuid', true)");
        return tx.apiKey.findMany();
      }),
    ).rejects.toThrow();
  });
});

describe('context lifetime', () => {
  it('does not leak to the next transaction on the same pooled connection', async () => {
    const single = appClient(1); // pool of one => guaranteed connection reuse
    try {
      const inA = await withTenant(single, { orgId: a.orgId }, (tx) => tx.apiKey.count());
      const after = await withDbContext(single, {}, (tx) => tx.apiKey.count());
      const outside = await single.apiKey.count();
      expect([inA, after, outside]).toEqual([1, 0, 0]);
    } finally {
      await single.$disconnect();
    }
  });

  it('concurrent tenants each see only their own data', async () => {
    const runs = Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? a : b));
    const seen = await Promise.all(
      runs.map((t) =>
        withTenant(app, { orgId: t.orgId }, async (tx) => {
          const keys = await tx.apiKey.findMany({ select: { orgId: true } });
          return keys.every((k) => k.orgId === t.orgId) && keys.length === 1;
        }),
      ),
    );
    expect(seen.every(Boolean)).toBe(true);
  });
});

describe('user-only context (org switcher)', () => {
  it('lists only the user’s own memberships and orgs', async () => {
    const result = await withDbContext(app, { userId: a.userId }, async (tx) => ({
      memberships: await tx.membership.findMany({ select: { orgId: true } }),
      orgs: await tx.organization.findMany({ select: { id: true } }),
      keys: await tx.apiKey.count(),
    }));
    expect(result).toEqual({
      memberships: [{ orgId: a.orgId }],
      orgs: [{ id: a.orgId }],
      keys: 0,
    });
  });

  it('cannot update another user', async () => {
    const n = await withDbContext(app, { userId: a.userId }, (tx) =>
      tx.user.updateMany({ where: { id: b.userId }, data: { name: 'pwned' } }),
    );
    expect(n.count).toBe(0);
  });
});

describe('partners', () => {
  it('org A sees its partner, org B sees none', async () => {
    const seenByA = await asA((tx) => tx.partner.findMany({ select: { id: true } }));
    const seenByB = await withTenant(app, { orgId: b.orgId }, (tx) => tx.partner.count());
    expect(seenByA).toEqual([{ id: a.partnerId }]);
    expect(seenByB).toBe(0);
  });
});

describe('audit_logs are append-only', () => {
  it('rejects UPDATE and DELETE even in the owning org', async () => {
    await expect(
      asA(
        (tx) => tx.$executeRaw`UPDATE audit_logs SET action = 'x' WHERE id = ${a.auditLogId}::uuid`,
      ),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      asA((tx) => tx.$executeRaw`DELETE FROM audit_logs WHERE id = ${a.auditLogId}::uuid`),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe('context validation', () => {
  it('rejects non-UUID ids before touching the database', async () => {
    await expect(withTenant(app, { orgId: "x' OR 1=1 --" }, async () => 1)).rejects.toBeInstanceOf(
      InvalidDbContextError,
    );
  });

  it('withTenant requires an org', async () => {
    await expect(withTenant(app, { orgId: '' }, async () => 1)).rejects.toBeInstanceOf(
      InvalidDbContextError,
    );
  });
});
