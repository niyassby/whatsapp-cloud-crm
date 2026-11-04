/**
 * Isolation for auth tables (sessions, one-time tokens, invitations) and the SECURITY DEFINER
 * pre-auth lookup functions.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DbClient } from '../src/client';
import { withDbContext, withTenant } from '../src/tenant';
import { appClient, createTenant, ownerClient, type TenantFixture } from './fixtures';

let owner: DbClient;
let app: DbClient;
let a: TenantFixture;
let b: TenantFixture;
const hashA = `rt-a-${randomUUID()}`;
const hashB = `rt-b-${randomUUID()}`;
const inviteHashB = `inv-b-${randomUUID()}`;
const resetHashB = `reset-b-${randomUUID()}`;

beforeAll(async () => {
  owner = ownerClient();
  app = appClient();
  a = await createTenant(owner);
  b = await createTenant(owner);
  const expiresAt = new Date(Date.now() + 3600_000);

  for (const [t, hash] of [
    [a, hashA],
    [b, hashB],
  ] as const) {
    await withDbContext(owner, { userId: t.userId }, (tx) =>
      tx.refreshToken.create({
        data: {
          userId: t.userId,
          familyId: randomUUID(),
          tokenHash: hash,
          orgId: t.orgId,
          expiresAt,
        },
      }),
    );
  }
  await withDbContext(owner, { userId: b.userId }, (tx) =>
    tx.authToken.create({
      data: { userId: b.userId, type: 'password_reset', tokenHash: resetHashB, expiresAt },
    }),
  );
  await withTenant(owner, { orgId: b.orgId, userId: b.userId }, (tx) =>
    tx.invitation.create({
      data: {
        orgId: b.orgId,
        email: 'new@iso.test',
        role: 'agent',
        tokenHash: inviteHashB,
        expiresAt,
      },
    }),
  );
});

afterAll(async () => {
  await app.$disconnect();
  await owner.$disconnect();
});

describe('auth tables under RLS', () => {
  it('a user only sees their own sessions and tokens', async () => {
    const seen = await withDbContext(app, { userId: a.userId }, async (tx) => ({
      sessions: await tx.refreshToken.findMany({ select: { tokenHash: true } }),
      tokens: await tx.authToken.count(),
    }));
    expect(seen).toEqual({ sessions: [{ tokenHash: hashA }], tokens: 0 });
  });

  it('org context alone does not expose sessions', async () => {
    const n = await withTenant(app, { orgId: b.orgId }, (tx) => tx.refreshToken.count());
    expect(n).toBe(0);
  });

  it("cannot revoke another user's session", async () => {
    const n = await withDbContext(app, { userId: a.userId }, (tx) =>
      tx.refreshToken.updateMany({ where: { tokenHash: hashB }, data: { revokedAt: new Date() } }),
    );
    expect(n.count).toBe(0);
  });

  it('invitations are per org', async () => {
    const inA = await withTenant(app, { orgId: a.orgId, userId: a.userId }, (tx) =>
      tx.invitation.count(),
    );
    const inB = await withTenant(app, { orgId: b.orgId, userId: b.userId }, (tx) =>
      tx.invitation.count(),
    );
    expect([inA, inB]).toEqual([0, 1]);
  });

  it('app role cannot delete sessions, tokens or invitations', async () => {
    await expect(
      withDbContext(app, { userId: a.userId }, (tx) => tx.$executeRaw`DELETE FROM refresh_tokens`),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe('pre-auth lookup functions', () => {
  it('look up a user by email (case-insensitive) without context', async () => {
    const email = (
      await withDbContext(owner, { userId: a.userId }, (tx) =>
        tx.user.findUniqueOrThrow({ where: { id: a.userId }, select: { email: true } }),
      )
    ).email;
    const rows = await withDbContext(
      app,
      {},
      (tx) =>
        tx.$queryRaw<
          Record<string, unknown>[]
        >`SELECT * FROM auth_lookup_user_by_email(${email.toUpperCase()})`,
    );
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]!).sort()).toEqual(['id', 'password_hash', 'status', 'totp_enabled']);
    expect(rows[0]!.id).toBe(a.userId);
  });

  it('look up a refresh token only by its exact hash', async () => {
    const hit = await app.$queryRaw<{ user_id: string }[]>`
      SELECT user_id FROM auth_lookup_refresh_token(${hashB})`;
    const miss = await app.$queryRaw<unknown[]>`SELECT * FROM auth_lookup_refresh_token('nope')`;
    expect(hit).toEqual([{ user_id: b.userId }]);
    expect(miss).toEqual([]);
  });

  it('look up auth tokens by hash and type', async () => {
    const right = await app.$queryRaw<unknown[]>`
      SELECT * FROM auth_lookup_auth_token(${resetHashB}, 'password_reset'::"AuthTokenType")`;
    const wrongType = await app.$queryRaw<unknown[]>`
      SELECT * FROM auth_lookup_auth_token(${resetHashB}, 'email_verification'::"AuthTokenType")`;
    expect(right).toHaveLength(1);
    expect(wrongType).toEqual([]);
  });

  it('look up an invitation with its org name', async () => {
    const rows = await app.$queryRaw<{ org_id: string; account_exists: boolean }[]>`
      SELECT org_id, account_exists FROM auth_lookup_invitation(${inviteHashB})`;
    expect(rows).toEqual([{ org_id: b.orgId, account_exists: false }]);
  });

  it('app role cannot assume app_definer or read its tables directly', async () => {
    await expect(app.$executeRawUnsafe('SET ROLE app_definer')).rejects.toThrow(
      /permission denied/i,
    );
    const n = await withDbContext(app, {}, (tx) => tx.user.count());
    expect(n).toBe(0);
  });

  it('functions are owned by app_definer and pin search_path', async () => {
    const rows = await owner.$queryRaw<
      { proname: string; owner: string; secdef: boolean; config: string[] | null }[]
    >`
      SELECT p.proname, r.rolname AS owner, p.prosecdef AS secdef, p.proconfig AS config
      FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
      WHERE p.proname LIKE 'auth_lookup_%' ORDER BY p.proname`;
    expect(rows.map((r) => r.proname)).toEqual([
      'auth_lookup_auth_token',
      'auth_lookup_invitation',
      'auth_lookup_refresh_token',
      'auth_lookup_user_by_email',
    ]);
    for (const r of rows) {
      expect(r.owner).toBe('app_definer');
      expect(r.secdef).toBe(true);
      expect(r.config).toEqual(['search_path=public, pg_temp']);
    }
  });
});
