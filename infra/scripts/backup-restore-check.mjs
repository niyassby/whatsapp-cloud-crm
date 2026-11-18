#!/usr/bin/env node
/**
 * Backup and restore drill (Phase 4.4, infra/backup-restore.md). Dumps the database in
 * DIRECT_URL with pg_dump, restores it into a scratch database on the same server, and checks the
 * copy matches: row counts of every table (message partitions included), the migration history,
 * row level security on every table, the policies, and the definer functions with their owners.
 * Then it confirms the app role still sees nothing without a workspace in the restored copy.
 *
 *   node infra/scripts/backup-restore-check.mjs            # drops the scratch copy afterwards
 *   node infra/scripts/backup-restore-check.mjs --keep
 *   PG_BIN="C:/Program Files/PostgreSQL/18/bin" node infra/scripts/backup-restore-check.mjs
 *
 * Exits 1 on any difference. Never writes to the source database.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const require = createRequire(path.join(root, 'packages/db/package.json'));
const { Client } = require('pg');
require('dotenv').config({ path: path.join(root, '.env'), quiet: true });

const source = process.env.DIRECT_URL;
const appUrl = process.env.DATABASE_URL;
if (!source || !appUrl) throw new Error('DIRECT_URL and DATABASE_URL are required');
const SCRATCH = 'wacrm_restore_check';
const sourceUrl = new URL(source);
if (sourceUrl.pathname.slice(1) === SCRATCH) throw new Error('The source is the scratch database');
const withDb = (url, db) => {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
};
const bin = (name) => (process.env.PG_BIN ? path.join(process.env.PG_BIN, name) : name);
const started = Date.now();

// 1. Dump, in the custom format production backups use.
const dir = mkdtempSync(path.join(tmpdir(), 'wacrm-backup-'));
const file = path.join(dir, 'backup.dump');
execFileSync(bin('pg_dump'), ['--format=custom', `--file=${file}`, source], { stdio: 'inherit' });
console.log(
  `Dumped ${(statSync(file).size / 1_048_576).toFixed(1)} MB in ${Date.now() - started} ms`,
);

// 2. Restore into a fresh scratch database on the same server (roles are server-wide).
const admin = new Client({ connectionString: withDb(source, 'postgres') });
await admin.connect();
await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`);
await admin.query(`CREATE DATABASE ${SCRATCH}`);
const restoreStart = Date.now();
execFileSync(bin('pg_restore'), ['--exit-on-error', `--dbname=${withDb(source, SCRATCH)}`, file], {
  stdio: 'inherit',
});
console.log(`Restored in ${Date.now() - restoreStart} ms`);

// 3. Compare.
const a = new Client({ connectionString: source });
const b = new Client({ connectionString: withDb(source, SCRATCH) });
await a.connect();
await b.connect();
const problems = [];
const tablesSql = `
  SELECT n.nspname || '.' || c.relname AS name FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN ('public', 'message_partitions') AND c.relkind = 'r' ORDER BY 1`;
const tables = (await a.query(tablesSql)).rows.map((r) => r.name);
let rows = 0;
for (const t of tables) {
  const q = `SELECT count(*)::bigint AS n FROM ${t
    .split('.')
    .map((p) => `"${p}"`)
    .join('.')}`;
  const [x, y] = await Promise.all([a.query(q), b.query(q)]);
  rows += Number(x.rows[0].n);
  if (x.rows[0].n !== y.rows[0].n)
    problems.push(`${t}: ${x.rows[0].n} rows, restored ${y.rows[0].n}`);
}
const same = async (label, sql) => {
  const [x, y] = await Promise.all([a.query(sql), b.query(sql)]);
  if (JSON.stringify(x.rows) !== JSON.stringify(y.rows)) problems.push(`${label} differ`);
};
await same('migrations', `SELECT migration_name, checksum FROM _prisma_migrations ORDER BY 1`);
await same(
  'row level security flags',
  `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class c
   JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
   ORDER BY 1`,
);
await same(
  'policies',
  `SELECT tablename, policyname, roles::text, cmd, qual, with_check FROM pg_policies
   WHERE schemaname = 'public' ORDER BY 1, 2`,
);
await same(
  'definer functions',
  `SELECT p.proname, r.rolname, p.prosecdef, p.proconfig::text FROM pg_proc p
   JOIN pg_roles r ON r.oid = p.proowner JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prosecdef ORDER BY 1`,
);

// 4. The restored copy still keeps tenants apart for the app role.
const app = new Client({ connectionString: withDb(appUrl, SCRATCH) });
await app.connect();
const seen = await app.query('SELECT count(*)::int AS n FROM contacts');
if (seen.rows[0].n !== 0)
  problems.push(`the app role sees ${seen.rows[0].n} contacts with no context`);
await app.end();

await a.end();
await b.end();
if (!process.argv.includes('--keep')) await admin.query(`DROP DATABASE ${SCRATCH} WITH (FORCE)`);
await admin.end();
rmSync(dir, { recursive: true, force: true });

console.log(
  `Checked ${tables.length} tables, ${rows.toLocaleString('en-US')} rows, migrations, RLS, policies and definer functions in ${Date.now() - started} ms.`,
);
if (problems.length) {
  for (const p of problems) console.error(`  ${p}`);
  console.error('FAIL: the restored copy differs.');
  process.exit(1);
}
console.log('PASS: the restored copy matches.');
