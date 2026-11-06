/** Pins what is sent to each provider and how its events are read. Payloads follow their docs. */
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createPaymentProviders,
  providersForCurrency,
  RazorpayProvider,
  StripeProvider,
} from '../src';

const NOW = 1_800_000_000_000;

function scripted(answer: unknown = {}, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(answer), { status });
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

const stripe = (fetchFn?: typeof fetch) =>
  new StripeProvider({
    secretKey: 'sk_test_x',
    webhookSecret: 'whsec_x',
    fetch: fetchFn,
    now: () => NOW,
  });

const razorpay = (fetchFn?: typeof fetch) =>
  new RazorpayProvider({
    keyId: 'rzp_test_x',
    keySecret: 'secret',
    webhookSecret: 'hook-secret',
    fetch: fetchFn,
  });

const stripeSignature = (body: string, at = NOW / 1000, secret = 'whsec_x') =>
  `t=${at},v1=${createHmac('sha256', secret).update(`${at}.${body}`).digest('hex')}`;

const rzpSignature = (body: string, secret = 'hook-secret') =>
  createHmac('sha256', secret).update(body).digest('hex');

describe('Stripe webhook signatures', () => {
  const body = JSON.stringify({ id: 'evt_1', type: 'invoice.paid', data: { object: {} } });
  const verify = (header: string | undefined, raw = body) =>
    stripe().verifyWebhook(Buffer.from(raw), { 'stripe-signature': header });

  it('accepts the right signature and reads the event', () => {
    expect(verify(stripeSignature(body))).toMatchObject({ eventId: 'evt_1', type: 'invoice.paid' });
  });

  it('accepts when one of several signatures matches, as during a secret roll', () => {
    const good = stripeSignature(body).split(',v1=')[1];
    const at = NOW / 1000;
    expect(verify(`t=${at},v1=${'0'.repeat(64)},v1=${good}`)).not.toBeNull();
  });

  it('refuses a missing, wrong or tampered signature', () => {
    expect(verify(undefined)).toBeNull();
    expect(verify('garbage')).toBeNull();
    expect(verify(stripeSignature(body, NOW / 1000, 'whsec_other'))).toBeNull();
    expect(verify(stripeSignature(body), body.replace('evt_1', 'evt_2'))).toBeNull();
  });

  it('refuses an old signature, so a captured request cannot be replayed', () => {
    expect(verify(stripeSignature(body, NOW / 1000 - 301))).toBeNull();
    expect(verify(stripeSignature(body, NOW / 1000 - 299))).not.toBeNull();
  });

  it('ignores the fake v0 scheme', () => {
    const v1 = stripeSignature(body).split('v1=')[1];
    expect(verify(`t=${NOW / 1000},v0=${v1}`)).toBeNull();
  });
});

