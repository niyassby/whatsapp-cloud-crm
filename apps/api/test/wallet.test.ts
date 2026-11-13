/** Charging for sends over real HTTP, on real Postgres and Redis. Meta is faked. */
import { randomBytes, randomUUID } from 'node:crypto';
import {
  creditWallet,
  createPrismaClient,
  type DbClient,
  ensureWallet,
  withTenant,
  whatsappChannelId,
} from '@wacrm/db';
import { ErrorCode, messageDebitKey } from '@wacrm/shared';
import { phoneTokenAad, SecretBox } from '@wacrm/shared/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { QueuesService } from '../src/infra/queues.service';
import { buildApp, Client, type TestApp, tokenFromMail, uniqueEmail, urls } from './helpers';

const ENCRYPTION_KEY = randomBytes(32).toString('base64');
const secrets = new SecretBox(ENCRYPTION_KEY);
const metaId = () => String(Math.floor(Math.random() * 1e15) + 1e15);

const CURRENCY = 'XTS';
const INDIA = '919876543210';

let t: TestApp;
let owner: DbClient;

beforeAll(async () => {
  t = await buildApp({
    env: {
      ENCRYPTION_KEY,
      WALLET_DEFAULT_CURRENCY: CURRENCY,
      WALLET_LOW_BALANCE_DEFAULT: '0',
      DATABASE_POOL_MAX: '20',
    },
    graph: { apiVersion: 'v25.0', fetch: (async () => new Response('{}')) as typeof fetch },
  });
  owner = createPrismaClient({ connectionString: urls.directUrl });
  await owner.rateCard.createMany({
    data: [
      ['IN', 'marketing', 1_000_000],
      ['IN', 'utility', 200_000],
      ['*', 'marketing', 3_000_000],
    ].map(([country, category, micros]) => ({
      country: country as string,
      category: category as string,
      currency: CURRENCY,
      rateMicros: BigInt(micros as number),
      validFrom: new Date('2026-01-01'),
    })),
    skipDuplicates: true,
  });
});
afterAll(async () => {
  await t?.close();
  await owner?.$disconnect();
});

interface Scene {
  client: Client;
  orgId: string;
  conversationId: string;
  promoId: string;
  utilityId: string;
  /** Authentication has no rate in this suite. */
  unpricedId: string;
}

/** A funded workspace with a contact, a conversation and approved templates. */
async function scene(
  opts: { balance?: number; windowOpen?: boolean; waId?: string; threshold?: number } = {},
): Promise<Scene> {
  const client = new Client(t.app);
  const { orgId } = await client.signup();
  const ids = await withTenant(owner, { orgId }, async (tx) => {
    const waba = await tx.wabaAccount.create({
      data: { orgId, wabaId: metaId(), templatesSyncedAt: new Date() },
    });
    const id = randomUUID();
    await tx.phoneNumber.create({
      data: {
        id,
        orgId,
        wabaAccountId: waba.id,
        phoneNumberId: metaId(),
        status: 'connected',
        credentialSource: 'manual',
        accessTokenEnc: secrets.encrypt('token', phoneTokenAad(id)),
      },
    });
    const contact = await tx.contact.create({
      data: { orgId, waId: opts.waId ?? INDIA, optInStatus: 'opted_in' },
    });
    const conversation = await tx.conversation.create({
      data: {
        orgId,
        phoneId: id,
        channelId: await whatsappChannelId(tx, id),
        contactId: contact.id,
        windowExpiresAt: opts.windowOpen ? new Date(Date.now() + 3600_000) : null,
      },
    });
    const template = (name: string, category: string) =>
      tx.messageTemplate.create({
        data: {
          orgId,
          wabaAccountId: waba.id,
          name,
          language: 'en',
          category,
          status: 'approved',
          metaTemplateId: metaId(),
          definition: { header: null, body: `Hello from ${name}`, footer: null, buttons: [] },
        },
      });
    const promo = await template('promo', 'MARKETING');
    const utility = await template('notice', 'UTILITY');
    const unpriced = await template('code_like', 'AUTHENTICATION');
    await ensureWallet(tx, orgId, CURRENCY, opts.threshold ?? null);
    if (opts.balance) {
      await creditWallet(tx, {
        orgId,
        amountMicros: opts.balance,
        idempotencyKey: 'seed',
      });
    }
    return {
      conversationId: conversation.id,
      promoId: promo.id,
      utilityId: utility.id,
      unpricedId: unpriced.id,
    };
  });
  return { client, orgId, ...ids };
}

