/**
 * Make an existing account a platform admin, or take that away. Platform admins reach /admin:
 * every partner and workspace, plans, rate cards and system status. The app role cannot write
 * this table, so this script on the owner connection is the only way in.
 *
 *   pnpm admin:grant <email>
 *   pnpm admin:grant <email> --revoke
 */
import path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { createPrismaClient } from '../src/client';

loadDotenv({ path: path.resolve(__dirname, '../../../.env'), quiet: true });

async function main() {
  const [email, flag] = process.argv.slice(2);
  if (!email || (flag && flag !== '--revoke')) {
    throw new Error('Usage: admin-grant <email> [--revoke]');
  }
  const url = process.env.DIRECT_URL;
  if (!url) throw new Error('DIRECT_URL is required');
  const prisma = createPrismaClient({ connectionString: url });
  try {
    // Needs a login that can read every user: the owner as a superuser, as in development.
    const [user] = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id::text AS id FROM users WHERE email = ${email.toLowerCase()}`;
    if (!user) throw new Error(`No account with the email ${email}. They must sign up first.`);
    if (flag === '--revoke') {
      const removed = await prisma.$executeRaw`
        DELETE FROM platform_admins WHERE user_id = ${user.id}::uuid`;
      console.log(removed ? `${email} is no longer a platform admin.` : `${email} was not one.`);
      return;
    }
    await prisma.$executeRaw`
      INSERT INTO platform_admins (user_id) VALUES (${user.id}::uuid) ON CONFLICT DO NOTHING`;
    console.log(`${email} is a platform admin. They will see Admin after reloading the app.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
