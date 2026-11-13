/**
 * Phase 4.1 acceptance, over real HTTP on real Postgres and Redis: a partner creates two clients,
 * and wallets, limits, commissions and the impersonation audit trail all behave, while nobody
 * reaches a workspace or a console that is not theirs.
 */
import { randomUUID } from 'node:crypto';
import {
  chargeMessage,
  createPrismaClient,
  type DbClient,
  refundDebit,
  withTenant,
} from '@wacrm/db';
import { ErrorCode, messageDebitKey, periodOf, previousPeriod } from '@wacrm/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, Client, type TestApp, tokenFromMail, uniqueEmail, urls } from './helpers';

const CURRENCY = 'XRS';
const PASSWORD = 'correct-horse-battery';

let t: TestApp;
let owner: DbClient;
/** The app role, as the API and worker connect: charges here go through RLS. */
let app: DbClient;

let admin: Client;
let partner: Client;
let partnerEmail: string;
let partnerId: string;
let rival: Client;
let rivalPartnerId: string;

let clientA: { id: string; ownerEmail: string };
let clientB: { id: string; ownerEmail: string };
let ownerA: Client;
let ownerB: Client;

const charge = (orgId: string, messageId: string) =>
  withTenant(app, { orgId }, (tx) =>
    chargeMessage(tx, {
      orgId,
      messageId,
      category: 'marketing',
      country: 'IN',
      windowOpen: false,
      defaults: { currency: CURRENCY, thresholdMicros: null },
    }),
  );

/** Accept the owner invitation a partner sent, as a brand-new account. */
async function acceptInvite(email: string): Promise<Client> {
  const c = new Client(t.app);
  const res = await c.post('/invitations/accept', {
    token: tokenFromMail(t.mailer, email),
    name: 'Client Owner',
    password: PASSWORD,
  });
  expect(res.status).toBe(200);
  return c;
}

const credit = (c: Client, path: string, amount: string, key: string = randomUUID()) =>
  c.post(path, { amount, note: 'Collected by bank transfer', idempotencyKey: key });

beforeAll(async () => {
  t = await buildApp({
    env: { WALLET_DEFAULT_CURRENCY: CURRENCY, WALLET_LOW_BALANCE_DEFAULT: '0' },
  });
  owner = createPrismaClient({ connectionString: urls.directUrl });
  app = createPrismaClient({ connectionString: urls.appUrl });
  await owner.rateCard.createMany({
    data: [
      {
        country: 'IN',
        category: 'marketing',
        currency: CURRENCY,
        rateMicros: 1_000_000n,
        validFrom: new Date('2026-01-01'),
      },
    ],
    skipDuplicates: true,
  });

  admin = new Client(t.app);
  const adminUser = await admin.signup({ orgName: 'Platform' });
  await owner.platformAdmin.create({ data: { userId: adminUser.userId } });

  partner = new Client(t.app);
  partnerEmail = uniqueEmail('partner');
  await partner.signup({ email: partnerEmail, orgName: 'Reseller HQ' });
  rival = new Client(t.app);
  const rivalEmail = uniqueEmail('rival');
  await rival.signup({ email: rivalEmail, orgName: 'Rival HQ' });

  // Wholesale prices make plans sellable to partners in this currency.
  for (const [code, amount] of [
    ['starter', '10'],
    ['growth', '40'],
  ]) {
    const res = await admin.req('PUT', `/admin/plans/${code}/wholesale`, {
      currency: CURRENCY,
      amount,
    });
    expect(res.status).toBe(200);
  }

  const made = await admin.post('/admin/partners', {
    name: 'Acme Resellers',
    currency: CURRENCY,
    maxClients: 2,
    walletMarkupBps: 2000,
    adminEmail: partnerEmail,
  });
  expect(made.status).toBe(201);
  partnerId = made.body.id;

  const other = await admin.post('/admin/partners', {
    name: 'Rival Resellers',
    currency: CURRENCY,
    adminEmail: rivalEmail,
  });
  rivalPartnerId = other.body.id;
});

afterAll(async () => {
  await t?.close();
  await owner?.$disconnect();
  await app?.$disconnect();
});

