import type { PaymentProviderId } from '@wacrm/shared';
import { RazorpayProvider } from './razorpay';
import { StripeProvider } from './stripe';
import type { FetchFn, PaymentProviders } from './types';

export * from './razorpay';
export * from './stripe';
export * from './types';

export interface BillingEnv {
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_API_BASE?: string;
  RAZORPAY_KEY_ID?: string;
  RAZORPAY_KEY_SECRET?: string;
  RAZORPAY_WEBHOOK_SECRET?: string;
  RAZORPAY_API_BASE?: string;
}

/** Only providers with complete credentials exist. A half-set one would fail at the worst time. */
export function createPaymentProviders(env: BillingEnv, fetchFn?: FetchFn): PaymentProviders {
  const providers: PaymentProviders = {};
  if (env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET) {
    providers.stripe = new StripeProvider({
      secretKey: env.STRIPE_SECRET_KEY,
      webhookSecret: env.STRIPE_WEBHOOK_SECRET,
      baseUrl: env.STRIPE_API_BASE,
      fetch: fetchFn,
    });
  }
  if (env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET && env.RAZORPAY_WEBHOOK_SECRET) {
    providers.razorpay = new RazorpayProvider({
      keyId: env.RAZORPAY_KEY_ID,
      keySecret: env.RAZORPAY_KEY_SECRET,
      webhookSecret: env.RAZORPAY_WEBHOOK_SECRET,
      baseUrl: env.RAZORPAY_API_BASE,
      fetch: fetchFn,
    });
  }
  return providers;
}

/** Razorpay here charges INR only. Everything else goes through Stripe. */
export function providersForCurrency(
  providers: PaymentProviders,
  currency: string,
): PaymentProviderId[] {
  const out: PaymentProviderId[] = [];
  if (currency === 'INR' && providers.razorpay) out.push('razorpay');
  if (providers.stripe) out.push('stripe');
  return out;
}
