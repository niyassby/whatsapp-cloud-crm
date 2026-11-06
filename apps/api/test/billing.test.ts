/** Billing over real HTTP. Providers are real adapters talking to a scripted fetch. */
import { createHmac, randomUUID } from 'node:crypto';
import { RazorpayProvider, StripeProvider } from '@wacrm/billing';
import { createPrismaClient, type DbClient, withTenant } from '@wacrm/db';
import { ErrorCode } from '@wacrm/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueuesService } from '../src/infra/queues.service';
import { buildApp, Client, type TestApp, tokenFromMail, uniqueEmail, urls } from './helpers';

const WHSEC = 'whsec_test';
const RZP_SECRET = 'rzp_hook_secret';
const CURRENCY = 'INR';

let t: TestApp;
let owner: DbClient;
const calls: { url: string; method: string; body: string }[] = [];
let answer: { status: number; body: object } = {
  status: 200,
  body: { id: 'cs_1', url: 'https://pay.test/cs_1', short_url: 'https://rzp.test/1' },
};

const fakeFetch = (async (url: string, init: RequestInit) => {
  calls.push({ url, method: init.method ?? 'GET', body: String(init.body ?? '') });
  return new Response(JSON.stringify(answer.body), { status: answer.status });
}) as unknown as typeof fetch;

beforeAll(async () => {
  t = await buildApp({
    env: { WALLET_DEFAULT_CURRENCY: CURRENCY, WALLET_LOW_BALANCE_DEFAULT: '0' },
    payments: {
      stripe: new StripeProvider({ secretKey: 'sk', webhookSecret: WHSEC, fetch: fakeFetch }),
      razorpay: new RazorpayProvider({
        keyId: 'k',
        keySecret: 's',
        webhookSecret: RZP_SECRET,
        fetch: fakeFetch,
      }),
    },
  });
  owner = createPrismaClient({ connectionString: urls.directUrl });
  const starter = await owner.plan.findUniqueOrThrow({ where: { code: 'starter' } });
  const scale = await owner.plan.findUniqueOrThrow({ where: { code: 'scale' } });
  await owner.planPrice.createMany({
    data: [
      {
        planId: starter.id,
        currency: CURRENCY,
        interval: 'month',
        amountMicros: 2499_000_000n,
        stripePriceId: 'price_starter',
        razorpayPlanId: 'plan_starter',
      },
      {
        planId: scale.id,
        currency: CURRENCY,
        interval: 'month',
        amountMicros: 9999_000_000n,
        stripePriceId: 'price_scale',
      },
    ],
    skipDuplicates: true,
  });
});
afterAll(async () => {
  await t?.close();
  await owner?.$disconnect();
});
beforeEach(() => {
  calls.length = 0;
  answer = {
    status: 200,
    body: { id: 'cs_1', url: 'https://pay.test/cs_1', short_url: 'https://rzp.test/1' },
  };
});

async function workspace() {
  const client = new Client(t.app);
  const { orgId } = await client.signup();
  return { client, orgId };
}

const setPlan = (orgId: string, code: string, over: object = {}) =>
  owner.plan.findUniqueOrThrow({ where: { code } }).then((plan) =>
    owner.subscription.update({
      where: { orgId },
      data: { planId: plan.id, status: 'active', trialEndsAt: null, ...over },
    }),
  );

const invite = (client: Client, email = uniqueEmail()) =>
  client.post('/team/invitations', { email, role: 'agent' });

const stripeWebhook = (body: string, secret = WHSEC) => {
  const at = Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', secret).update(`${at}.${body}`).digest('hex');
  return t.app.inject({
    method: 'POST',
    url: '/webhooks/stripe',
    headers: { 'content-type': 'application/json', 'stripe-signature': `t=${at},v1=${signature}` },
    payload: body,
  });
};