describe('who reaches the consoles', () => {
  it('keeps the admin console to platform admins', async () => {
    for (const c of [partner, new Client(t.app)]) {
      if (!c.accessToken) await c.signup();
      const res = await c.get('/admin/partners');
      expect(res.status).toBe(403);
    }
    const res = await admin.get('/admin/partners');
    expect(res.status).toBe(200);
    expect(res.body.map((p: { id: string }) => p.id)).toEqual(
      expect.arrayContaining([partnerId, rivalPartnerId]),
    );
  });

  it('keeps the partner console to partner staff', async () => {
    const stranger = new Client(t.app);
    await stranger.signup();
    expect((await stranger.get('/partner')).status).toBe(403);
    // A platform admin is not a partner either.
    expect((await admin.get('/partner')).status).toBe(403);

    const mine = await partner.get('/partner');
    expect(mine.status).toBe(200);
    expect(mine.body).toMatchObject({
      id: partnerId,
      walletMarkupBps: 2000,
      maxClients: 2,
      clientCount: 0,
    });
  });

  it('says so on /auth/me', async () => {
    expect((await partner.get('/auth/me')).body).toMatchObject({
      partner: { id: partnerId, name: 'Acme Resellers' },
      platformAdmin: false,
      impersonation: null,
    });
    expect((await admin.get('/auth/me')).body).toMatchObject({
      partner: null,
      platformAdmin: true,
    });
  });

  it('adds staff only from existing accounts, one partner each', async () => {
    const missing = await admin.post(`/admin/partners/${partnerId}/members`, {
      email: uniqueEmail('nobody'),
    });
    expect(missing.status).toBe(404);
    const taken = await admin.post(`/admin/partners/${rivalPartnerId}/members`, {
      email: partnerEmail,
    });
    expect(taken.status).toBe(409);
    const members = await admin.get(`/admin/partners/${partnerId}/members`);
    expect(members.body.map((m: { email: string }) => m.email)).toEqual([partnerEmail]);
  });
});

