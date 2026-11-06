import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
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

export interface RazorpayConfig {
  keyId: string;
  keySecret: string;
  webhookSecret: string;
  baseUrl?: string;
  fetch?: FetchFn;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {};
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
const date = (v: unknown): Date | null => {
  const n = num(v);
  return n === null ? null : new Date(n * 1000);
};
/** `notes` is an object, or an empty array when there are none, and some events leave it out. */
const orgFromNotes = (...entities: Obj[]): string | null => {
  for (const entity of entities) {
    const orgId = str(obj(entity.notes).orgId);
    if (orgId) return orgId;
  }
  return null;
};

const STATUS: Record<string, SubscriptionState['status']> = {
  active: 'active',
  pending: 'past_due',
  halted: 'past_due',
  paused: 'past_due',
  cancelled: 'cancelled',
  completed: 'cancelled',
  expired: 'cancelled',
  created: 'incomplete',
  authenticated: 'incomplete',
};

/** Razorpay needs a fixed number of charges. These run for about ten years either way. */
const TOTAL_COUNT = { month: 120, year: 10 };

export class RazorpayProvider implements PaymentProvider {
  readonly id = 'razorpay' as const;
  readonly priceColumn = 'razorpayPlanId' as const;
  private readonly baseUrl: string;
  private readonly fetch: FetchFn;

  constructor(private readonly config: RazorpayConfig) {
    this.baseUrl = config.baseUrl ?? 'https://api.razorpay.com';
    this.fetch = config.fetch ?? fetch;
  }

  verifyWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): VerifiedWebhook | null {
    const signature = headers['x-razorpay-signature'];
    if (typeof signature !== 'string') return null;
    const expected = createHmac('sha256', this.config.webhookSecret).update(rawBody).digest();
    const given = Buffer.from(signature, 'hex');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

    const payload: unknown = JSON.parse(rawBody.toString('utf8'));
    const type = str(obj(payload).event);
    if (!type) return null;
    const header = headers['x-razorpay-event-id'];
    // The header is what Razorpay documents. The hash keeps a redelivery deduped without it.
    const eventId =
      typeof header === 'string' && header
        ? header
        : createHash('sha256').update(rawBody).digest('hex');
    return { eventId, type, payload };
  }

  parseEvent(type: string, payload: unknown): BillingEvent[] {
    const body = obj(obj(payload).payload);
    const payment = obj(obj(body.payment).entity);

    if (type === 'payment_link.paid') {
      const link = obj(obj(body.payment_link).entity);
      // The samples are inconsistent about notes, so the link's own reference is what identifies it.
      const topupId = str(link.reference_id);
      const providerRef = str(link.id);
      const paymentRef = str(payment.id);
      const currency = str(payment.currency)?.toUpperCase() ?? str(link.currency)?.toUpperCase();
      const amount = num(payment.amount) ?? num(link.amount_paid);
      if (!topupId || !providerRef || !paymentRef || !currency || amount === null) return [];
      // Only money that was really captured counts.
      if (link.status !== 'paid' || (payment.status && payment.status !== 'captured')) return [];
      return [
        {
          kind: 'topup.paid',
          topupId,
          orgId: orgFromNotes(link, payment),
          providerRef,
          paymentRef,
          amountMicros: minorToMicros(amount, currency),
          currency,
        },
      ];
    }

    if (type.startsWith('subscription.')) {
      const sub = obj(obj(body.subscription).entity);
      const ref = str(sub.id);
      if (!ref) return [];
      const orgId = orgFromNotes(sub);
      const changed: BillingEvent = { kind: 'subscription.changed', subscriptionRef: ref, orgId };
      if (type !== 'subscription.charged') return [changed];
      const paymentRef = str(payment.id);
      const currency = str(payment.currency)?.toUpperCase();
      const amount = num(payment.amount);
      if (!paymentRef || !currency || !amount) return [changed];
      return [
        changed,
        {
          kind: 'subscription.paid',
          subscriptionRef: ref,
          orgId,
          paymentRef,
          amountMicros: minorToMicros(amount, currency),
          currency,
          periodStart: date(sub.current_start),
          periodEnd: date(sub.current_end),
        },
      ];
    }
    return [];
  }

  async createTopupCheckout(input: TopupCheckoutInput) {
    const link = await this.call('POST', '/v1/payment_links', {
      amount: microsToMinor(input.totalMicros, input.currency),
      currency: input.currency,
      description: input.description,
      reference_id: input.topupId,
      callback_url: input.successUrl,
      callback_method: 'get',
      notes: { orgId: input.orgId, topupId: input.topupId },
      ...(input.customerEmail ? { customer: { email: input.customerEmail } } : {}),
    });
    return this.checkoutResult(link);
  }

  async createSubscriptionCheckout(input: SubscriptionCheckoutInput) {
    const sub = await this.call('POST', '/v1/subscriptions', {
      plan_id: input.priceRef,
      total_count: TOTAL_COUNT[input.interval],
      customer_notify: true,
      notes: { orgId: input.orgId },
    });
    return this.checkoutResult(sub);
  }

  private checkoutResult(entity: Obj) {
    const url = str(entity.short_url);
    const providerRef = str(entity.id);
    if (!url || !providerRef) {
      throw new PaymentProviderError('Razorpay returned no payment page', false);
    }
    return { url, providerRef };
  }

  async getSubscription(ref: string): Promise<SubscriptionState> {
    const sub = await this.call('GET', `/v1/subscriptions/${encodeURIComponent(ref)}`);
    return {
      ref,
      customerRef: str(sub.customer_id),
      status: STATUS[String(sub.status)] ?? 'incomplete',
      priceRef: str(sub.plan_id),
      periodStart: date(sub.current_start),
      periodEnd: date(sub.current_end),
      // Razorpay does not report a pending cancellation, so the stored value stands.
      cancelAtPeriodEnd: null,
      orgId: orgFromNotes(sub),
    };
  }

  async changePlan(input: { subscriptionRef: string; priceRef: string }): Promise<void> {
    await this.call('PATCH', `/v1/subscriptions/${encodeURIComponent(input.subscriptionRef)}`, {
      plan_id: input.priceRef,
      schedule_change_at: 'now',
    });
  }

  async cancelAtPeriodEnd(subscriptionRef: string): Promise<void> {
    await this.call('POST', `/v1/subscriptions/${encodeURIComponent(subscriptionRef)}/cancel`, {
      cancel_at_cycle_end: true,
    });
  }

  /** No customer portal exists. A subscription's own page is where its card can be updated. */
  async managePaymentUrl(input: { subscriptionRef: string | null }): Promise<string | null> {
    if (!input.subscriptionRef) return null;
    const sub = await this.call(
      'GET',
      `/v1/subscriptions/${encodeURIComponent(input.subscriptionRef)}`,
    );
    return str(sub.short_url);
  }

  private async call(method: 'GET' | 'POST' | 'PATCH', path: string, body?: Obj): Promise<Obj> {
    const auth = Buffer.from(`${this.config.keyId}:${this.config.keySecret}`).toString('base64');
    let res: Response;
    try {
      res = await this.fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Basic ${auth}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new PaymentProviderError('Could not reach Razorpay', true);
    }
    const json = obj(await res.json().catch(() => ({})));
    if (!res.ok) {
      throw new PaymentProviderError(
        str(obj(json.error).description) ?? `Razorpay answered ${res.status}`,
        res.status >= 500 || res.status === 429,
        res.status,
      );
    }
    return json;
  }
}