describe('signup', () => {
  it('starts a trial of the trial plan', async () => {
    const { client } = await workspace();
    const { body } = await client.get('/billing/summary');
    expect(body).toMatchObject({
      status: 'trialing',
      plan: { code: 'growth' },
      hasPaidSubscription: false,
      currency: CURRENCY,
      usage: { seats: 1, numbers: 0, contacts: 0 },
    });
    const days = (new Date(body.trialEndsAt).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(13);
    expect(days).toBeLessThanOrEqual(14);
  });

  it('a new organization gets its own trial', async () => {
    const { client } = await workspace();
    const created = await client.post('/orgs', { name: 'Second' });
    const row = await owner.subscription.findUnique({ where: { orgId: created.body.id } });
    expect(row?.status).toBe('trialing');
  });
});

describe('plans', () => {
  it('lists public plans in the workspace currency, saying who can take each price', async () => {
    const { client } = await workspace();
    const { body } = await client.get('/billing/plans');
    expect(body.map((p: { code: string }) => p.code)).toEqual(['starter', 'growth', 'scale']);
    const starter = body.find((p: { code: string }) => p.code === 'starter');
    expect(starter.prices).toEqual([
      {
        currency: CURRENCY,
        interval: 'month',
        amountMicros: 2499_000_000,
        providers: ['razorpay', 'stripe'],
      },
    ]);
  });
});

describe('subscription checkout', () => {
  it('opens the local provider for the currency, and changes nothing yet', async () => {
    const { client, orgId } = await workspace();
    const res = await client.post('/billing/checkout', { planCode: 'starter', interval: 'month' });
    expect(res.status).toBe(200);
    expect(res.body.url).toBe('https://rzp.test/1');
    expect(calls[0]!.url).toContain('razorpay.com/v1/subscriptions');
    expect(JSON.parse(calls[0]!.body)).toMatchObject({
      plan_id: 'plan_starter',
      notes: { orgId },
    });
    const { body } = await client.get('/billing/summary');
    expect(body.status).toBe('trialing');
    expect(body.plan.code).toBe('growth');
  });

  it('a price only one provider has goes to that provider', async () => {
    const { client } = await workspace();
    const res = await client.post('/billing/checkout', { planCode: 'scale', interval: 'month' });
    expect(res.body.url).toBe('https://pay.test/cs_1');
    expect(calls[0]!.url).toContain('stripe.com/v1/checkout/sessions');
  });

  it('honors a chosen provider', async () => {
    const { client } = await workspace();
    await client.post('/billing/checkout', {
      planCode: 'starter',
      interval: 'month',
      provider: 'stripe',
    });
    expect(calls[0]!.url).toContain('stripe.com');
  });

  it('someone already paying changes plan with their provider, without a new checkout', async () => {
    const { client, orgId } = await workspace();
    await setPlan(orgId, 'starter', { provider: 'stripe', providerSubscriptionId: 'sub_1' });
    answer = { status: 200, body: { items: { data: [{ id: 'si_1' }] } } };
    const res = await client.post('/billing/checkout', { planCode: 'scale', interval: 'month' });
    expect(res.body.url).toBeNull();
    expect(calls.at(-1)!.url).toContain('/v1/subscriptions/sub_1');
    expect(calls.at(-1)!.body).toContain('price_scale');
    // Still the old plan: only the provider's webhook moves it.
    expect((await client.get('/billing/summary')).body.plan.code).toBe('starter');
  });

  it('refuses a price that is not set up, and an unknown plan', async () => {
    const { client } = await workspace();
    const noPrice = await client.post('/billing/checkout', {
      planCode: 'starter',
      interval: 'year',
    });
    expect(noPrice.body.code).toBe(ErrorCode.BILLING_PRICE_UNAVAILABLE);
    const unknown = await client.post('/billing/checkout', {
      planCode: 'nope',
      interval: 'month',
    });
    expect(unknown.status).toBe(404);
    // Free cannot be bought.
    const free = await client.post('/billing/checkout', { planCode: 'free', interval: 'month' });
    expect(free.status).toBe(404);
    expect(calls).toEqual([]);
  });

  it('a provider refusal has a stable code and its message', async () => {
    const { client } = await workspace();
    answer = { status: 400, body: { error: { description: 'Bad plan' } } };
    const res = await client.post('/billing/checkout', { planCode: 'starter', interval: 'month' });
    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ code: ErrorCode.PAYMENT_PROVIDER_ERROR, message: 'Bad plan' });
  });
});