describe('a partner creates two clients', () => {
  it('offers the plans that have a wholesale price', async () => {
    const plans = await partner.get('/partner/plans');
    expect(plans.body.map((p: { code: string }) => p.code)).toEqual(['starter', 'growth']);
    expect(plans.body[1]).toMatchObject({ wholesaleMicros: 40_000_000, currency: CURRENCY });
  });

  it('creates them with a plan, a wallet, limits and an owner invitation', async () => {
    const emailA = uniqueEmail('owner-a');
    const a = await partner.post('/partner/clients', {
      name: 'Client A',
      ownerEmail: emailA,
      planCode: 'growth',
      limits: { seats: 2 },
      clientPrice: '65',
    });
    expect(a.status).toBe(201);
    expect(a.body).toMatchObject({
      name: 'Client A',
      status: 'active',
      planCode: 'growth',
      ownerEmail: emailA,
      // Growth allows 10 seats; the partner capped it at 2. The rest are the plan's.
      limits: { seats: 2, numbers: 3, contacts: 25000 },
      clientPriceMicros: 65_000_000,
      wholesalePriceMicros: 40_000_000,
      currency: CURRENCY,
      balanceMicros: 0,
    });
    clientA = { id: a.body.id, ownerEmail: emailA };

    const emailB = uniqueEmail('owner-b');
    const b = await partner.post('/partner/clients', {
      name: 'Client B',
      ownerEmail: emailB,
      planCode: 'starter',
    });
    expect(b.status).toBe(201);
    clientB = { id: b.body.id, ownerEmail: emailB };

    const list = await partner.get('/partner/clients');
    expect(list.body.map((c: { id: string }) => c.id).sort()).toEqual(
      [clientA.id, clientB.id].sort(),
    );
  });

  it('stops at the partner’s limit on clients', async () => {
    const res = await partner.post('/partner/clients', {
      name: 'Client C',
      ownerEmail: uniqueEmail('owner-c'),
      planCode: 'starter',
    });
    expect(res.status).toBe(402);
    expect(res.body.code).toBe(ErrorCode.PARTNER_LIMIT_REACHED);
  });

  it('refuses a plan the platform does not sell to partners', async () => {
    const res = await partner.patch(`/partner/clients/${clientA.id}`, { planCode: 'scale' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(ErrorCode.BILLING_PRICE_UNAVAILABLE);
  });

  it('lets the invited owners in as owners of their own workspace only', async () => {
    ownerA = await acceptInvite(clientA.ownerEmail);
    ownerB = await acceptInvite(clientB.ownerEmail);
    const me = (await ownerA.get('/auth/me')).body;
    expect(me.currentOrg).toMatchObject({ id: clientA.id, role: 'owner' });
    expect(me.orgs).toHaveLength(1);
    expect(me.partner).toBeNull();
    // The partner's staff are not members of the client.
    const members = await ownerA.get('/team/members');
    expect(members.body).toHaveLength(1);
  });
});

describe('billing belongs to the partner', () => {
  it('shows the client who manages it and the limits in force', async () => {
    const summary = (await ownerA.get('/billing/summary')).body;
    expect(summary.managedBy).toBe('Acme Resellers');
    expect(summary.status).toBe('active');
    expect(summary.plan).toMatchObject({ code: 'growth', seats: 2, numbers: 3 });
  });

  it('refuses the client’s own checkout and top-up', async () => {
    const checkout = await ownerA.post('/billing/checkout', {
      planCode: 'scale',
      interval: 'month',
    });
    const topup = await ownerA.post('/billing/topups', { amount: '100' });
    for (const res of [checkout, topup]) {
      expect(res.status).toBe(409);
      expect(res.body.code).toBe(ErrorCode.MANAGED_BY_PARTNER);
    }
  });
});

describe('limits', () => {
  it('applies the partner’s cap, not the plan’s larger limit', async () => {
    // One owner plus one invitation fill the two seats.
    const first = await ownerA.post('/team/invitations', {
      email: uniqueEmail('agent'),
      role: 'agent',
    });
    expect(first.status).toBe(201);
    const second = await ownerA.post('/team/invitations', {
      email: uniqueEmail('agent'),
      role: 'agent',
    });
    expect(second.status).toBe(402);
    expect(second.body.code).toBe(ErrorCode.PLAN_LIMIT_REACHED);
  });

  it('follows a change by the partner at once, and never passes the plan', async () => {
    const raised = await partner.patch(`/partner/clients/${clientA.id}`, {
      limits: { seats: 50 },
    });
    // The cap is stored, but Growth's own 10 seats still win.
    expect(raised.body.partnerLimits.seats).toBe(50);
    expect(raised.body.limits.seats).toBe(10);
    const invite = await ownerA.post('/team/invitations', {
      email: uniqueEmail('agent'),
      role: 'agent',
    });
    expect(invite.status).toBe(201);
  });

  it('cannot be changed by the client itself', async () => {
    const res = await withTenant(app, { orgId: clientA.id }, (tx) =>
      tx.partnerClient.updateMany({ where: { orgId: clientA.id }, data: { limitSeats: 999 } }),
    );
    expect(res.count).toBe(0);
  });
});

describe('wallets', () => {
  it('credits one client, once per key, and leaves the other alone', async () => {
    const key = randomUUID();
    const path = `/partner/clients/${clientA.id}/wallet/credit`;
    const first = await credit(partner, path, '100', key);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ applied: true, balanceMicros: 100_000_000 });
    const again = await credit(partner, path, '100', key);
    expect(again.body).toEqual({ applied: false, balanceMicros: 100_000_000 });

    expect((await ownerA.get('/wallet')).body.balanceMicros).toBe(100_000_000);
    expect((await ownerB.get('/wallet')).body.balanceMicros).toBe(0);

    const ledger = (await ownerA.get('/wallet/ledger')).body.items;
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ type: 'credit', amountMicros: 100_000_000 });
  });

  it('charges the client the rate card price plus the partner’s markup', async () => {
    const messageId = randomUUID();
    await charge(clientA.id, messageId);
    // 1.00 on the rate card, plus 20%.
    expect((await ownerA.get('/wallet')).body.balanceMicros).toBe(98_800_000);

    // The client sees its own price everywhere, and wholesale nowhere.
    const rates = (await ownerA.get('/wallet/rates')).body;
    expect(rates).toEqual([expect.objectContaining({ country: 'IN', rateMicros: 1_200_000 })]);
    const [debit] = (await ownerA.get('/wallet/ledger')).body.items;
    expect(debit).toMatchObject({ type: 'debit', amountMicros: -1_200_000 });
    expect(JSON.stringify(debit)).not.toMatch(/wholesale|partner/i);
  });
});

