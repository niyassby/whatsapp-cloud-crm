/**
 * Phase 4.4: a sweep over every tenant table, so a table added later is covered without anyone
 * remembering to add it to a test.
 *
 * 1. Every policy the app role has on a table with org_id is the plain org match, or one of the
 *    reviewed exceptions below, word for word. A new kind of policy fails here until reviewed.
 * 2. With no context, with a workspace that has no data, and with an unrelated partner context,
 *    every tenant table shows nothing; with a workspace's own context, nothing from another.
 *    Run over whatever rows the other suites have written (they share this database).
 */
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TEST_DATABASE_URL, TEST_DIRECT_URL } from './urls';

const PLAIN = '(org_id = app_current_org_id())';

/**
 * Reviewed policies that are not the plain org match, as "USING <qual> CHECK <with_check>".
 * Compared word for word: changing one of these, or adding another, fails until reviewed here.
 */
const ORG = 'org_id = app_current_org_id()';
const USER = 'user_id = app_current_user_id()';
const PARTNER = 'partner_id = app_current_partner_id()';
const REVIEWED: Record<string, string> = {
  // A notification belongs to one person in one workspace; anyone in the workspace may create one.
  'notifications.notifications_own': `USING ((${ORG}) AND (${USER})) CHECK null`,
  'notifications.notifications_own_update': `USING ((${ORG}) AND (${USER})) CHECK ((${ORG}) AND (${USER}))`,
  // Sessions belong to a person, across workspaces.
  'refresh_tokens.refresh_tokens_own': `USING (${USER}) CHECK (${USER})`,
  // A person sees their own memberships, to switch workspace.
  'memberships.memberships_select': `USING ((${ORG}) OR (${USER})) CHECK null`,
  // A partner (or platform admin) reads its clients' wallets and subscriptions, never writes.
  'subscriptions.subscriptions_partner_select':
    'USING (app_is_platform_admin() OR (EXISTS (SELECT 1 FROM organizations o WHERE ((o.id = subscriptions.org_id) AND (o.partner_id = app_current_partner_id()))))) CHECK null',
  'wallets.wallets_partner_select':
    'USING (app_is_platform_admin() OR (EXISTS (SELECT 1 FROM organizations o WHERE ((o.id = wallets.org_id) AND (o.partner_id = app_current_partner_id()))))) CHECK null',
  // Impersonation sessions: the impersonator, the workspace, its partner or an admin read them;
  // only the impersonator opens one (in the workspace's context) or closes it.
  'impersonation_sessions.impersonation_sessions_insert': `USING null CHECK ((${USER}) AND (${ORG}))`,
  'impersonation_sessions.impersonation_sessions_select': `USING ((${USER}) OR (${ORG}) OR (${PARTNER}) OR app_is_platform_admin()) CHECK null`,
  'impersonation_sessions.impersonation_sessions_update': `USING (${USER}) CHECK (${USER})`,
  // A partner manages its own clients' caps and prices; the client reads its row.
  'partner_clients.partner_clients_insert': `USING null CHECK ((${PARTNER}) OR app_is_platform_admin())`,
  'partner_clients.partner_clients_select': `USING ((${ORG}) OR (${PARTNER}) OR app_is_platform_admin()) CHECK null`,
  'partner_clients.partner_clients_update': `USING ((${PARTNER}) OR app_is_platform_admin()) CHECK ((${PARTNER}) OR app_is_platform_admin())`,
  // The partner's ledger: a client writes the commission row for its own charge (its own org and
  // its own partner) but cannot read it.
  'partner_ledger.partner_ledger_insert': `USING null CHECK ((${PARTNER}) OR app_is_platform_admin() OR ((${ORG}) AND (partner_id = (SELECT o.partner_id FROM organizations o WHERE (o.id = app_current_org_id())))))`,
  'partner_ledger.partner_ledger_select': `USING ((${PARTNER}) OR app_is_platform_admin()) CHECK null`,
};

/** Tables a partner context may legitimately read for its own clients (see REVIEWED). */
const PARTNER_READABLE = new Set(['subscriptions', 'wallets']);