describe('cancel and manage payment', () => {
  it('needs a paid subscription', async () => {
    const { client } = await workspace();
    expect((await client.post('/billing/cancel')).status).toBe(409);
    expect((await client.post('/billing/manage-payment')).body.url).toBeNull();
  });

  it('cancels at period end, and keeps the plan', async () => {
    const { client, orgId } = await workspace();
    await setPlan(orgId, 'starter', {
      provider: 'razorpay',
      providerSubscriptionId: 'sub_2',
      currentPeriodEnd: new Date(Date.now() + 86_400_000),
    });
    expect((await client.post('/billing/cancel')).status).toBe(204);
    expect(JSON.parse(calls[0]!.body)).toEqual({ cancel_at_cycle_end: true });
    const { body } = await client.get('/billing/summary');
    expect(body).toMatchObject({ cancelAtPeriodEnd: true, status: 'active' });
    expect(body.plan.code).toBe('starter');
  });

  it('links to the provider’s page', async () => {
    const { client, orgId } = await workspace();
    await setPlan(orgId, 'starter', {
      provider: 'stripe',
      providerSubscriptionId: 'sub_3',
      providerCustomerId: 'cus_3',
    });
    answer = { status: 200, body: { url: 'https://portal.test' } };
    const res = await client.post('/billing/manage-payment');
    expect(res.body.url).toBe('https://portal.test');
    expect(calls[0]!.url).toContain('/v1/billing_portal/sessions');
  });
});

describe('top-ups', () => {
  const wallet = (client: Client) => client.get('/wallet').then((r) => r.body);
  const withCountry = (client: Client, country: string | null) =>
    client.patch('/billing/profile', {
      billingName: 'Acme',
      billingEmail: 'bills@acme.test',
      billingAddress: null,
      billingCountry: country,
      taxId: null,
    });

  it('quotes tax on top for the billing country', async () => {
    const { client } = await workspace();
    await withCountry(client, 'in');
    const { body } = await client.get('/billing/topup-quote?amount=1000');
    expect(body).toEqual({
      currency: CURRENCY,
      creditMicros: 1000_000_000,
      taxMicros: 180_000_000,
      taxRateBps: 1800,
      taxLabel: 'GST',
      totalMicros: 1180_000_000,
    });
  });

  it('with no tax rate, the amount is the total', async () => {
    const { client } = await workspace();
    const { body } = await client.get('/billing/topup-quote?amount=1000');
    expect(body).toMatchObject({ taxMicros: 0, totalMicros: 1000_000_000, taxLabel: null });
  });

  it('opens a payment for the total, and moves no money', async () => {
    const { client, orgId } = await workspace();
    await withCountry(client, 'IN');
    answer = { status: 200, body: { id: 'plink_9', short_url: 'https://rzp.test/9' } };
    const res = await client.post('/billing/topups', { amount: '1000' });
    expect(res.body.url).toBe('https://rzp.test/9');
    const sent = JSON.parse(calls[0]!.body);
    expect(sent).toMatchObject({ amount: 118000, currency: CURRENCY, notes: { orgId } });
    expect((await wallet(client)).balanceMicros).toBe(0);
    const row = await owner.walletTopup.findFirstOrThrow({ where: { orgId } });
    expect(row).toMatchObject({
      status: 'created',
      providerRef: 'plink_9',
      creditMicros: 1000_000_000n,
      totalMicros: 1180_000_000n,
    });
    expect(sent.reference_id).toBe(row.id);
  });

  it('a refused payment page is recorded as failed', async () => {
    const { client, orgId } = await workspace();
    answer = { status: 400, body: { error: { description: 'Nope' } } };
    const res = await client.post('/billing/topups', { amount: '10' });
    expect(res.status).toBe(502);
    const row = await owner.walletTopup.findFirstOrThrow({ where: { orgId } });
    expect(row).toMatchObject({ status: 'failed', failure: 'Nope' });
  });

  it('refuses a silly amount', async () => {
    const { client } = await workspace();
    expect((await client.post('/billing/topups', { amount: '0' })).status).toBe(400);
    expect(calls).toEqual([]);
  });
});