const send = (s: Scene, templateId: string, clientMessageId = randomUUID()) =>
  s.client.post(`/inbox/conversations/${s.conversationId}/messages`, {
    type: 'template',
    clientMessageId,
    templateId,
    variables: {},
  });

const reply = (s: Scene) =>
  s.client.post(`/inbox/conversations/${s.conversationId}/messages`, {
    type: 'text',
    clientMessageId: randomUUID(),
    body: 'Thanks for writing',
  });

const wallet = async (s: Scene) => (await s.client.get('/wallet')).body;

async function agentOf(s: Scene) {
  const email = uniqueEmail('agent');
  await s.client.post('/team/invitations', { email, role: 'agent' });
  const agent = new Client(t.app);
  await agent.post('/invitations/accept', {
    token: tokenFromMail(t.mailer, email),
    name: 'Agent',
    password: 'correct-horse-battery',
  });
  return agent;
}

describe('acceptance: parallel sends over HTTP', () => {
  it('50 sends with funds for 10: exactly 10 go out, and the balance is exactly zero', async () => {
    const s = await scene({ balance: 10_000_000 });
    const results = await Promise.all(Array.from({ length: 50 }, () => send(s, s.promoId)));
    const sent = results.filter((r) => r.status === 201);
    const refused = results.filter((r) => r.status === 402);
    expect(sent).toHaveLength(10);
    expect(refused).toHaveLength(40);
    expect(refused[0]?.body.code).toBe(ErrorCode.INSUFFICIENT_BALANCE);

    const w = await wallet(s);
    expect(w.balanceMicros).toBe(0);

    // Nothing was saved for a refused send, so what is queued is what was paid for.
    const counts = await withTenant(owner, { orgId: s.orgId }, async (tx) => ({
      // By org explicitly: this login is a superuser here, which skips RLS.
      messages: await tx.message.count({ where: { orgId: s.orgId } }),
      debits: await tx.walletLedger.count({ where: { orgId: s.orgId, type: 'debit' } }),
      refs: await tx.messageRef.count({ where: { orgId: s.orgId, kind: 'client' } }),
    }));
    expect(counts).toEqual({ messages: 10, debits: 10, refs: 10 });
  }, 60_000);
});

describe('what a send costs', () => {
  it('charges a marketing template at the rate for the recipient’s country', async () => {
    const s = await scene({ balance: 5_000_000 });
    const res = await send(s, s.promoId);
    expect(res.status).toBe(201);
    expect((await wallet(s)).balanceMicros).toBe(4_000_000);

    const ledger = (await s.client.get('/wallet/ledger')).body.items;
    expect(ledger[0]).toMatchObject({
      type: 'debit',
      amountMicros: -1_000_000,
      balanceAfterMicros: 4_000_000,
      referenceType: 'message',
      referenceId: res.body.id,
      rate: { micros: 1_000_000, country: 'IN', category: 'marketing' },
    });
  });

  it('uses the any-country rate where a country has none', async () => {
    const s = await scene({ balance: 5_000_000, waId: '5511987654321' });
    await send(s, s.promoId);
    expect((await wallet(s)).balanceMicros).toBe(2_000_000);
    const [entry] = (await s.client.get('/wallet/ledger')).body.items;
    expect(entry.rate).toMatchObject({ micros: 3_000_000, country: 'BR' });
  });

  it('a utility template is free inside the window and charged outside it', async () => {
    const open = await scene({ balance: 1_000_000, windowOpen: true });
    expect((await send(open, open.utilityId)).status).toBe(201);
    expect((await wallet(open)).balanceMicros).toBe(1_000_000);

    const closed = await scene({ balance: 1_000_000, windowOpen: false });
    expect((await send(closed, closed.utilityId)).status).toBe(201);
    expect((await wallet(closed)).balanceMicros).toBe(800_000);
  });

  it('a retried request with the same key charges once', async () => {
    const s = await scene({ balance: 5_000_000 });
    const key = randomUUID();
    const first = await send(s, s.promoId, key);
    const again = await send(s, s.promoId, key);
    expect(again.body.id).toBe(first.body.id);
    expect((await wallet(s)).balanceMicros).toBe(4_000_000);
  });

  it('the rate on a past entry does not change when prices do', async () => {
    const s = await scene({ balance: 5_000_000 });
    await send(s, s.promoId);
    await owner.rateCard.create({
      data: {
        country: 'IN',
        category: 'marketing',
        currency: CURRENCY,
        rateMicros: 2_500_000n,
        validFrom: new Date(Date.now() - 1000),
      },
    });
    try {
      await send(s, s.promoId);
      const items = (await s.client.get('/wallet/ledger')).body.items;
      expect(items.map((e: { rate: { micros: number } | null }) => e.rate?.micros ?? null)).toEqual(
        [2_500_000, 1_000_000, null],
      );
    } finally {
      await owner.rateCard.deleteMany({
        where: { country: 'IN', category: 'marketing', currency: CURRENCY, rateMicros: 2_500_000n },
      });
    }
  });
});

