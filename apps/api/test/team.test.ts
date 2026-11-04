/** Role guards, team management and invitations. */
import { ErrorCode } from '@wacrm/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '@wacrm/db';
import { PrismaService } from '../src/db/prisma.service';
import { requestContext } from '../src/tenancy/request-context';
import { TeamService } from '../src/team/team.service';
import { buildApp, Client, type TestApp, tokenFromMail, uniqueEmail } from './helpers';

let t: TestApp;
beforeAll(async () => {
  t = await buildApp();
});
afterAll(() => t?.close());

const client = () => new Client(t.app);

/** Owner invites `email` as `role`; a new client accepts as a brand-new user. */
async function addMember(owner: Client, role: 'admin' | 'agent' | 'owner') {
  const email = uniqueEmail(role);
  const inv = await owner.post('/team/invitations', { email, role });
  if (inv.status !== 201)
    throw new Error(`invite failed ${inv.status} ${JSON.stringify(inv.body)}`);
  const member = new Client(t.app);
  const res = await member.post('/invitations/accept', {
    token: tokenFromMail(t.mailer, email),
    name: `New ${role}`,
    password: 'correct-horse-battery',
  });
  if (res.status !== 200)
    throw new Error(`accept failed ${res.status} ${JSON.stringify(res.body)}`);
  const members = (await owner.get('/team/members')).body as { id: string; email: string }[];
  const membershipId = members.find((m) => m.email === email)!.id;
  return { client: member, email, membershipId };
}

async function setup() {
  const owner = client();
  const o = await owner.signup({ orgName: 'Team Org' });
  const admin = await addMember(owner, 'admin');
  const agent = await addMember(owner, 'agent');
  const members = (await owner.get('/team/members')).body as { id: string; userId: string }[];
  const ownerMembershipId = members.find((m) => m.userId === o.userId)!.id;
  return { owner, orgId: o.orgId, ownerMembershipId, admin, agent };
}