describe('commissions', () => {
  it('records what the partner owes and earns on each charge, and reverses a refund', async () => {
    const before = (await partner.get('/partner/summary')).body;
    expect(before).toMatchObject({
      period: periodOf(new Date()),
      currency: CURRENCY,
      usageWholesaleMicros: 1_000_000,
      usageRetailMicros: 1_200_000,
      commissionMicros: 200_000,
      totalDueMicros: 1_000_000,
    });

    const refunded = randomUUID();
    await charge(clientA.id, refunded);
    await charge(clientA.id, refunded); // the same message never charges twice
    expect((await partner.get('/partner/summary')).body.commissionMicros).toBe(400_000);
    await withTenant(app, { orgId: clientA.id }, (tx) =>
      refundDebit(tx, { orgId: clientA.id, debitKey: messageDebitKey(refunded) }),
    );

    const after = (await partner.get('/partner/summary')).body;
    expect(after).toMatchObject({
      usageWholesaleMicros: 1_000_000,
      usageRetailMicros: 1_200_000,
      commissionMicros: 200_000,
      totalDueMicros: 1_000_000,
    });
    expect((await ownerA.get('/wallet')).body.balanceMicros).toBe(98_800_000);

    const ledger = (await partner.get('/partner/ledger')).body.items;
    expect(ledger.map((e: { type: string }) => e.type)).toEqual(['usage_refund', 'usage', 'usage']);
    expect(ledger[0]).toMatchObject({
      orgName: 'Client A',
      wholesaleMicros: -1_000_000,
      retailMicros: -1_200_000,
      commissionMicros: -200_000,
    });
  });

  it('uses a new markup for new charges only', async () => {
    const res = await partner.patch('/partner', { walletMarkupBps: 5000 });
    expect(res.body.walletMarkupBps).toBe(5000);
    await charge(clientB.id, randomUUID()).catch((err: { code?: string }) => {
      // Client B has no funds: the charge is refused, and nothing is owed for it.
      expect(err.code).toBe(ErrorCode.INSUFFICIENT_BALANCE);
    });
    await credit(partner, `/partner/clients/${clientB.id}/wallet/credit`, '10');
    await charge(clientB.id, randomUUID());
    expect((await ownerB.get('/wallet')).body.balanceMicros).toBe(8_500_000);

    const summary = (await partner.get('/partner/summary')).body;
    expect(summary.usageWholesaleMicros).toBe(2_000_000);
    expect(summary.commissionMicros).toBe(700_000);
    const detail = (await partner.get(`/partner/clients/${clientB.id}`)).body;
    expect(detail.month).toMatchObject({
      usageWholesaleMicros: 1_000_000,
      commissionMicros: 500_000,
    });
  });

  it('charges a workspace with no partner the rate card price, and owes nobody', async () => {
    const solo = new Client(t.app);
    const { orgId } = await solo.signup();
    await withTenant(owner, { orgId }, async (tx) => {
      await tx.wallet.create({ data: { orgId, currency: CURRENCY, balanceMicros: 5_000_000n } });
    });
    await charge(orgId, randomUUID());
    expect((await solo.get('/wallet')).body.balanceMicros).toBe(4_000_000);
    expect(await owner.partnerLedger.count({ where: { orgId } })).toBe(0);
  });

  it('issues nothing for a month with nothing in it, and refuses the current month', async () => {
    const empty = await admin.post(`/admin/partners/${rivalPartnerId}/statements/close`, {
      period: previousPeriod(periodOf(new Date())),
    });
    expect(empty.status).toBe(200);
    expect(empty.body.statement).toBeNull();
    const current = await admin.post(`/admin/partners/${partnerId}/statements/close`, {
      period: periodOf(new Date()),
    });
    expect(current.status).toBe(409);
  });
});