describe('blocking', () => {
  it('refuses a paid send at zero balance, and saves nothing', async () => {
    const s = await scene();
    const res = await send(s, s.promoId);
    expect(res.status).toBe(402);
    expect(res.body.code).toBe(ErrorCode.INSUFFICIENT_BALANCE);
    expect(res.body.details).toMatchObject({ availableMicros: 0, neededMicros: 1_000_000 });
    const messages = await withTenant(owner, { orgId: s.orgId }, (tx) =>
      tx.message.count({ where: { orgId: s.orgId } }),
    );
    expect(messages).toBe(0);
  });

  it('the same key can try again after a top-up', async () => {
    const s = await scene();
    const key = randomUUID();
    expect((await send(s, s.promoId, key)).status).toBe(402);
    await withTenant(owner, { orgId: s.orgId }, (tx) =>
      creditWallet(tx, { orgId: s.orgId, amountMicros: 1_000_000, idempotencyKey: 'top-up' }),
    );
    expect((await send(s, s.promoId, key)).status).toBe(201);
  });

  it('free replies to customers keep working at zero balance', async () => {
    const s = await scene({ windowOpen: true });
    expect((await reply(s)).status).toBe(201);
    expect((await send(s, s.utilityId)).status).toBe(201);
    expect((await wallet(s)).balanceMicros).toBe(0);
  });

  it('funds held for a campaign cannot be spent by a single send', async () => {
    const s = await scene({ balance: 2_000_000 });
    await withTenant(owner, { orgId: s.orgId }, (tx) =>
      tx.wallet.update({ where: { orgId: s.orgId }, data: { reservedMicros: 1_500_000n } }),
    );
    const res = await send(s, s.promoId);
    expect(res.status).toBe(402);
    expect((await wallet(s)).availableMicros).toBe(500_000);
  });

  it('refuses a send with no price instead of giving it away', async () => {
    const s = await scene({ balance: 5_000_000 });
    const res = await send(s, s.unpricedId);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe(ErrorCode.RATE_NOT_CONFIGURED);
    expect((await wallet(s)).balanceMicros).toBe(5_000_000);
  });
});

describe('refunds', () => {
  it('gives the money back if the message cannot be queued', async () => {
    const s = await scene({ balance: 5_000_000 });
    const queues = t.app.get(QueuesService);
    const spy = vi.spyOn(queues, 'enqueueOutbound').mockRejectedValueOnce(new Error('Redis down'));
    const res = await send(s, s.promoId);
    spy.mockRestore();
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('failed');
    expect((await wallet(s)).balanceMicros).toBe(5_000_000);
    const row = await withTenant(owner, { orgId: s.orgId }, (tx) =>
      tx.walletLedger.findFirstOrThrow({
        where: { idempotencyKey: `refund:${messageDebitKey(res.body.id)}` },
      }),
    );
    expect(Number(row.amountMicros)).toBe(1_000_000);
  });
});

