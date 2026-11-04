import { randomUUID } from 'node:crypto';
import { createPrismaClient, type DbClient } from '../src/client';
import { withDbContext, withTenant } from '../src/tenant';
import { TEST_DATABASE_URL, TEST_DIRECT_URL } from './urls';

/** Owner connection: used only to build fixtures, never to assert isolation. */
export const ownerClient = (): DbClient =>
  createPrismaClient({ connectionString: TEST_DIRECT_URL });
/** App-role connection: what the API and workers use. All assertions go through this. */
export const appClient = (max?: number): DbClient =>
  createPrismaClient({ connectionString: TEST_DATABASE_URL, max });

export interface TenantFixture {
  orgId: string;
  userId: string;
  apiKeyId: string;
  auditLogId: string;
  partnerId: string | null;
}

/** Creates an org with one owner user, one API key and one audit log entry. */
export async function createTenant(
  owner: DbClient,
  opts: { partnerId?: string | null } = {},
): Promise<TenantFixture> {
  const orgId = randomUUID();
  const userId = randomUUID();
  const tag = orgId.slice(0, 8);

  await withDbContext(owner, { userId }, (tx) =>
    tx.user.create({
      data: { id: userId, email: `user-${tag}@iso.test`, name: `User ${tag}`, passwordHash: 'x' },
    }),
  );

  return withTenant(owner, { orgId, userId }, async (tx) => {
    await tx.organization.create({
      data: {
        id: orgId,
        name: `Org ${tag}`,
        slug: `org-${tag}`,
        partnerId: opts.partnerId ?? null,
      },
    });
    await tx.membership.create({ data: { orgId, userId, role: 'owner' } });
    const key = await tx.apiKey.create({
      data: {
        orgId,
        name: 'key',
        prefix: `pk_${tag}`,
        keyHash: `hash-${tag}`,
        createdById: userId,
      },
    });
    const log = await tx.auditLog.create({
      data: { orgId, actorUserId: userId, action: 'fixture.create' },
    });
    return {
      orgId,
      userId,
      apiKeyId: key.id,
      auditLogId: log.id,
      partnerId: opts.partnerId ?? null,
    };
  });
}

export async function createPartner(owner: DbClient): Promise<string> {
  const id = randomUUID();
  // partners has no INSERT policy for the app; the owner here is a superuser in dev/CI.
  await owner.partner.create({ data: { id, name: `Partner ${id.slice(0, 8)}`, slug: `p-${id}` } });
  return id;
}
