/**
 * Test-only helpers (import from "@wacrm/db/testing"). Never import from runtime code.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { Client } from 'pg';
import { ensureAppRole } from './roles';

export { ensureAppRole } from './roles';

const DEFAULT_DIRECT = 'postgresql://wacrm:wacrm@localhost:5433/wacrm_test';
const DEFAULT_APP = 'postgresql://wacrm_app:wacrm_app@localhost:5433/wacrm_test';

export interface TestDbUrls {
  /** Owner connection: migrations and fixtures only. */
  directUrl: string;
  /** App-role connection: subject to RLS. Use this for assertions. */
  appUrl: string;
}

/**
 * URLs for a per-package test database. The host/credentials come from TEST_DIRECT_URL and
 * TEST_DATABASE_URL; the database name is replaced with `dbName` so packages can run their
 * suites in parallel without sharing a database.
 */
export function testDbUrls(dbName: string): TestDbUrls {
  if (!dbName.endsWith('_test')) throw new Error('Test database names must end in _test');
  const withDb = (raw: string) => {
    const url = new URL(raw);
    url.pathname = `/${dbName}`;
    return url.toString();
  };
  return {
    directUrl: withDb(process.env.TEST_DIRECT_URL ?? DEFAULT_DIRECT),
    appUrl: withDb(process.env.TEST_DATABASE_URL ?? DEFAULT_APP),
  };
}

/**
 * Drops and recreates the database, applies every migration with `prisma migrate deploy`
 * and ensures the app role exists. Doubles as the "migrations apply cleanly on a fresh
 * Postgres" check.
 */
export async function prepareTestDatabase({ directUrl, appUrl }: TestDbUrls): Promise<void> {
  const dbName = decodeURIComponent(new URL(directUrl).pathname.slice(1));
  if (!dbName.endsWith('_test')) {
    throw new Error(`Refusing to recreate "${dbName}": test database names must end in _test`);
  }

  const admin = new URL(directUrl);
  admin.pathname = '/postgres';
  const client = new Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const ident = client.escapeIdentifier(dbName);
    await client.query(`DROP DATABASE IF EXISTS ${ident} WITH (FORCE)`);
    await client.query(`CREATE DATABASE ${ident}`);
  } finally {
    await client.end();
  }

  // dist/testing or src/testing -> package root
  const pkgRoot = path.resolve(__dirname, '..', '..');
  const prismaCli = require.resolve('prisma/build/index.js', { paths: [pkgRoot] });
  try {
    execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
      cwd: pkgRoot,
      env: { ...process.env, DIRECT_URL: directUrl },
      stdio: 'pipe',
    });
  } catch (err) {
    const out = err as { stdout?: Buffer; stderr?: Buffer };
    throw new Error(
      `prisma migrate deploy failed:\n${out.stdout?.toString() ?? ''}${out.stderr?.toString() ?? ''}`,
      { cause: err },
    );
  }

  await ensureAppRole(directUrl, appUrl);
}
