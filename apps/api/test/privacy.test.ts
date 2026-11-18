/**
 * Phase 4.4 over HTTP: contact export and erasure requests (with their confirmation), the
 * owner-only workspace export, retention and deletion with its grace period, and that an erased
 * number cannot be added back by hand.
 */
import { randomBytes } from 'node:crypto';
import { createPrismaClient, type DbClient, withTenant } from '@wacrm/db';
import { identityHash } from '@wacrm/shared/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, Client, type TestApp, tokenFromMail, uniqueEmail, urls } from './helpers';

const ENCRYPTION_KEY = randomBytes(32).toString('base64');
let t: TestApp;
let owner: DbClient;
let ws: Client;
let orgId: string;
let contactId: string;

beforeAll(async () => {
  t = await buildApp({ env: { ENCRYPTION_KEY } });
  owner = createPrismaClient({ connectionString: urls.directUrl });
  ws = new Client(t.app);
  orgId = (await ws.signup({ orgName: 'Spice Co' })).orgId;
  const created = await ws.post('/contacts', { phone: '+919811100001', name: 'Meena' });
  expect(created.status).toBe(201);
  contactId = created.body.id;
});
afterAll(async () => {
  await t?.close();
  await owner?.$disconnect();
});

async function member(role: 'agent' | 'admin') {
  const email = uniqueEmail(role);
  await ws.post('/team/invitations', { email, role });
  const c = new Client(t.app);
  await c.post('/invitations/accept', {
    token: tokenFromMail(t.mailer, email),
    name: role,
    password: 'correct-horse-battery',
  });
  return c;
}

describe('a contact’s data', () => {
  it('queues an export and lists it, and records it in the audit log', async () => {
    const res = await ws.post(`/privacy/contacts/${contactId}/export`);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ kind: 'contact_export', status: 'pending', contactId });
    const list = await ws.get(`/privacy/contacts/${contactId}/requests`);
    expect(list.body.map((r: { id: string }) => r.id)).toContain(res.body.id);
    // Not ready yet: no link.
    expect((await ws.get(`/privacy/contacts/requests/${res.body.id}/download`)).status).toBe(400);
    const audit = await ws.get('/orgs/current/audit-logs?action=privacy');
    expect(audit.body.items.map((i: { action: string }) => i.action)).toContain(
      'privacy.contact_exported',
    );
  });

  it('erases only with the name, or ERASE, typed to confirm', async () => {
    const wrong = await ws.post(`/privacy/contacts/${contactId}/erase`, { confirm: 'Someone' });
    expect(wrong.status).toBe(400);
    const ok = await ws.post(`/privacy/contacts/${contactId}/erase`, { confirm: 'Meena' });
    expect(ok.status).toBe(201);
    expect(ok.body.kind).toBe('contact_erase');
  });

  it('refuses to add an erased number back by hand', async () => {
    await withTenant(owner, { orgId }, (tx) =>
      tx.erasedIdentity.create({
        data: { orgId, hash: identityHash(ENCRYPTION_KEY, orgId, '919811100099') },
      }),
    );
    const res = await ws.post('/contacts', { phone: '+919811100099', name: 'Back again' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CONTACT_ERASED');
  });

  it('is closed to agents', async () => {
    const agent = await member('agent');
    expect((await agent.post(`/privacy/contacts/${contactId}/export`)).status).toBe(403);
  });
});

describe('the whole workspace', () => {
  it('is for owners only, not admins', async () => {
    const admin = await member('admin');
    expect((await admin.get('/privacy/workspace')).status).toBe(403);
    expect((await admin.post('/privacy/workspace/exports')).status).toBe(403);
    expect(
      (await admin.post('/privacy/workspace/deletion', { confirmName: 'Spice Co' })).status,
    ).toBe(403);
  });

  it('sets a message retention period, within limits', async () => {
    expect(
      (await ws.patch('/privacy/workspace/retention', { messageRetentionDays: 5 })).status,
    ).toBe(400);
    const set = await ws.patch('/privacy/workspace/retention', { messageRetentionDays: 365 });
    expect(set.body.messageRetentionDays).toBe(365);
    const off = await ws.patch('/privacy/workspace/retention', { messageRetentionDays: null });
    expect(off.body.messageRetentionDays).toBeNull();
  });

  it('deletes only after a grace period the owner can cancel', async () => {
    const wrong = await ws.post('/privacy/workspace/deletion', { confirmName: 'Wrong' });
    expect(wrong.status).toBe(400);
    const asked = await ws.post('/privacy/workspace/deletion', { confirmName: 'Spice Co' });
    expect(asked.status).toBe(201);
    const days = (Date.parse(asked.body.deletesAt) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(13.9);
    // Still working meanwhile.
    expect((await ws.get('/contacts')).status).toBe(200);
    const cancelled = await ws.delete('/privacy/workspace/deletion');
    expect(cancelled.body.deletesAt).toBeNull();
    const audit = await ws.get('/orgs/current/audit-logs?action=privacy');
    const actions = audit.body.items.map((i: { action: string }) => i.action);
    expect(actions).toContain('privacy.org_deletion_requested');
    expect(actions).toContain('privacy.org_deletion_cancelled');
  });

  it('queues a whole-workspace export', async () => {
    const res = await ws.post('/privacy/workspace/exports');
    expect(res.status).toBe(201);
    expect((await ws.get('/privacy/workspace/exports')).body[0].id).toBe(res.body.id);
  });
});
