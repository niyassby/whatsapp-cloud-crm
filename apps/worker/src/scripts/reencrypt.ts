/**
 * Key rotation, step 2. First set the new key in ENCRYPTION_KEY and the old one in
 * ENCRYPTION_KEY_PREVIOUS and restart the API and worker. Then run:
 *   pnpm secrets:reencrypt
 * When it reports 0 rows on a second run, the old key can be dropped.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createPrismaClient } from '@wacrm/db';
import { SecretBox } from '@wacrm/shared/server';
import { reencryptSecrets } from '../processors/maintenance';

const rootEnv = path.resolve(__dirname, '../../../../.env');
if (process.env.NODE_ENV !== 'production' && existsSync(rootEnv)) process.loadEnvFile(rootEnv);

async function main() {
  const { DATABASE_URL, ENCRYPTION_KEY, ENCRYPTION_KEY_PREVIOUS } = process.env;
  if (!DATABASE_URL || !ENCRYPTION_KEY)
    throw new Error('DATABASE_URL and ENCRYPTION_KEY are required');
  const previous = (ENCRYPTION_KEY_PREVIOUS ?? '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);
  const db = createPrismaClient({ connectionString: DATABASE_URL });
  try {
    const res = await reencryptSecrets(db, new SecretBox(ENCRYPTION_KEY, previous));
    console.log(`Re-encrypted ${res.phoneNumbers} phone number(s) and ${res.users} user(s).`);
    if (res.failed.length > 0) {
      console.error(`Could not re-encrypt: ${res.failed.join(', ')}. Keep the old key.`);
      process.exitCode = 1;
    }
  } finally {
    await db.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
