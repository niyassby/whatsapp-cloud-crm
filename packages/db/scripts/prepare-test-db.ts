/** Recreate a *_test database with all migrations. Usage: tsx scripts/prepare-test-db.ts <name> */
import path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { prepareTestDatabase, testDbUrls } from '../src/testing';

loadDotenv({ path: path.resolve(__dirname, '../../../.env'), quiet: true });

const name = process.argv[2];
if (!name) throw new Error('Pass a database name ending in _test');

prepareTestDatabase(testDbUrls(name))
  .then(() => console.log(`${name} is ready`))
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
