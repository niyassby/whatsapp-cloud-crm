import type { BillingInterval, PaymentProviderId } from '@wacrm/shared';

/** A provider said no, or could not be reached. Its message is safe to show, and holds no secret. */
export class PaymentProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly httpStatus: number | null = null,
  ) {
    super(message);
    this.name = 'PaymentProviderError';
  }
}

/** A subscription as the provider sees it right now. */
export interface SubscriptionState {
  ref: string;
  customerRef: string | null;
  /** `incomplete` means no payment has been authorized yet, so it changes nothing here. */
  status: 'active' | 'past_due' | 'cancelled' | 'incomplete';
  priceRef: string | null;
  periodStart: Date | null;
  periodEnd: Date | null;
  /** Null when the provider does not report it, in which case the stored value stays. */
  cancelAtPeriodEnd: boolean | null;
  orgId: string | null;
}

/** A provider event, reduced to what this app acts on. */
export type BillingEvent =
  | {
      kind: 'topup.paid';
      topupId: string;
      orgId: string | null;
      providerRef: string;
      paymentRef: string;
      amountMicros: number;
      currency: string;
    }
  /**
   * Something about a subscription changed. Providers do not promise order, so this carries no
   * state: the worker asks the provider for the current one.
   */
  | { kind: 'subscription.changed'; subscriptionRef: string; orgId: string | null }
  | {
      kind: 'subscription.paid';
      subscriptionRef: string;
      orgId: string | null;
      paymentRef: string;
      amountMicros: number;
      currency: string;
      periodStart: Date | null;
      periodEnd: Date | null;
    };

export interface TopupCheckoutInput {
  topupId: string;
  orgId: string;
  totalMicros: number;
  currency: string;
  description: string;
  customerEmail: string | null;
  successUrl: string;
  cancelUrl: string;
}

export interface SubscriptionCheckoutInput {
  orgId: string;
  priceRef: string;
  interval: BillingInterval;
  customerRef: string | null;
  customerEmail: string | null;
  successUrl: string;
  cancelUrl: string;
}

export interface VerifiedWebhook {
  eventId: string;
  type: string;
  payload: unknown;
}

/** One payment provider. Everything else in the app talks to this, never to a provider's API. */
export interface PaymentProvider {
  readonly id: PaymentProviderId;
  /** Null when the signature is missing, wrong or too old. Checked on the exact bytes received. */
  verifyWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): VerifiedWebhook | null;
  /** Only events that mean money moved or a subscription changed. Others give an empty list. */
  parseEvent(type: string, payload: unknown): BillingEvent[];
  createTopupCheckout(input: TopupCheckoutInput): Promise<{ url: string; providerRef: string }>;
  createSubscriptionCheckout(
    input: SubscriptionCheckoutInput,
  ): Promise<{ url: string; providerRef: string }>;
  getSubscription(ref: string): Promise<SubscriptionState>;
  changePlan(input: { subscriptionRef: string; priceRef: string }): Promise<void>;
  cancelAtPeriodEnd(subscriptionRef: string): Promise<void>;
  /** Where a customer manages their payment method. Null when the provider has no such page. */
  managePaymentUrl(input: {
    subscriptionRef: string | null;
    customerRef: string | null;
    returnUrl: string;
  }): Promise<string | null>;
  /** The column on `plan_prices` holding this provider's id for a price. */
  readonly priceColumn: 'stripePriceId' | 'razorpayPlanId';
}

export type PaymentProviders = Partial<Record<PaymentProviderId, PaymentProvider>>;

export type FetchFn = typeof fetch;