describe('Stripe events', () => {
  const session = (over: object) => ({
    data: {
      object: {
        id: 'cs_1',
        mode: 'payment',
        payment_status: 'paid',
        payment_intent: 'pi_1',
        amount_total: 118000,
        currency: 'inr',
        metadata: { orgId: 'org', topupId: 'top' },
        ...over,
      },
    },
  });

  it('a paid checkout is a paid top-up, in micros', () => {
    expect(stripe().parseEvent('checkout.session.completed', session({}))).toEqual([
      {
        kind: 'topup.paid',
        topupId: 'top',
        orgId: 'org',
        providerRef: 'cs_1',
        paymentRef: 'pi_1',
        amountMicros: 1180_000_000,
        currency: 'INR',
      },
    ]);
  });

  it('a completed checkout that has not been paid is not a payment', () => {
    expect(
      stripe().parseEvent('checkout.session.completed', session({ payment_status: 'unpaid' })),
    ).toEqual([]);
  });

  it('a delayed payment counts when it succeeds', () => {
    expect(
      stripe().parseEvent('checkout.session.async_payment_succeeded', session({})),
    ).toHaveLength(1);
  });

  it('a subscription checkout moves no money by itself', () => {
    expect(
      stripe().parseEvent('checkout.session.completed', session({ mode: 'subscription' })),
    ).toEqual([]);
  });

  it('zero-decimal currencies are not divided by 100', () => {
    const [ev] = stripe().parseEvent(
      'checkout.session.completed',
      session({ currency: 'jpy', amount_total: 500 }),
    );
    expect(ev).toMatchObject({ amountMicros: 500_000_000, currency: 'JPY' });
  });

  it('a subscription event carries no state, only that something changed', () => {
    expect(
      stripe().parseEvent('customer.subscription.updated', {
        data: { object: { id: 'sub_1', status: 'active', metadata: { orgId: 'org' } } },
      }),
    ).toEqual([{ kind: 'subscription.changed', subscriptionRef: 'sub_1', orgId: 'org' }]);
  });

  const invoice = (over: object) => ({
    data: {
      object: {
        id: 'in_1',
        currency: 'inr',
        amount_paid: 249900,
        parent: {
          type: 'subscription_details',
          subscription_details: { subscription: 'sub_1', metadata: { orgId: 'org' } },
        },
        lines: { data: [{ period: { start: 1000, end: 2000 } }] },
        ...over,
      },
    },
  });

  it('a paid invoice reads the subscription from where current versions put it', () => {
    expect(stripe().parseEvent('invoice.paid', invoice({}))).toEqual([
      { kind: 'subscription.changed', subscriptionRef: 'sub_1', orgId: 'org' },
      {
        kind: 'subscription.paid',
        subscriptionRef: 'sub_1',
        orgId: 'org',
        paymentRef: 'in_1',
        amountMicros: 2499_000_000,
        currency: 'INR',
        periodStart: new Date(1000_000),
        periodEnd: new Date(2000_000),
      },
    ]);
  });

  it('also reads the older shape, which older webhook endpoints still send', () => {
    const events = stripe().parseEvent(
      'invoice.paid',
      invoice({ parent: null, subscription: 'sub_old' }),
    );
    expect(events[0]).toMatchObject({ subscriptionRef: 'sub_old' });
  });

  it('an invoice for nothing bills nothing', () => {
    expect(stripe().parseEvent('invoice.paid', invoice({ amount_paid: 0 }))).toEqual([
      { kind: 'subscription.changed', subscriptionRef: 'sub_1', orgId: 'org' },
    ]);
  });

  it('other events are ignored', () => {
    expect(stripe().parseEvent('customer.created', { data: { object: {} } })).toEqual([]);
  });
});

describe('Stripe requests', () => {
  const form = (call: { init: RequestInit }) => new URLSearchParams(String(call.init.body));

  it('a top-up sends minor units, metadata and an idempotency key, with the version pinned', async () => {
    const { calls, fetchFn } = scripted({ id: 'cs_1', url: 'https://pay' });
    const res = await stripe(fetchFn).createTopupCheckout({
      topupId: 'top',
      orgId: 'org',
      totalMicros: 1180_000_000,
      currency: 'INR',
      description: 'Wallet top-up',
      customerEmail: 'a@b.test',
      successUrl: 'https://app/ok',
      cancelUrl: 'https://app/no',
    });
    expect(res).toEqual({ url: 'https://pay', providerRef: 'cs_1' });
    const call = calls[0]!;
    expect(call.url).toBe('https://api.stripe.com/v1/checkout/sessions');
    const headers = call.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer sk_test_x');
    expect(headers['stripe-version']).toBeTruthy();
    expect(headers['idempotency-key']).toBe('topup-top');
    const body = form(call);
    expect(body.get('mode')).toBe('payment');
    expect(body.get('line_items[0][price_data][unit_amount]')).toBe('118000');
    expect(body.get('line_items[0][price_data][currency]')).toBe('inr');
    expect(body.get('metadata[topupId]')).toBe('top');
    expect(body.get('metadata[orgId]')).toBe('org');
  });

  it('a subscription puts the org on the subscription too, so its events can find it', async () => {
    const { calls, fetchFn } = scripted({ id: 'cs_2', url: 'https://pay' });
    await stripe(fetchFn).createSubscriptionCheckout({
      orgId: 'org',
      priceRef: 'price_1',
      interval: 'month',
      customerRef: null,
      customerEmail: 'a@b.test',
      successUrl: 'https://app/ok',
      cancelUrl: 'https://app/no',
    });
    const body = form(calls[0]!);
    expect(body.get('mode')).toBe('subscription');
    expect(body.get('subscription_data[metadata][orgId]')).toBe('org');
    expect(body.get('line_items[0][price]')).toBe('price_1');
  });

  it('reads the period from the item, where current versions keep it', async () => {
    const { fetchFn } = scripted({
      status: 'past_due',
      customer: 'cus_1',
      cancel_at_period_end: true,
      metadata: { orgId: 'org' },
      items: {
        data: [
          {
            id: 'si_1',
            price: { id: 'price_1' },
            current_period_start: 10,
            current_period_end: 20,
          },
        ],
      },
    });
    expect(await stripe(fetchFn).getSubscription('sub_1')).toEqual({
      ref: 'sub_1',
      customerRef: 'cus_1',
      status: 'past_due',
      priceRef: 'price_1',
      periodStart: new Date(10_000),
      periodEnd: new Date(20_000),
      cancelAtPeriodEnd: true,
      orgId: 'org',
    });
  });

  it('turns a refusal into an error that can be shown, without the key', async () => {
    const { fetchFn } = scripted({ error: { message: 'No such price' } }, 400);
    const call = stripe(fetchFn).getSubscription('sub_1');
    await expect(call).rejects.toMatchObject({ message: 'No such price', retryable: false });
    const down = scripted({}, 503);
    await expect(stripe(down.fetchFn).getSubscription('sub_1')).rejects.toMatchObject({
      retryable: true,
    });
  });
});

