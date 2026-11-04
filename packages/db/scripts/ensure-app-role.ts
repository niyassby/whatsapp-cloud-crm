/**
 * Dev/CI: create the DATABASE_URL login role as a member of app_user.
 * Run after migrations: pnpm db:migrate && pnpm db:roles
 */
import path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { ensureAppRole } from '../src/testing/roles';

loadDotenv({ path: path.resolve(__dirname, '../../../.env'), quiet: true });

if (process.env.NODE_ENV === 'production') {
  console.error('ensure-app-role is for dev/CI only. Create the role manually in production.');
  process.exit(1);
}
const { DIRECT_URL, DATABASE_URL } = process.env;
if (!DIRECT_URL || !DATABASE_URL) {
  console.error('DIRECT_URL and DATABASE_URL are required');
  process.exit(1);
}
ensureAppRole(DIRECT_URL, DATABASE_URL)
  .then(() => console.log('app role ready'))
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