describe('invitations', () => {
  it('a new user accepts, gets an account and the invited role', async () => {
    const { agent, orgId } = await setup();
    const me = (await agent.client.get('/auth/me')).body;
    expect(me.currentOrg).toMatchObject({ id: orgId, role: 'agent' });
    expect(me.user.emailVerified).toBe(true);
    expect(me.permissions).toContain('inbox:reply');
    expect(me.permissions).not.toContain('team:invite');
  });

  it('previews the invitation without logging in', async () => {
    const owner = client();
    await owner.signup({ orgName: 'Preview Org' });
    const email = uniqueEmail('preview');
    await owner.post('/team/invitations', { email, role: 'agent' });
    const res = await client().post('/invitations/preview', {
      token: tokenFromMail(t.mailer, email),
    });
    expect(res.body).toEqual({
      orgName: 'Preview Org',
      email,
      role: 'agent',
      accountExists: false,
    });
  });

  it('can be used only once', async () => {
    const owner = client();
    await owner.signup();
    const email = uniqueEmail('once');
    await owner.post('/team/invitations', { email, role: 'agent' });
    const token = tokenFromMail(t.mailer, email);
    const body = { token, name: 'Once', password: 'correct-horse-battery' };
    expect((await client().post('/invitations/accept', body)).status).toBe(200);
    const second = await client().post('/invitations/accept', body);
    expect(second.status).toBe(400);
    expect(second.body.code).toBe(ErrorCode.INVITATION_INVALID);
  });

  it('revoked invitations stop working', async () => {
    const owner = client();
    await owner.signup();
    const email = uniqueEmail('revoked');
    const inv = await owner.post('/team/invitations', { email, role: 'agent' });
    expect((await owner.delete(`/team/invitations/${inv.body.id}`)).status).toBe(204);
    const res = await client().post('/invitations/preview', {
      token: tokenFromMail(t.mailer, email),
    });
    expect(res.body.code).toBe(ErrorCode.INVITATION_INVALID);
  });

  it('existing accounts must log in, with the invited email', async () => {
    const owner = client();
    await owner.signup({ orgName: 'Host Org' });
    const invitee = client();
    const existing = await invitee.signup({ orgName: 'Invitee Own Org' });
    await owner.post('/team/invitations', { email: existing.email, role: 'admin' });
    const token = tokenFromMail(t.mailer, existing.email);

    const anonymous = await client().post('/invitations/accept', { token });
    expect(anonymous.status).toBe(401);

    const stranger = client();
    await stranger.signup();
    const mismatch = await stranger.post('/invitations/accept', { token });
    expect(mismatch.status).toBe(403);
    expect(mismatch.body.code).toBe(ErrorCode.INVITATION_EMAIL_MISMATCH);

    const ok = await invitee.post('/invitations/accept', { token });
    expect(ok.status).toBe(200);
    const me = (await invitee.get('/auth/me')).body;
    expect(me.currentOrg).toMatchObject({ name: 'Host Org', role: 'admin' });
    expect(me.orgs).toHaveLength(2);
  });

  it('cannot invite someone who is already a member', async () => {
    const { owner, agent } = await setup();
    const res = await owner.post('/team/invitations', { email: agent.email, role: 'agent' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe(ErrorCode.ALREADY_MEMBER);
  });
});

describe('agent permissions', () => {
  it('can read the team but not manage it or the org', async () => {
    const { agent, admin } = await setup();
    const c = agent.client;
    expect((await c.get('/team/members')).status).toBe(200);
    for (const res of [
      await c.post('/team/invitations', { email: uniqueEmail(), role: 'agent' }),
      await c.patch(`/team/members/${admin.membershipId}`, { role: 'agent' }),
      await c.delete(`/team/members/${admin.membershipId}`),
      await c.patch('/orgs/current', { name: 'Hacked' }),
      await c.get('/orgs/current/audit-logs'),
    ]) {
      expect(res.status).toBe(403);
      expect(res.body.code).toBe(ErrorCode.FORBIDDEN);
    }
  });
});

describe('admin permissions', () => {
  it('manages agents and admins but never owners', async () => {
    const { admin, agent, ownerMembershipId } = await setup();
    const c = admin.client;

    const promote = await c.patch(`/team/members/${agent.membershipId}`, { role: 'admin' });
    expect(promote.status).toBe(200);
    expect(promote.body.role).toBe('admin');

    const inviteOwner = await c.post('/team/invitations', { email: uniqueEmail(), role: 'owner' });
    expect(inviteOwner.status).toBe(403);
    expect(inviteOwner.body.code).toBe(ErrorCode.ROLE_NOT_ALLOWED);

    const makeOwner = await c.patch(`/team/members/${agent.membershipId}`, { role: 'owner' });
    expect(makeOwner.body.code).toBe(ErrorCode.ROLE_NOT_ALLOWED);

    expect((await c.patch(`/team/members/${ownerMembershipId}`, { role: 'agent' })).body.code).toBe(
      ErrorCode.ROLE_NOT_ALLOWED,
    );
    expect((await c.delete(`/team/members/${ownerMembershipId}`)).body.code).toBe(
      ErrorCode.ROLE_NOT_ALLOWED,
    );
  });

  it('cannot change their own role', async () => {
    const { admin } = await setup();
    const res = await admin.client.patch(`/team/members/${admin.membershipId}`, { role: 'agent' });
    expect(res.body.code).toBe(ErrorCode.ROLE_NOT_ALLOWED);
  });
});

describe('owner safeguards', () => {
  it('an owner can hand over ownership and step down', async () => {
    const { owner, admin, ownerMembershipId } = await setup();
    expect(
      (await owner.patch(`/team/members/${admin.membershipId}`, { role: 'owner' })).status,
    ).toBe(200);
    expect(
      (await admin.client.patch(`/team/members/${ownerMembershipId}`, { role: 'admin' })).status,
    ).toBe(200);
    // The former owner (now admin) cannot touch the remaining owner.
    const res = await owner.patch(`/team/members/${admin.membershipId}`, { role: 'agent' });
    expect(res.body.code).toBe(ErrorCode.ROLE_NOT_ALLOWED);
  });

  it('two owners demoting each other at once never leaves zero owners', async () => {
    const { owner, admin, ownerMembershipId } = await setup();
    await owner.patch(`/team/members/${admin.membershipId}`, { role: 'owner' });

    const [r1, r2] = await Promise.all([
      owner.patch(`/team/members/${admin.membershipId}`, { role: 'admin' }),
      admin.client.patch(`/team/members/${ownerMembershipId}`, { role: 'admin' }),
    ]);
    // One wins; the other is refused (LAST_OWNER, or ROLE_NOT_ALLOWED if its caller was
    // already demoted by the time the guard loaded its role).
    expect([r1.status, r2.status].sort()).toEqual([200, expect.any(Number)]);
    expect([r1.body.code, r2.body.code]).toEqual(
      expect.arrayContaining([expect.stringMatching(/^(LAST_OWNER|ROLE_NOT_ALLOWED)$/)]),
    );

    const members = (await (r1.status === 200 ? owner : admin.client).get('/team/members'))
      .body as { role: string }[];
    expect(members.filter((m) => m.role === 'owner')).toHaveLength(1);
  });

  it('LAST_OWNER holds even when both actors still believe they are owners', async () => {
    // Drive the service directly with stale "owner" roles: this is the window the advisory
    // lock exists for.
    const { owner, admin, orgId, ownerMembershipId } = await setup();
    await owner.patch(`/team/members/${admin.membershipId}`, { role: 'owner' });
    const ownerId = (await owner.get('/auth/me')).body.user.id as string;
    const adminId = (await admin.client.get('/auth/me')).body.user.id as string;
    const team = t.app.get(TeamService);
    const meta = { ip: null, userAgent: null };
    const as = (userId: string, fn: () => Promise<unknown>) =>
      requestContext.run({ userId, orgId, role: 'owner' }, fn).then(
        () => 'ok',
        (e: { code?: string }) => e.code,
      );

    const results = await Promise.all([
      as(ownerId, () =>
        team.changeRole(
          { userId: ownerId, orgId, role: 'owner' },
          admin.membershipId,
          'admin',
          meta,
        ),
      ),
      as(adminId, () =>
        team.changeRole(
          { userId: adminId, orgId, role: 'owner' },
          ownerMembershipId,
          'admin',
          meta,
        ),
      ),
    ]);
    expect(results.sort()).toEqual([ErrorCode.LAST_OWNER, 'ok']);
  });

  it('membership changes wait for the per-org lock', async () => {
    const { owner, agent, orgId } = await setup();
    const ownerId = (await owner.get('/auth/me')).body.user.id as string;
    const prisma = t.app.get(PrismaService);
    const team = t.app.get(TeamService);

    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const lockTaken = new Promise<void>((r) => (locked = r));
    const blocker = withTenant(
      prisma.client,
      { orgId },
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('memberships:' || app_current_org_id()::text, 0))`;
        locked();
        await held;
      },
      { timeout: 10_000 },
    );
    await lockTaken;

    let finished = false;
    const change = requestContext
      .run({ userId: ownerId, orgId, role: 'owner' }, () =>
        team.changeRole({ userId: ownerId, orgId, role: 'owner' }, agent.membershipId, 'admin', {
          ip: null,
          userAgent: null,
        }),
      )
      .then(() => (finished = true));
    await new Promise((r) => setTimeout(r, 400));
    expect(finished).toBe(false); // blocked behind the lock
    release();
    await blocker;
    await change;
    expect(finished).toBe(true);
  });

  it('nobody can remove themselves or change their own role', async () => {
    const { owner, ownerMembershipId } = await setup();
    expect((await owner.delete(`/team/members/${ownerMembershipId}`)).body.code).toBe(
      ErrorCode.ROLE_NOT_ALLOWED,
    );
    expect(
      (await owner.patch(`/team/members/${ownerMembershipId}`, { role: 'admin' })).body.code,
    ).toBe(ErrorCode.ROLE_NOT_ALLOWED);
  });
});

describe('revocation is immediate', () => {
  it('a removed member loses org access with the same access token', async () => {
    const { owner, agent } = await setup();
    expect((await agent.client.get('/team/members')).status).toBe(200);
    expect((await owner.delete(`/team/members/${agent.membershipId}`)).status).toBe(204);
    const res = await agent.client.get('/team/members');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe(ErrorCode.TENANT_CONTEXT_MISSING);
    // Still logged in, just without an org.
    const me = (await agent.client.get('/auth/me')).body;
    expect(me.currentOrg).toBeNull();
    expect(me.orgs).toEqual([]);
  });

  it('a demoted admin loses admin permissions on the next request', async () => {
    const { owner, admin } = await setup();
    expect((await admin.client.get('/orgs/current/audit-logs')).status).toBe(200);
    await owner.patch(`/team/members/${admin.membershipId}`, { role: 'agent' });
    expect((await admin.client.get('/orgs/current/audit-logs')).status).toBe(403);
  });
});

describe('cross-tenant', () => {
  it("cannot touch another org's members by id", async () => {
    const a = await setup();
    const b = await setup();
    const res = await a.owner.patch(`/team/members/${b.agent.membershipId}`, { role: 'admin' });
    expect(res.status).toBe(404);
    expect((await a.owner.delete(`/team/members/${b.agent.membershipId}`)).status).toBe(404);
    const bMembers = (await b.owner.get('/team/members')).body as { id: string; role: string }[];
    expect(bMembers.find((m) => m.id === b.agent.membershipId)?.role).toBe('agent');
  });
});

describe('audit log', () => {
  it('records team actions and paginates with a cursor', async () => {
    const { owner } = await setup();
    const first = await owner.get('/orgs/current/audit-logs?limit=2');
    expect(first.body.items).toHaveLength(2);
    expect(first.body.nextCursor).toEqual(expect.any(String));
    const second = await owner.get(
      `/orgs/current/audit-logs?limit=2&cursor=${first.body.nextCursor}`,
    );
    const ids = [...first.body.items, ...second.body.items].map((i: { id: string }) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    const all = (await owner.get('/orgs/current/audit-logs?limit=100')).body.items.map(
      (i: { action: string }) => i.action,
    );
    expect(all).toEqual(
      expect.arrayContaining(['auth.signup', 'team.invite_created', 'team.invite_accepted']),
    );
  });
});