describe('impersonation', () => {
  let token: string;
  const as = (accessToken: string) => {
    const c = new Client(t.app);
    c.accessToken = accessToken;
    return c;
  };

  it('needs a reason', async () => {
    const res = await partner.post(`/partner/clients/${clientA.id}/impersonate`, { reason: '' });
    expect(res.status).toBe(400);
  });

  it('opens the client as an admin who is visibly not a member', async () => {
    const started = await new Client(t.app).req(
      'POST',
      `/partner/clients/${clientA.id}/impersonate`,
      { reason: 'Client asked for help with a template' },
      { authorization: `Bearer ${partner.accessToken}` },
    );
    expect(started.status).toBe(200);
    expect(started.body.impersonation).toMatchObject({ orgId: clientA.id, orgName: 'Client A' });
    token = started.body.accessToken;

    const me = (await as(token).get('/auth/me')).body;
    expect(me.currentOrg).toMatchObject({ id: clientA.id, role: 'admin' });
    expect(me.impersonation).toMatchObject({ orgName: 'Client A' });
    // The person's own workspaces are still theirs; the client is not among them.
    expect(me.orgs.map((o: { id: string }) => o.id)).not.toContain(clientA.id);
  });

  it('works inside the client, with the limits of an impersonator', async () => {
    const renamed = await as(token).patch('/orgs/current', { name: 'Client A Ltd' });
    expect(renamed.status).toBe(200);

    // Nothing that outlives the session or changes who is in the workspace.
    const key = await as(token).post('/api-keys', { name: 'k', scopes: ['contacts:read'] });
    expect(key.status).toBe(403);
    const members = (await ownerA.get('/team/members')).body;
    const remove = await as(token).delete(`/team/members/${members[0].id}`);
    expect(remove.status).toBe(403);
    // And it is a key to this one workspace, not to the consoles.
    expect((await as(token).get('/partner/clients')).status).toBe(403);
    expect((await as(token).get('/admin/partners')).status).toBe(403);
  });

  it('leaves a trail the client’s owner can read', async () => {
    expect((await as(token).post('/impersonation/end')).status).toBe(204);
    // Ended means ended: the token is dead well before it expires.
    expect((await as(token).get('/orgs/current')).status).toBe(401);

    const logs = (await ownerA.get('/orgs/current/audit-logs')).body.items as {
      action: string;
      impersonated: boolean;
      metadata: Record<string, unknown> | null;
      actorUserId: string;
    }[];
    const trail = logs.filter((l) => l.impersonated).reverse();
    expect(trail.map((l) => l.action)).toEqual([
      'impersonation.started',
      'org.updated',
      'impersonation.ended',
    ]);
    expect(trail[0]?.metadata).toMatchObject({
      reason: 'Client asked for help with a template',
      by: 'partner',
    });
    // The owner's own actions are not marked.
    expect(logs.some((l) => l.action === 'team.invite_created' && !l.impersonated)).toBe(true);
  });

  it('dies when the person stops working for the partner', async () => {
    const temp = new Client(t.app);
    const tempEmail = uniqueEmail('temp');
    const { userId } = await temp.signup({ email: tempEmail });
    await admin.post(`/admin/partners/${partnerId}/members`, { email: tempEmail });
    const started = await temp.post(`/partner/clients/${clientA.id}/impersonate`, {
      reason: 'Checking a campaign',
    });
    // The Client helper adopts any accessToken in a response, so keep the two apart.
    const imp = started.body.accessToken as string;
    expect((await as(imp).get('/orgs/current')).status).toBe(200);

    const removed = await admin.delete(`/admin/partners/${partnerId}/members/${userId}`);
    expect(removed.status).toBe(204);
    expect((await as(imp).get('/orgs/current')).status).toBe(401);
  });

  it('is open to a platform admin for any workspace, and marked as such', async () => {
    const adminToken = admin.accessToken;
    const started = await admin.post(`/admin/orgs/${clientB.id}/impersonate`, {
      reason: 'Support ticket 4821',
    });
    expect(started.status).toBe(200);
    const imp = started.body.accessToken as string;
    admin.accessToken = adminToken;
    expect((await as(imp).get('/orgs/current')).body.id).toBe(clientB.id);
    await as(imp).post('/impersonation/end');

    const logs = (await ownerB.get('/orgs/current/audit-logs')).body.items as {
      action: string;
      metadata: Record<string, unknown> | null;
    }[];
    const start = logs.find((l) => l.action === 'impersonation.started');
    expect(start?.metadata).toMatchObject({ by: 'platform', reason: 'Support ticket 4821' });
  });
});

