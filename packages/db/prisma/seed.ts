/**
 * Seeds a demo organization with an owner and an agent. Idempotent.
 *
 * Dev-only test credentials (also used by e2e tests later):
 *   owner: owner@demo.test / demo-password-123
 *   agent: agent@demo.test / demo-password-123
 *
 * Runs through withTenant so it works under FORCE ROW LEVEL SECURITY on hosts where the
 * owner is not a superuser.
 */
import path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { hash } from '@node-rs/argon2';
import { createPrismaClient } from '../src/client';
import { withDbContext, withTenant } from '../src/tenant';

loadDotenv({ path: path.resolve(__dirname, '../../../.env'), quiet: true });

// Fixed ids keep the seed idempotent and easy to reference in tests.
export const DEMO_ORG_ID = '01900000-0000-7000-8000-000000000001';
export const DEMO_OWNER_ID = '01900000-0000-7000-8000-000000000101';
export const DEMO_AGENT_ID = '01900000-0000-7000-8000-000000000102';
const DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD ?? 'demo-password-123';

async function main() {
  const url = process.env.DIRECT_URL;
  if (!url) throw new Error('DIRECT_URL is required to seed');
  const prisma = createPrismaClient({ connectionString: url });
  // argon2id is the default algorithm in @node-rs/argon2.
  const passwordHash = await hash(DEMO_PASSWORD);

  try {
    for (const [id, email, name] of [
      [DEMO_OWNER_ID, 'owner@demo.test', 'Demo Owner'],
      [DEMO_AGENT_ID, 'agent@demo.test', 'Demo Agent'],
    ] as const) {
      await withDbContext(prisma, { userId: id }, (tx) =>
        tx.user.upsert({
          where: { id },
          update: {},
          create: { id, email, name, passwordHash, emailVerifiedAt: new Date() },
        }),
      );
    }

    await withTenant(prisma, { orgId: DEMO_ORG_ID, userId: DEMO_OWNER_ID }, async (tx) => {
      await tx.organization.upsert({
        where: { id: DEMO_ORG_ID },
        update: {},
        create: { id: DEMO_ORG_ID, name: 'Demo Org', slug: 'demo' },
      });
      for (const [userId, role] of [
        [DEMO_OWNER_ID, 'owner'],
        [DEMO_AGENT_ID, 'agent'],
      ] as const) {
        await tx.membership.upsert({
          where: { orgId_userId: { orgId: DEMO_ORG_ID, userId } },
          update: {},
          create: { orgId: DEMO_ORG_ID, userId, role },
        });
      }
      await tx.auditLog.create({
        data: { orgId: DEMO_ORG_ID, actorUserId: DEMO_OWNER_ID, action: 'seed.run' },
      });
    });
    console.log('Seeded demo org (slug: demo) with owner and agent.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
