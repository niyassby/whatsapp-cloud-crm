import { createHmac, timingSafeEqual } from 'node:crypto';
import { microsToMinor, minorToMicros } from '@wacrm/shared';
import {
  type BillingEvent,
  type FetchFn,
  type PaymentProvider,
  PaymentProviderError,
  type SubscriptionCheckoutInput,
  type SubscriptionState,
  type TopupCheckoutInput,
  type VerifiedWebhook,
} from './types';

/** Pinned, so a change to Stripe's default cannot reshape responses without a code change. */
export const STRIPE_API_VERSION = '2026-10-28.endive';
const SIGNATURE_TOLERANCE_SECONDS = 300;

export interface StripeConfig {
  secretKey: string;
  webhookSecret: string;
  baseUrl?: string;
  fetch?: FetchFn;
  now?: () => number;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
const date = (v: unknown): Date | null => {
  const n = num(v);
  return n === null ? null : new Date(n * 1000);
};
/** Stripe sends a linked object as its id, or the whole object when expanded. */
const idOf = (v: unknown): string | null => str(v) ?? str(obj(v).id);

/** Stripe takes form encoding, with nested keys written as a[b][c]. */
function formEncode(input: Obj, prefix = '', out = new URLSearchParams()): URLSearchParams {
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (typeof value === 'object') formEncode(value as Obj, name, out);
    else out.append(name, String(value));
  }
  return out;
}

const STATUS: Record<string, SubscriptionState['status']> = {
  active: 'active',
  trialing: 'active',
  past_due: 'past_due',
  unpaid: 'past_due',
  paused: 'past_due',
  canceled: 'cancelled',
  incomplete: 'incomplete',
  incomplete_expired: 'incomplete',
};

export class StripeProvider implements PaymentProvider {
  readonly id = 'stripe' as const;
  readonly priceColumn = 'stripePriceId' as const;
  private readonly baseUrl: string;
  private readonly fetch: FetchFn;
  private readonly now: () => number;

  constructor(private readonly config: StripeConfig) {
    this.baseUrl = config.baseUrl ?? 'https://api.stripe.com';
    this.fetch = config.fetch ?? fetch;
    this.now = config.now ?? Date.now;
  }

  verifyWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): VerifiedWebhook | null {
    const header = headers['stripe-signature'];
    if (typeof header !== 'string') return null;
    let timestamp: string | null = null;
    const signatures: string[] = [];
    for (const part of header.split(',')) {
      const [key, value] = part.split('=');
      if (key === 't' && value) timestamp = value;
      // v0 is a fake scheme Stripe sends on test events, and must not count.
      if (key === 'v1' && value) signatures.push(value);
    }
    if (!timestamp || signatures.length === 0) return null;
    const age = this.now() / 1000 - Number(timestamp);
    if (!Number.isFinite(age) || Math.abs(age) > SIGNATURE_TOLERANCE_SECONDS) return null;

    const expected = createHmac('sha256', this.config.webhookSecret)
      .update(`${timestamp}.`)
      .update(rawBody)
      .digest();
    const matches = signatures.some((s) => {
      const given = Buffer.from(s, 'hex');
      return given.length === expected.length && timingSafeEqual(given, expected);
    });
    if (!matches) return null;

    const payload: unknown = JSON.parse(rawBody.toString('utf8'));
    const eventId = str(obj(payload).id);
    const type = str(obj(payload).type);
    return eventId && type ? { eventId, type, payload } : null;
  }

  parseEvent(type: string, payload: unknown): BillingEvent[] {
    const data = obj(obj(obj(payload).data).object);
    switch (type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded': {
        // A completed session can still be unpaid, for example a bank transfer in progress.
        if (data.mode !== 'payment' || data.payment_status !== 'paid') return [];
        const metadata = obj(data.metadata);
        const topupId = str(metadata.topupId);
        const providerRef = str(data.id);
        const currency = str(data.currency)?.toUpperCase();
        const amount = num(data.amount_total);
        if (!topupId || !providerRef || !currency || amount === null) return [];
        return [
          {
            kind: 'topup.paid',
            topupId,
            orgId: str(metadata.orgId),
            providerRef,
            paymentRef: idOf(data.payment_intent) ?? providerRef,
            amountMicros: minorToMicros(amount, currency),
            currency,
          },
        ];
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
      case 'customer.subscription.paused':
      case 'customer.subscription.resumed': {
        const ref = str(data.id);
        return ref
          ? [
              {
                kind: 'subscription.changed',
                subscriptionRef: ref,
                orgId: str(obj(data.metadata).orgId),
              },
            ]
          : [];
      }
      case 'invoice.paid': {
        const details = obj(obj(data.parent).subscription_details);
        // Newer API versions nest the subscription under parent. Webhook endpoints keep the version
        // they were created with, so an older shape can still arrive.
        const legacy = obj(data.subscription_details);
        const ref = idOf(details.subscription) ?? idOf(data.subscription);
        const invoiceId = str(data.id);
        const currency = str(data.currency)?.toUpperCase();
        const paid = num(data.amount_paid);
        if (!ref || !invoiceId || !currency || paid === null) return [];
        const orgId = str(obj(details.metadata).orgId) ?? str(obj(legacy.metadata).orgId);
        const changed: BillingEvent = { kind: 'subscription.changed', subscriptionRef: ref, orgId };
        // Nothing was charged, so there is nothing to bill for.
        if (paid === 0) return [changed];
        const line = obj(obj(obj(data.lines).data as unknown as Obj)[0]);
        const period = obj(line.period);
        return [
          changed,
          {
            kind: 'subscription.paid',
            subscriptionRef: ref,
            orgId,
            paymentRef: invoiceId,
            amountMicros: minorToMicros(paid, currency),
            currency,
            periodStart: date(period.start) ?? date(data.period_start),
            periodEnd: date(period.end) ?? date(data.period_end),
          },
        ];
      }
      default:
        return [];
    }
  }

  async createTopupCheckout(input: TopupCheckoutInput) {
    const metadata = { orgId: input.orgId, topupId: input.topupId };
    const session = await this.call(
      'POST',
      '/v1/checkout/sessions',
      {
        mode: 'payment',
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        client_reference_id: input.topupId,
        customer_email: input.customerEmail,
        metadata,
        payment_intent_data: { metadata },
        line_items: {
          0: {
            quantity: 1,
            price_data: {
              currency: input.currency.toLowerCase(),
              unit_amount: microsToMinor(input.totalMicros, input.currency),
              product_data: { name: input.description },
            },
          },
        },
      },
      // Retrying this request cannot create a second payment page for one top-up.
      `topup-${input.topupId}`,
    );
    return this.checkoutResult(session);
  }

  async createSubscriptionCheckout(input: SubscriptionCheckoutInput) {
    const metadata = { orgId: input.orgId };
    const session = await this.call('POST', '/v1/checkout/sessions', {
      mode: 'subscription',
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      client_reference_id: input.orgId,
      // Stripe accepts only one of these.
      ...(input.customerRef
        ? { customer: input.customerRef }
        : { customer_email: input.customerEmail }),
      metadata,
      subscription_data: { metadata },
      line_items: { 0: { quantity: 1, price: input.priceRef } },
    });
    return this.checkoutResult(session);
  }

  private checkoutResult(session: Obj) {
    const url = str(session.url);
    const providerRef = str(session.id);
    if (!url || !providerRef) {
      throw new PaymentProviderError('Stripe returned no checkout page', false);
    }
    return { url, providerRef };
  }

  async getSubscription(ref: string): Promise<SubscriptionState> {
    const sub = await this.call('GET', `/v1/subscriptions/${encodeURIComponent(ref)}`);
    const item = obj(obj(obj(sub.items).data as unknown as Obj)[0]);
    return {
      ref,
      customerRef: idOf(sub.customer),
      status: STATUS[String(sub.status)] ?? 'incomplete',
      priceRef: idOf(item.price),
      // On the item in current API versions, and on the subscription in older ones.
      periodStart: date(item.current_period_start) ?? date(sub.current_period_start),
      periodEnd: date(item.current_period_end) ?? date(sub.current_period_end),
      cancelAtPeriodEnd: sub.cancel_at_period_end === true,
      orgId: str(obj(sub.metadata).orgId),
    };
  }

  async changePlan(input: { subscriptionRef: string; priceRef: string }): Promise<void> {
    const path = `/v1/subscriptions/${encodeURIComponent(input.subscriptionRef)}`;
    const sub = await this.call('GET', path);
    const itemId = idOf(obj(obj(sub.items).data as unknown as Obj)[0]);
    if (!itemId) throw new PaymentProviderError('This subscription has no items', false);
    await this.call('POST', path, {
      cancel_at_period_end: false,
      proration_behavior: 'create_prorations',
      items: { 0: { id: itemId, price: input.priceRef } },
    });
  }

  async cancelAtPeriodEnd(subscriptionRef: string): Promise<void> {
    await this.call('POST', `/v1/subscriptions/${encodeURIComponent(subscriptionRef)}`, {
      cancel_at_period_end: true,
    });
  }

  async managePaymentUrl(input: {
    customerRef: string | null;
    returnUrl: string;
  }): Promise<string | null> {
    if (!input.customerRef) return null;
    const session = await this.call('POST', '/v1/billing_portal/sessions', {
      customer: input.customerRef,
      return_url: input.returnUrl,
    });
    return str(session.url);
  }

  private async call(
    method: 'GET' | 'POST',
    path: string,
    body?: Obj,
    idempotencyKey?: string,
  ): Promise<Obj> {
    let res: Response;
    try {
      res = await this.fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.config.secretKey}`,
          'stripe-version': STRIPE_API_VERSION,
          ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
          ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
        },
        body: body ? formEncode(body).toString() : undefined,
      });
    } catch {
      throw new PaymentProviderError('Could not reach Stripe', true);
    }
    const json = obj(await res.json().catch(() => ({})));
    if (!res.ok) {
      throw new PaymentProviderError(
        str(obj(json.error).message) ?? `Stripe answered ${res.status}`,
        res.status >= 500 || res.status === 429,
        res.status,
      );
    }
    return json;
  }
}