describe('webhooks', () => {
  const event = (id = `evt_${randomUUID()}`) =>
    JSON.stringify({ id, type: 'invoice.paid', data: { object: {} } });

  it('refuses a bad signature, stores nothing and queues nothing', async () => {
    const spy = vi.spyOn(t.app.get(QueuesService), 'enqueueBillingEvent');
    const body = event();
    const res = await stripeWebhook(body, 'whsec_wrong');
    expect(res.statusCode).toBe(401);
    expect(spy).not.toHaveBeenCalled();
    const stored = await owner.billingEvent.count({
      where: { eventId: JSON.parse(body).id as string },
    });
    expect(stored).toBe(0);
    spy.mockRestore();
  });

  it('refuses an unsigned one', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      headers: { 'content-type': 'application/json' },
      payload: event(),
    });
    expect(res.statusCode).toBe(401);
  });

  it('stores once and answers 200, however often it arrives', async () => {
    const spy = vi.spyOn(t.app.get(QueuesService), 'enqueueBillingEvent');
    const id = `evt_${randomUUID()}`;
    const body = event(id);
    expect((await stripeWebhook(body)).statusCode).toBe(200);
    expect((await stripeWebhook(body)).statusCode).toBe(200);
    expect(await owner.billingEvent.count({ where: { eventId: id } })).toBe(1);
    const row = await owner.billingEvent.findFirstOrThrow({ where: { eventId: id } });
    // Queued again while still unprocessed, in case the first attempt died. The job id dedupes it.
    expect(spy).toHaveBeenCalledWith(row.id);
    spy.mockRestore();
  });

  it('a processed event is not queued again', async () => {
    const spy = vi.spyOn(t.app.get(QueuesService), 'enqueueBillingEvent');
    const id = `evt_${randomUUID()}`;
    const body = event(id);
    await stripeWebhook(body);
    await owner.billingEvent.updateMany({ where: { eventId: id }, data: { status: 'processed' } });
    spy.mockClear();
    await stripeWebhook(body);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('checks Razorpay with its own secret, and uses its event id', async () => {
    const id = `rzp_${randomUUID()}`;
    const body = JSON.stringify({ event: 'payment_link.paid', payload: {} });
    const send = (secret: string) =>
      t.app.inject({
        method: 'POST',
        url: '/webhooks/razorpay',
        headers: {
          'content-type': 'application/json',
          'x-razorpay-signature': createHmac('sha256', secret).update(body).digest('hex'),
          'x-razorpay-event-id': id,
        },
        payload: body,
      });
    expect((await send('wrong')).statusCode).toBe(401);
    expect((await send(RZP_SECRET)).statusCode).toBe(200);
    expect(await owner.billingEvent.count({ where: { provider: 'razorpay', eventId: id } })).toBe(
      1,
    );
  });
});

describe('plan limits', () => {
  it('stops inviting at the seat limit, counting pending invites', async () => {
    const { client, orgId } = await workspace();
    await setPlan(orgId, 'starter');
    expect((await invite(client)).status).toBe(201);
    expect((await invite(client)).status).toBe(201);
    const third = await invite(client);
    expect(third.status).toBe(402);
    expect(third.body.code).toBe(ErrorCode.PLAN_LIMIT_REACHED);
    expect((await client.get('/billing/summary')).body.usage.seats).toBe(3);
  });

  it('re-inviting the same person does not use another seat', async () => {
    const { client, orgId } = await workspace();
    await setPlan(orgId, 'starter');
    const email = uniqueEmail();
    await invite(client);
    await invite(client, email);
    expect((await invite(client, email)).status).toBe(201);
  });

  it('stops adding contacts at the limit', async () => {
    const { client, orgId } = await workspace();
    await setPlan(orgId, 'free');
    await withTenant(owner, { orgId }, (tx) =>
      tx.contact.createMany({
        data: Array.from({ length: 250 }, (_, i) => ({
          orgId,
          waId: String(910000000000 + i),
        })),
      }),
    );
    const res = await client.post('/contacts', { phone: '+919876543210' });
    expect(res.status).toBe(402);
    expect(res.body.code).toBe(ErrorCode.PLAN_LIMIT_REACHED);
  });

  it('stops connecting another number at the limit, before any call to Meta', async () => {
    const { client, orgId } = await workspace();
    await setPlan(orgId, 'free');
    await withTenant(owner, { orgId }, async (tx) => {
      const waba = await tx.wabaAccount.create({ data: { orgId, wabaId: randomUUID() } });
      await tx.phoneNumber.create({
        data: {
          orgId,
          wabaAccountId: waba.id,
          phoneNumberId: randomUUID(),
          status: 'connected',
          credentialSource: 'manual',
        },
      });
    });
    const res = await client.post('/whatsapp/manual-connect', {
      accessToken: 'a-token-long-enough-to-pass-validation',
      wabaId: '100000000000001',
      phoneNumberId: '200000000000001',
    });
    expect(res.status).toBe(402);
  });

  it('an expired trial falls to Free: over-limit data stays, adding more stops', async () => {
    const { client, orgId } = await workspace();
    await invite(client);
    await owner.subscription.update({
      where: { orgId },
      data: { trialEndsAt: new Date(Date.now() - 1000) },
    });
    const { body } = await client.get('/billing/summary');
    expect(body).toMatchObject({
      status: 'expired',
      plan: { code: 'free' },
      subscribedPlanCode: 'growth',
      usage: { seats: 2 },
    });
    expect((await invite(client)).status).toBe(402);
    // The team still exists and can be read.
    expect((await client.get('/team/members')).status).toBe(200);
  });
});