describe('Razorpay webhook signatures', () => {
  const body = JSON.stringify({ event: 'payment_link.paid', payload: {} });
  const verify = (headers: Record<string, string>, raw = body) =>
    razorpay().verifyWebhook(Buffer.from(raw), headers);

  it('uses the event id header', () => {
    expect(
      verify({ 'x-razorpay-signature': rzpSignature(body), 'x-razorpay-event-id': 'ev_1' }),
    ).toMatchObject({ eventId: 'ev_1', type: 'payment_link.paid' });
  });

  it('still dedupes a redelivery with no event id, on the body', () => {
    const a = verify({ 'x-razorpay-signature': rzpSignature(body) });
    const b = verify({ 'x-razorpay-signature': rzpSignature(body) });
    expect(a?.eventId).toBeTruthy();
    expect(a?.eventId).toBe(b?.eventId);
  });

  it('refuses a missing, wrong or tampered signature', () => {
    expect(verify({})).toBeNull();
    expect(verify({ 'x-razorpay-signature': 'zz' })).toBeNull();
    expect(verify({ 'x-razorpay-signature': rzpSignature(body, 'other') })).toBeNull();
    expect(verify({ 'x-razorpay-signature': rzpSignature(body) }, `${body} `)).toBeNull();
  });
});

describe('Razorpay events', () => {
  const paid = (link: object = {}, payment: object = {}) => ({
    payload: {
      payment_link: {
        entity: {
          id: 'plink_1',
          status: 'paid',
          reference_id: 'top',
          amount_paid: 118000,
          currency: 'INR',
          notes: null,
          ...link,
        },
      },
      payment: {
        entity: {
          id: 'pay_1',
          status: 'captured',
          amount: 118000,
          currency: 'INR',
          notes: [],
          ...payment,
        },
      },
    },
  });

  it('finds the top-up from the link reference, since notes are unreliable', () => {
    expect(razorpay().parseEvent('payment_link.paid', paid())).toEqual([
      {
        kind: 'topup.paid',
        topupId: 'top',
        orgId: null,
        providerRef: 'plink_1',
        paymentRef: 'pay_1',
        amountMicros: 1180_000_000,
        currency: 'INR',
      },
    ]);
  });

  it('reads the org from notes when they are there', () => {
    const [ev] = razorpay().parseEvent('payment_link.paid', paid({ notes: { orgId: 'org' } }));
    expect(ev).toMatchObject({ orgId: 'org' });
  });

  it('a payment that was not captured is not paid', () => {
    expect(razorpay().parseEvent('payment_link.paid', paid({}, { status: 'authorized' }))).toEqual(
      [],
    );
    expect(razorpay().parseEvent('payment_link.paid', paid({ status: 'created' }))).toEqual([]);
  });

  const sub = { id: 'sub_1', notes: { orgId: 'org' }, current_start: 10, current_end: 20 };

  it('a charge bills the period, and also says the subscription changed', () => {
    expect(
      razorpay().parseEvent('subscription.charged', {
        payload: {
          subscription: { entity: sub },
          payment: { entity: { id: 'pay_2', amount: 249900, currency: 'INR' } },
        },
      }),
    ).toEqual([
      { kind: 'subscription.changed', subscriptionRef: 'sub_1', orgId: 'org' },
      {
        kind: 'subscription.paid',
        subscriptionRef: 'sub_1',
        orgId: 'org',
        paymentRef: 'pay_2',
        amountMicros: 2499_000_000,
        currency: 'INR',
        periodStart: new Date(10_000),
        periodEnd: new Date(20_000),
      },
    ]);
  });

  it('other subscription events only say it changed', () => {
    expect(
      razorpay().parseEvent('subscription.halted', { payload: { subscription: { entity: sub } } }),
    ).toEqual([{ kind: 'subscription.changed', subscriptionRef: 'sub_1', orgId: 'org' }]);
  });
});

