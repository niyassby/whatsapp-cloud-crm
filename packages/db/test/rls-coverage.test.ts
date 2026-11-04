/**
 * Guards against new tables shipping without RLS. Any table with an org_id column, plus the
 * known global tables, must have RLS enabled AND forced, and the app role must be unable to
 * bypass it.
 */
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TEST_DATABASE_URL, TEST_DIRECT_URL } from './urls';

const GLOBAL_RLS_TABLES = ['organizations', 'users', 'partners', 'refresh_tokens', 'auth_tokens'];
// Tables intentionally without RLS. Keep this list tiny and justified.
const EXEMPT = new Set(['_prisma_migrations']);

let client: Client;

beforeAll(async () => {
  client = new Client({ connectionString: TEST_DIRECT_URL });
  await client.connect();
});
afterAll(() => client.end());

describe('RLS coverage', () => {
  it('every tenant table has RLS enabled and forced', async () => {
    const { rows } = await client.query<{ table: string; rls: boolean; forced: boolean }>(
      `
      SELECT c.relname AS table, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
        AND (
          EXISTS (SELECT 1 FROM information_schema.columns col
                  WHERE col.table_schema = 'public' AND col.table_name = c.relname
                    AND col.column_name = 'org_id')
          OR c.relname = ANY($1)
        )`,
      [GLOBAL_RLS_TABLES],
    );
    const tables = rows.filter((r) => !EXEMPT.has(r.table));
    expect(tables.length).toBeGreaterThanOrEqual(9);
    const unprotected = tables.filter((r) => !r.rls || !r.forced).map((r) => r.table);
    expect(unprotected).toEqual([]);
  });

  it('every RLS table has at least one policy', async () => {
    const { rows } = await client.query<{ table: string }>(`
      SELECT c.relname AS table FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relrowsecurity
        AND NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname)`);
    expect(rows).toEqual([]);
  });

  it('the app role cannot bypass RLS', async () => {
    const appRole = decodeURIComponent(new URL(TEST_DATABASE_URL).username);
    const { rows } = await client.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1',
      [appRole],
    );
    expect(rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);

    const owned = await client.query(
      `SELECT c.relname FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND r.rolname = $1`,
      [appRole],
    );
    expect(owned.rows).toEqual([]);
  });
});