describe('the template picker', () => {
  it('shows the price for this contact, or that it is free', async () => {
    const s = await scene({ balance: 5_000_000, windowOpen: true });
    const res = await s.client.get(`/inbox/conversations/${s.conversationId}/templates`);
    const by = Object.fromEntries(res.body.map((x: { name: string }) => [x.name, x]));
    expect(by.promo.cost).toEqual({ micros: 1_000_000, currency: CURRENCY });
    expect(by.notice.cost).toEqual({ micros: 0, currency: CURRENCY });
    expect(by.code_like.cost).toBeNull();
    expect(by.code_like.sendIssue).toContain('No price');
  });
});

describe('low balance alert', () => {
  const alerts = (to: string) =>
    t.mailer.sent.filter((m) => m.to === to && m.subject.includes('Low wallet balance'));

  async function ownerEmail(s: Scene) {
    return (await s.client.get('/auth/me')).body.user.email as string;
  }
  const waitFor = async (check: () => boolean) => {
    for (let i = 0; i < 50 && !check(); i++) await new Promise((r) => setTimeout(r, 50));
  };

  it('emails owners once at the crossing, and the wallet reports it', async () => {
    const s = await scene({ balance: 3_000_000, threshold: 2_000_000 });
    const email = await ownerEmail(s);
    await send(s, s.promoId);
    expect((await wallet(s)).lowBalance).toBe(false);
    expect(alerts(email)).toHaveLength(0);

    await send(s, s.promoId);
    await waitFor(() => alerts(email).length > 0);
    expect(alerts(email)).toHaveLength(1);
    expect(alerts(email)[0]?.text).toContain('/wallet');
    expect((await wallet(s)).lowBalance).toBe(true);

    await send(s, s.promoId);
    await new Promise((r) => setTimeout(r, 100));
    expect(alerts(email)).toHaveLength(1);
  });

  it('does not email agents, or owners of other workspaces', async () => {
    const s = await scene({ balance: 2_000_000, threshold: 2_000_000 });
    const email = await ownerEmail(s);
    const other = await scene({ balance: 5_000_000 });
    const otherEmail = await ownerEmail(other);
    await send(s, s.promoId);
    await waitFor(() => alerts(email).length > 0);
    expect(alerts(email)).toHaveLength(1);
    expect(alerts(otherEmail)).toHaveLength(0);
  });

  it('turns off, and a new threshold starts fresh', async () => {
    const s = await scene({ balance: 5_000_000, threshold: 1_000_000 });
    const off = await s.client.patch('/wallet', { lowBalanceThreshold: null });
    expect(off.body.lowBalanceThresholdMicros).toBeNull();
    const on = await s.client.patch('/wallet', { lowBalanceThreshold: '49.50' });
    expect(on.body.lowBalanceThresholdMicros).toBe(49_500_000);
    expect(on.body.lowBalance).toBe(true);
    const bad = await s.client.patch('/wallet', { lowBalanceThreshold: 'lots' });
    expect(bad.status).toBe(400);
  });
});