describe('Razorpay requests', () => {
  const sent = (call: { init: RequestInit }) => JSON.parse(String(call.init.body)) as object;

  it('a top-up is a payment link keyed by the top-up', async () => {
    const { calls, fetchFn } = scripted({ id: 'plink_1', short_url: 'https://rzp' });
    const res = await razorpay(fetchFn).createTopupCheckout({
      topupId: 'top',
      orgId: 'org',
      totalMicros: 1180_000_000,
      currency: 'INR',
      description: 'Wallet top-up',
      customerEmail: null,
      successUrl: 'https://app/ok',
      cancelUrl: 'https://app/no',
    });
    expect(res).toEqual({ url: 'https://rzp', providerRef: 'plink_1' });
    expect(calls[0]!.url).toBe('https://api.razorpay.com/v1/payment_links');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(
      `Basic ${Buffer.from('rzp_test_x:secret').toString('base64')}`,
    );
    expect(sent(calls[0]!)).toMatchObject({
      amount: 118000,
      currency: 'INR',
      reference_id: 'top',
      callback_method: 'get',
      notes: { orgId: 'org', topupId: 'top' },
    });
  });

  it('cancels at the end of the cycle, not straight away', async () => {
    const { calls, fetchFn } = scripted({});
    await razorpay(fetchFn).cancelAtPeriodEnd('sub_1');
    expect(calls[0]!.url).toContain('/v1/subscriptions/sub_1/cancel');
    expect(sent(calls[0]!)).toEqual({ cancel_at_cycle_end: true });
  });

  it('maps statuses, and leaves a pending cancellation to the stored value', async () => {
    const states = { halted: 'past_due', completed: 'cancelled', created: 'incomplete' };
    for (const [status, expected] of Object.entries(states)) {
      const { fetchFn } = scripted({ status, plan_id: 'plan_1' });
      expect(await razorpay(fetchFn).getSubscription('sub_1')).toMatchObject({
        status: expected,
        priceRef: 'plan_1',
        cancelAtPeriodEnd: null,
      });
    }
  });
});

describe('which providers exist', () => {
  it('needs every value set', () => {
    expect(createPaymentProviders({ STRIPE_SECRET_KEY: 'k' })).toEqual({});
    expect(
      Object.keys(createPaymentProviders({ STRIPE_SECRET_KEY: 'k', STRIPE_WEBHOOK_SECRET: 'w' })),
    ).toEqual(['stripe']);
  });

  it('Razorpay comes first for INR, and only Stripe takes other currencies', () => {
    const both = { stripe: stripe(), razorpay: razorpay() };
    expect(providersForCurrency(both, 'INR')).toEqual(['razorpay', 'stripe']);
    expect(providersForCurrency(both, 'USD')).toEqual(['stripe']);
  });
});