describe('isolation between partners and from clients', () => {
  it('hides one partner’s clients from another, on every route', async () => {
    expect((await rival.get('/partner/clients')).body).toEqual([]);
    const id = clientA.id;
    const attempts = await Promise.all([
      rival.get(`/partner/clients/${id}`),
      rival.patch(`/partner/clients/${id}`, { name: 'Stolen' }),
      rival.patch(`/partner/clients/${id}`, { planCode: 'starter' }),
      rival.post(`/partner/clients/${id}/suspend`),
      rival.delete(`/partner/clients/${id}`),
      credit(rival, `/partner/clients/${id}/wallet/credit`, '5'),
      rival.post(`/partner/clients/${id}/invite-owner`, { email: uniqueEmail('x') }),
      rival.post(`/partner/clients/${id}/impersonate`, { reason: 'No business here' }),
    ]);
    expect(attempts.map((r) => r.status)).toEqual(Array(8).fill(404));
    // Nothing moved.
    expect((await ownerA.get('/wallet')).body.balanceMicros).toBe(98_800_000);
    expect((await rival.get('/partner/summary')).body.totalDueMicros).toBe(0);
    expect((await rival.get('/partner/ledger')).body.items).toEqual([]);
  });

  it('hides workspaces that are not a partner’s clients at all', async () => {
    const solo = new Client(t.app);
    const { orgId } = await solo.signup();
    expect((await partner.get(`/partner/clients/${orgId}`)).status).toBe(404);
    expect(
      (await partner.post(`/partner/clients/${orgId}/impersonate`, { reason: 'Curious' })).status,
    ).toBe(404);
  });

  it('gives a client’s owner no way into the partner or its other clients', async () => {
    expect((await ownerA.get('/partner')).status).toBe(403);
    expect((await ownerA.get(`/partner/clients/${clientB.id}`)).status).toBe(403);
    const switched = await ownerA.post('/auth/switch-org', { orgId: clientB.id });
    expect(switched.status).toBe(403);
  });

  it('holds at the database for the app role too', async () => {
    const seen = await withTenant(app, { orgId: clientA.id }, async (tx) => ({
      ledger: await tx.partnerLedger.count(),
      statements: await tx.partnerStatement.count(),
      otherClients: await tx.partnerClient.count({ where: { orgId: { not: clientA.id } } }),
      orgs: await tx.organization.count(),
    }));
    expect(seen).toEqual({ ledger: 0, statements: 0, otherClients: 0, orgs: 1 });
  });
});

describe('suspend and delete', () => {
  it('shuts a suspended client out at once, and lets it back in when resumed', async () => {
    expect((await partner.post(`/partner/clients/${clientB.id}/suspend`)).status).toBe(204);
    const blocked = await ownerB.get('/orgs/current');
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe(ErrorCode.ORG_SUSPENDED);
    // The switcher still works, and says why.
    const me = (await ownerB.get('/auth/me')).body;
    expect(me.currentOrg).toMatchObject({ id: clientB.id, suspended: true });
    expect(me.permissions).toEqual([]);

    expect((await partner.post(`/partner/clients/${clientB.id}/resume`)).status).toBe(204);
    expect((await ownerB.get('/orgs/current')).status).toBe(200);

    const actions = (await ownerB.get('/orgs/current/audit-logs')).body.items.map(
      (l: { action: string }) => l.action,
    );
    expect(actions).toEqual(
      expect.arrayContaining(['partner.client_suspended', 'partner.client_resumed']),
    );
  });

  it('deletes a client softly and frees the partner’s slot', async () => {
    expect((await partner.delete(`/partner/clients/${clientB.id}`)).status).toBe(204);
    const list = (await partner.get('/partner/clients')).body;
    expect(list.map((c: { id: string }) => c.id)).toEqual([clientA.id]);
    expect((await partner.get(`/partner/clients/${clientB.id}`)).status).toBe(404);

    const me = (await ownerB.get('/auth/me')).body;
    expect(me.currentOrg).toBeNull();
    expect(me.orgs).toEqual([]);
    // History stays; what it owed this month is still on the partner's ledger.
    expect(await owner.organization.count({ where: { id: clientB.id } })).toBe(1);
    expect((await partner.get('/partner/summary')).body.usageWholesaleMicros).toBe(2_000_000);

    const again = await partner.post('/partner/clients', {
      name: 'Client D',
      ownerEmail: uniqueEmail('owner-d'),
      planCode: 'starter',
    });
    expect(again.status).toBe(201);
  });

  it('stops a suspended partner using its console', async () => {
    await admin.patch(`/admin/partners/${rivalPartnerId}`, { status: 'suspended' });
    const res = await rival.get('/partner');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe(ErrorCode.PARTNER_SUSPENDED);
    expect((await rival.get('/auth/me')).body.partner).toBeNull();
  });
});