const squash = (sql: string | null) => (sql ?? 'null').replace(/\s+/g, ' ').replace(/\( /g, '(');

let owner: Client;
let app: Client;
let tables: string[] = [];

beforeAll(async () => {
  owner = new Client({ connectionString: TEST_DIRECT_URL });
  app = new Client({ connectionString: TEST_DATABASE_URL });
  await owner.connect();
  await app.connect();
  const { rows } = await owner.query<{ table_name: string }>(`
    SELECT c.table_name FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = 'public' AND c.column_name = 'org_id' AND t.table_type = 'BASE TABLE'
    ORDER BY 1`);
  tables = rows.map((r) => r.table_name);
});

afterAll(async () => {
  await app.end();
  await owner.end();
});

/** Run `fn` as the app role inside a transaction with the given context. */
async function as<T>(ctx: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  await app.query('BEGIN');
  try {
    for (const [k, v] of Object.entries(ctx)) {
      await app.query(`SELECT set_config($1, $2, true)`, [k, v]);
    }
    return await fn();
  } finally {
    await app.query('ROLLBACK');
  }
}

const count = async (sql: string, params: unknown[] = []) =>
  Number((await app.query<{ n: string }>(sql, params)).rows[0]!.n);

describe('policies', () => {
  // Policies written TO public apply to the app role as well.
  const appPolicies = () =>
    owner.query<{
      tablename: string;
      policyname: string;
      qual: string | null;
      with_check: string | null;
    }>(
      `
      SELECT p.tablename, p.policyname, p.qual, p.with_check FROM pg_policies p
      WHERE p.schemaname = 'public' AND p.roles && ARRAY['app_user', 'public']::name[]
        AND p.tablename = ANY($1)`,
      [tables],
    );

  it('every app policy on a tenant table is the org match or a reviewed exception', async () => {
    const { rows } = await appPolicies();
    expect(rows.length).toBeGreaterThan(50);
    const unexpected: string[] = [];
    const seen = new Set<string>();
    for (const r of rows) {
      const name = `${r.tablename}.${r.policyname}`;
      const qual = squash(r.qual);
      const check = squash(r.with_check);
      const plain =
        (qual === PLAIN || qual === 'null') &&
        (check === 'null' || check === PLAIN) &&
        !(qual === 'null' && check === 'null');
      if (plain) continue;
      const signature = `USING ${qual} CHECK ${check}`;
      seen.add(name);
      if (REVIEWED[name] !== undefined && squash(REVIEWED[name]) === signature) continue;
      unexpected.push(`${name}: ${signature}`);
    }
    expect(unexpected).toEqual([]);
    // A reviewed entry for a policy that no longer exists is stale.
    expect(Object.keys(REVIEWED).filter((k) => !seen.has(k))).toEqual([]);
  });

  it('every tenant table has at least one policy for the app role', async () => {
    const { rows } = await appPolicies();
    const covered = new Set(rows.map((r) => r.tablename));
    expect(tables.filter((t) => !covered.has(t))).toEqual([]);
  });
});

describe('data sweep', () => {
  it('no context, an empty workspace, and an unrelated partner see nothing', async () => {
    const leaks: string[] = [];
    for (const t of tables) {
      const sql = `SELECT count(*) AS n FROM "${t}"`;
      if ((await as({}, () => count(sql))) > 0) leaks.push(`${t} (no context)`);
      if ((await as({ 'app.org_id': randomUUID() }, () => count(sql))) > 0) {
        leaks.push(`${t} (empty workspace)`);
      }
      if (
        !PARTNER_READABLE.has(t) &&
        (await as({ 'app.partner_id': randomUUID() }, () => count(sql))) > 0
      ) {
        leaks.push(`${t} (unrelated partner)`);
      }
    }
    expect(leaks).toEqual([]);
  });

  it('each workspace with data sees only its own rows', async () => {
    const leaks: string[] = [];
    let checked = 0;
    for (const t of tables) {
      const { rows } = await owner.query<{ org_id: string }>(
        `SELECT DISTINCT org_id FROM "${t}" LIMIT 3`,
      );
      for (const { org_id } of rows) {
        checked++;
        const foreign = await as({ 'app.org_id': org_id }, () =>
          count(`SELECT count(*) AS n FROM "${t}" WHERE org_id <> $1`, [org_id]),
        );
        if (foreign > 0) leaks.push(`${t}: ${foreign} rows of other workspaces`);
      }
    }
    expect(leaks).toEqual([]);
    // Informational: how much data the sweep actually walked over.
    expect(checked).toBeGreaterThanOrEqual(0);
  });

  it('the app role cannot read message partitions directly', async () => {
    const { rows } = await owner.query<{ name: string }>(`
      SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'message_partitions' AND c.relkind = 'r'`);
    for (const { name } of rows) {
      await expect(
        as({}, () => count(`SELECT count(*) AS n FROM message_partitions."${name}"`)),
      ).rejects.toThrow(/permission denied/);
    }
  });
});
