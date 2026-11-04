import { Client } from 'pg';

/**
 * Dev/CI helper: make sure the login role used in `appUrl` exists, cannot bypass RLS and is
 * a member of the NOLOGIN group role "app_user" (created by the RLS migration).
 *
 * Production / managed Postgres: create the login role yourself, e.g.
 *   CREATE ROLE wacrm_app LOGIN PASSWORD '...' NOSUPERUSER NOBYPASSRLS IN ROLE app_user;
 */
export async function ensureAppRole(directUrl: string, appUrl: string): Promise<void> {
  const app = new URL(appUrl);
  const username = decodeURIComponent(app.username);
  const password = decodeURIComponent(app.password);
  if (!username || !password) throw new Error('DATABASE_URL must include a username and password');
  if (username === decodeURIComponent(new URL(directUrl).username)) {
    throw new Error(
      'DATABASE_URL must use a different role than DIRECT_URL, otherwise RLS can be bypassed',
    );
  }

  const client = new Client({ connectionString: directUrl });
  await client.connect();
  try {
    const role = client.escapeIdentifier(username);
    const pass = client.escapeLiteral(password);
    const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [username]);
    const verb = exists.rowCount === 0 ? 'CREATE' : 'ALTER';
    await client.query(
      `${verb} ROLE ${role} LOGIN PASSWORD ${pass} NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
    await client.query(`GRANT app_user TO ${role}`);
  } finally {
    await client.end();
  }
}