describe('the platform console', () => {
  it('lists workspaces with their partner, and finds one by name', async () => {
    const res = await admin.get('/admin/orgs?search=Client%20A');
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([
      expect.objectContaining({
        id: clientA.id,
        partnerId,
        partnerName: 'Acme Resellers',
        planCode: 'growth',
        balanceMicros: 98_800_000,
      }),
    ]);
  });

  it('changes a plan’s settings, and only for a platform admin', async () => {
    const before = (await admin.get('/admin/plans')).body.find(
      (p: { code: string }) => p.code === 'scale',
    );
    const description = `No limits. ${randomUUID().slice(0, 8)}`;
    const res = await admin.patch('/admin/plans/scale', { description });
    expect(res.status).toBe(200);
    const after = res.body.find((p: { code: string }) => p.code === 'scale');
    expect(after).toMatchObject({ ...before, description });
    expect((await partner.patch('/admin/plans/scale', { description: 'x' })).status).toBe(403);

    // The flag alone opens nothing: Postgres also wants a platform_admins row for the user.
    const sneaky = await app.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.platform_admin', 'on', true)`;
      return {
        updated: await tx.plan.updateMany({ where: { code: 'scale' }, data: { name: 'Hacked' } }),
        partners: await tx.partner.count(),
      };
    });
    expect(sneaky).toEqual({ updated: { count: 0 }, partners: 0 });
  });

  it('adds a rate that the next charge uses', async () => {
    const res = await admin.post('/admin/rate-cards', {
      country: 'BR',
      category: 'marketing',
      currency: CURRENCY,
      rate: '2.5',
    });
    expect(res.status).toBe(201);
    expect(res.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ country: 'BR', category: 'marketing', rateMicros: 2_500_000 }),
      ]),
    );
    expect(
      (
        await partner.post('/admin/rate-cards', {
          country: 'BR',
          category: 'utility',
          currency: CURRENCY,
          rate: '0.01',
        })
      ).status,
    ).toBe(403);
  });

  it('credits any workspace as an adjustment', async () => {
    const path = `/admin/orgs/${clientA.id}/wallet/credit`;
    const res = await credit(admin, path, '1.2');
    expect(res.body).toEqual({ applied: true, balanceMicros: 100_000_000 });
    const [entry] = (await ownerA.get('/wallet/ledger')).body.items;
    expect(entry).toMatchObject({ type: 'adjustment', amountMicros: 1_200_000 });
  });

  it('reports the database, Redis and every queue', async () => {
    const res = await admin.get('/admin/system');
    expect(res.status).toBe(200);
    expect(res.body.database.ok).toBe(true);
    expect(res.body.redis.ok).toBe(true);
    expect(res.body.queues.map((q: { name: string }) => q.name)).toEqual(
      expect.arrayContaining(['outbound-messages', 'campaigns', 'webhook-events']),
    );
    expect(res.body.counts.partners).toBeGreaterThanOrEqual(2);
  });

  it('keeps its own audit log', async () => {
    const actions = (await admin.get('/admin/audit')).body.items.map(
      (l: { action: string }) => l.action,
    );
    expect(actions).toEqual(
      expect.arrayContaining([
        'partner.created',
        'partner.member_added',
        'partner.markup_changed',
        'plan.wholesale_price_changed',
        'plan.changed',
        'rate_card.added',
      ]),
    );
  });
});
