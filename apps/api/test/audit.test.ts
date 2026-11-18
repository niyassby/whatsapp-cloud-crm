/**
 * Phase 4.4: the audit log viewer's filters and export, in a workspace and in the platform
 * console, and that agents cannot read either.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, Client, type TestApp, tokenFromMail, uniqueEmail } from './helpers';

let t: TestApp;
let owner: Client;
let ownerId: string;

beforeAll(async () => {
  t = await buildApp();
  owner = new Client(t.app);
  ownerId = (await owner.signup()).userId;
  await owner.patch('/orgs/current', { name: 'Renamed Co' });
  await owner.post('/team/invitations', { email: uniqueEmail('a'), role: 'agent' });
  await owner.post('/team/invitations', { email: uniqueEmail('b'), role: 'admin' });
});
afterAll(async () => {
  await t?.close();
});

type Item = { action: string; actorUserId: string | null };
const actions = (body: { items: Item[] }) => body.items.map((i) => i.action);

describe('workspace audit log', () => {
  it('filters by group, by exact action, and by person', async () => {
    const team = await owner.get('/orgs/current/audit-logs?action=team');
    expect(actions(team.body)).toEqual(['team.invite_created', 'team.invite_created']);
    const exact = await owner.get('/orgs/current/audit-logs?action=org.updated');
    expect(actions(exact.body)).toEqual(['org.updated']);
    const mine = await owner.get(`/orgs/current/audit-logs?actorUserId=${ownerId}`);
    expect(mine.body.items.every((i: Item) => i.actorUserId === ownerId)).toBe(true);
    expect(mine.body.items.length).toBeGreaterThanOrEqual(3);
  });

  it('filters by UTC days, both included', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const inRange = await owner.get(`/orgs/current/audit-logs?from=${today}&to=${today}`);
    expect(inRange.body.items.length).toBeGreaterThanOrEqual(3);
    const before = await owner.get('/orgs/current/audit-logs?to=2020-01-01');
    expect(before.body.items).toEqual([]);
  });

  it('refuses a filter that is not an action name', async () => {
    const bad = await owner.get(
      `/orgs/current/audit-logs?action=${encodeURIComponent("x' OR 1=1")}`,
    );
    expect(bad.status).toBe(400);
  });

  it('exports the filtered log as CSV, and records the export', async () => {
    const res = await owner.get('/orgs/current/audit-logs/export?action=team');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    const lines = String(res.body).replace(String.fromCharCode(0xfeff), '').split('\r\n');
    expect(lines[0]).toBe('When (UTC),Who,Outside access,Action,What,Details,Target,IP');
    expect(lines.slice(1).every((l) => l.includes('team.invite_created'))).toBe(true);
    const after = await owner.get('/orgs/current/audit-logs?action=audit');
    expect(actions(after.body)).toEqual(['audit.exported']);
  });

  it('is closed to agents', async () => {
    const email = uniqueEmail('agent');
    await owner.post('/team/invitations', { email, role: 'agent' });
    const agent = new Client(t.app);
    await agent.post('/invitations/accept', {
      token: tokenFromMail(t.mailer, email),
      name: 'Agent',
      password: 'correct-horse-battery',
    });
    expect((await agent.get('/orgs/current/audit-logs')).status).toBe(403);
    expect((await agent.get('/orgs/current/audit-logs/export')).status).toBe(403);
  });
});