describe('reading the wallet', () => {
  it('sums usage by category after refunds', async () => {
    const s = await scene({ balance: 10_000_000 });
    const a = await send(s, s.promoId);
    await send(s, s.promoId);
    await send(s, s.utilityId);
    await withTenant(owner, { orgId: s.orgId }, async (tx) => {
      const debit = await tx.walletLedger.findFirstOrThrow({
        where: { idempotencyKey: messageDebitKey(a.body.id) },
      });
      await tx.walletLedger.create({
        data: {
          orgId: s.orgId,
          walletId: debit.walletId,
          type: 'refund',
          amountMicros: -debit.amountMicros,
          balanceAfterMicros: 8_800_000n,
          idempotencyKey: 'test-refund',
          category: debit.category,
        },
      });
    });
    const usage = (await s.client.get('/wallet/usage')).body;
    expect(usage.currency).toBe(CURRENCY);
    expect(usage.rows).toEqual([
      { category: 'marketing', messages: 1, costMicros: 1_000_000 },
      { category: 'utility', messages: 1, costMicros: 200_000 },
    ]);
    expect(usage.totalMicros).toBe(1_200_000);
  });

  it('pages the ledger by cursor and filters it', async () => {
    const s = await scene({ balance: 10_000_000 });
    for (let i = 0; i < 3; i++) await send(s, s.promoId);
    const first = (await s.client.get('/wallet/ledger?limit=2')).body;
    expect(first.items).toHaveLength(2);
    const second = (await s.client.get(`/wallet/ledger?limit=2&cursor=${first.nextCursor}`)).body;
    expect(second.items).toHaveLength(2);
    expect(second.nextCursor).toBeNull();
    const debits = (await s.client.get('/wallet/ledger?type=debit')).body;
    expect(debits.items).toHaveLength(3);
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const none = (await s.client.get(`/wallet/ledger?from=${encodeURIComponent(future)}`)).body;
    expect(none.items).toEqual([]);
  });

  it('exports the ledger as exact decimals, and records that it did', async () => {
    const s = await scene({ balance: 10_000_000 });
    await send(s, s.promoId);
    const res = await t.app.inject({
      method: 'GET',
      url: '/wallet/ledger/export',
      headers: { authorization: `Bearer ${s.client.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    const [header, debit, credit] = res.body.split('\r\n');
    expect(header).toContain('date,type,amount,balance_after,currency,category');
    expect(debit).toContain(`debit,-1,9,${CURRENCY},marketing,IN,1,message`);
    expect(credit).toContain(`credit,10,10,${CURRENCY}`);
    const audit = await s.client.get('/orgs/current/audit-logs?limit=20');
    expect(audit.body.items.map((a: { action: string }) => a.action)).toContain('wallet.exported');
  });

  it('lists current prices only', async () => {
    const s = await scene();
    const rates = (await s.client.get('/wallet/rates')).body;
    expect(rates).toContainEqual(
      expect.objectContaining({ country: 'IN', category: 'marketing', rateMicros: 1_000_000 }),
    );
    expect(
      new Set(rates.map((r: { country: string; category: string }) => r.country + r.category)).size,
    ).toBe(rates.length);
  });
});

describe('permissions and isolation', () => {
  it('has no endpoint that adds money', async () => {
    const s = await scene();
    for (const res of [
      await s.client.post('/wallet/credit', { amount: 1000 }),
      await s.client.post('/wallet', { balanceMicros: 1000 }),
    ]) {
      expect(res.status).toBe(404);
    }
    const patched = await s.client.patch('/wallet', {
      lowBalanceThreshold: '1',
      balanceMicros: 999_000_000,
    });
    expect(patched.body.balanceMicros).toBe(0);
  });

  it('agents cannot see the wallet, but their sends are charged', async () => {
    const s = await scene({ balance: 5_000_000 });
    const agent = await agentOf(s);
    for (const res of [
      await agent.get('/wallet'),
      await agent.get('/wallet/ledger'),
      await agent.get('/wallet/usage'),
      await agent.get('/wallet/ledger/export'),
      await agent.patch('/wallet', { lowBalanceThreshold: '1' }),
    ]) {
      expect(res.status).toBe(403);
    }
    const sent = await agent.post(`/inbox/conversations/${s.conversationId}/messages`, {
      type: 'template',
      clientMessageId: randomUUID(),
      templateId: s.promoId,
      variables: {},
    });
    expect(sent.status).toBe(201);
    expect((await wallet(s)).balanceMicros).toBe(4_000_000);
  });

  it('admins can read but not change settings', async () => {
    const s = await scene();
    const email = uniqueEmail('admin');
    await s.client.post('/team/invitations', { email, role: 'admin' });
    const admin = new Client(t.app);
    await admin.post('/invitations/accept', {
      token: tokenFromMail(t.mailer, email),
      name: 'Admin',
      password: 'correct-horse-battery',
    });
    expect((await admin.get('/wallet')).status).toBe(200);
    expect((await admin.patch('/wallet', { lowBalanceThreshold: '1' })).status).toBe(403);
  });

  it('one workspace sees only its own money', async () => {
    const a = await scene({ balance: 5_000_000 });
    const b = await scene({ balance: 1_000_000 });
    await send(a, a.promoId);
    expect((await wallet(a)).balanceMicros).toBe(4_000_000);
    expect((await wallet(b)).balanceMicros).toBe(1_000_000);
    const items = (await b.client.get('/wallet/ledger')).body.items;
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe('credit');
    expect((await b.client.get('/wallet/usage')).body.rows).toEqual([]);
  });
});