describe('plan features', () => {
  const body = (phoneId: string, templateId: string) => ({
    name: 'Sale',
    phoneId,
    templateId,
  });

  it('a plan without campaigns cannot start one, but can still read old ones', async () => {
    const { client, orgId } = await workspace();
    await setPlan(orgId, 'free');
    const res = await client.post('/campaigns', body(randomUUID(), randomUUID()));
    expect(res.status).toBe(402);
    expect(res.body).toMatchObject({
      code: ErrorCode.PLAN_FEATURE_UNAVAILABLE,
      details: { feature: 'campaigns' },
    });
    expect((await client.get('/campaigns')).status).toBe(200);
  });

  it('Starter has campaigns but not drips', async () => {
    const { client, orgId } = await workspace();
    await setPlan(orgId, 'starter');
    const campaign = await client.post('/campaigns', body(randomUUID(), randomUUID()));
    expect(campaign.body.code).not.toBe(ErrorCode.PLAN_FEATURE_UNAVAILABLE);
    const drip = await client.post('/drips', {
      name: 'Welcome',
      phoneId: randomUUID(),
      steps: [{ delayMinutes: 0, templateId: randomUUID() }],
    });
    expect(drip.body.code).toBe(ErrorCode.PLAN_FEATURE_UNAVAILABLE);
  });
});

describe('invoices', () => {
  async function withInvoice() {
    const s = await workspace();
    const invoice = await withTenant(owner, { orgId: s.orgId }, (tx) =>
      tx.invoice.create({
        data: {
          orgId: s.orgId,
          number: `INV-TEST-${randomUUID().slice(0, 8)}`,
          kind: 'topup',
          provider: 'stripe',
          providerRef: randomUUID(),
          description: 'Wallet top-up',
          currency: CURRENCY,
          subtotalMicros: 1000_000_000n,
          taxMicros: 180_000_000n,
          taxRateBps: 1800,
          taxLabel: 'GST',
          totalMicros: 1180_000_000n,
          billTo: { name: 'Acme', taxId: 'GST123' },
        },
      }),
    );
    return { ...s, invoice };
  }
  const pdf = (client: Client, id: string) =>
    t.app.inject({
      method: 'GET',
      url: `/billing/invoices/${id}/pdf`,
      headers: { authorization: `Bearer ${client.accessToken}` },
    });

  it('lists them with tax fields', async () => {
    const { client, invoice } = await withInvoice();
    const { body } = await client.get('/billing/invoices');
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      id: invoice.id,
      subtotalMicros: 1000_000_000,
      taxMicros: 180_000_000,
      taxLabel: 'GST',
      totalMicros: 1180_000_000,
    });
  });

  it('downloads a real PDF', async () => {
    const { client, invoice } = await withInvoice();
    const res = await pdf(client, invoice.id);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toContain(invoice.number);
    expect(res.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    expect(res.rawPayload.length).toBeGreaterThan(500);
  });

  it('another workspace cannot see or download it', async () => {
    const { invoice } = await withInvoice();
    const other = await workspace();
    expect((await pdf(other.client, invoice.id)).statusCode).toBe(404);
    expect((await other.client.get('/billing/invoices')).body.items).toEqual([]);
  });
});

describe('access', () => {
  it('agents see no billing; admins can read but not pay', async () => {
    const { client } = await workspace();
    const member = async (role: string) => {
      const email = uniqueEmail();
      await client.post('/team/invitations', { email, role });
      const c = new Client(t.app);
      await c.post('/invitations/accept', {
        token: tokenFromMail(t.mailer, email),
        name: 'Someone',
        password: 'correct-horse-battery',
      });
      return c;
    };
    const agent = await member('agent');
    expect((await agent.get('/billing/summary')).status).toBe(403);
    expect((await agent.post('/billing/topups', { amount: '10' })).status).toBe(403);

    const admin = await member('admin');
    expect((await admin.get('/billing/summary')).status).toBe(200);
    expect((await admin.get('/billing/invoices')).status).toBe(200);
    expect((await admin.post('/billing/topups', { amount: '10' })).status).toBe(403);
    expect(
      (await admin.post('/billing/checkout', { planCode: 'starter', interval: 'month' })).status,
    ).toBe(403);
    expect(calls).toEqual([]);
  });
});
