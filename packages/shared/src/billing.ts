import { z } from 'zod';
import { decimalToMicros } from './wallet';

export const PAYMENT_PROVIDERS = ['stripe', 'razorpay'] as const;
export type PaymentProviderId = (typeof PAYMENT_PROVIDERS)[number];

/** Keys a plan can switch on. New modules add theirs here, and `plans` rows list them. */
export const PLAN_FEATURES = ['campaigns', 'drips', 'public_api', 'flows'] as const;
export type PlanFeature = (typeof PLAN_FEATURES)[number];

export const PLAN_FEATURE_LABELS: Record<PlanFeature, string> = {
  campaigns: 'Broadcast campaigns',
  drips: 'Drip sequences',
  public_api: 'Public API and webhooks',
  flows: 'Chatbot flows',
};

/** Where a workspace lands when a trial or subscription ends. */
export const FREE_PLAN_CODE = 'free';

export const PLAN_LIMITS = ['seats', 'numbers', 'contacts'] as const;
export type PlanLimit = (typeof PLAN_LIMITS)[number];

export const PLAN_LIMIT_LABELS: Record<PlanLimit, string> = {
  seats: 'team members',
  numbers: 'WhatsApp numbers',
  contacts: 'contacts',
};

export const BILLING_INTERVALS = ['month', 'year'] as const;
export type BillingInterval = (typeof BILLING_INTERVALS)[number];

// ------------------------------------------------------------------ money in provider units

/** Currencies with no minor unit. Providers send whole units for these. */
const ZERO_DECIMAL = new Set([
  'BIF',
  'CLP',
  'DJF',
  'GNF',
  'JPY',
  'KMF',
  'KRW',
  'MGA',
  'PYG',
  'RWF',
  'UGX',
  'VND',
  'VUV',
  'XAF',
  'XOF',
  'XPF',
]);

const minorUnit = (currency: string) => (ZERO_DECIMAL.has(currency.toUpperCase()) ? 1 : 100);

/** Provider amounts are paise or cents, as whole numbers. */
export const minorToMicros = (minor: number, currency: string) =>
  (minor * 1_000_000) / minorUnit(currency);

export const microsToMinor = (micros: number, currency: string) =>
  Math.round((micros * minorUnit(currency)) / 1_000_000);

// ------------------------------------------------------------------ tax

export interface TaxBreakdown {
  subtotalMicros: number;
  taxMicros: number;
  totalMicros: number;
}

/** Tax added on top: a top-up of 1000 at 18% costs 1180, and 1000 reaches the wallet. */
export function taxOnTop(netMicros: number, rateBps: number): TaxBreakdown {
  const taxMicros = Math.round((netMicros * rateBps) / 10_000);
  return { subtotalMicros: netMicros, taxMicros, totalMicros: netMicros + taxMicros };
}

/** Tax inside a price: plan prices are what the provider charges, tax included. */
export function taxInside(totalMicros: number, rateBps: number): TaxBreakdown {
  const subtotalMicros = Math.round((totalMicros * 10_000) / (10_000 + rateBps));
  return { subtotalMicros, taxMicros: totalMicros - subtotalMicros, totalMicros };
}

// ------------------------------------------------------------------ what a subscription means now

export type EffectiveStatus = 'trialing' | 'active' | 'past_due' | 'expired';

/**
 * What a stored subscription means at this moment. Expiry is worked out when read rather than by
 * a job, so a late job can never leave someone on a plan they stopped paying for. A subscription
 * cancelled by the customer keeps its plan until the period they paid for ends.
 */
export function effectiveStatus(
  sub: { status: string; trialEndsAt: Date | null; currentPeriodEnd: Date | null },
  now: Date = new Date(),
): EffectiveStatus {
  if (sub.status === 'trialing') {
    return sub.trialEndsAt && sub.trialEndsAt > now ? 'trialing' : 'expired';
  }
  if (sub.status === 'cancelled') {
    return sub.currentPeriodEnd && sub.currentPeriodEnd > now ? 'active' : 'expired';
  }
  return sub.status === 'past_due' ? 'past_due' : 'active';
}

// ------------------------------------------------------------------ input

const countryCode = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{2}$/, 'Use a two-letter country code')
  .transform((v) => v.toUpperCase());

export const updateBillingProfileSchema = z.object({
  billingName: z.string().trim().max(200).nullable(),
  billingEmail: z.email().max(254).nullable(),
  billingAddress: z.string().trim().max(1000).nullable(),
  billingCountry: countryCode.nullable(),
  taxId: z.string().trim().max(40).nullable(),
});
export type UpdateBillingProfileInput = z.infer<typeof updateBillingProfileSchema>;

export const checkoutSchema = z.object({
  planCode: z.string().min(1).max(40),
  interval: z.enum(BILLING_INTERVALS),
  provider: z.enum(PAYMENT_PROVIDERS).optional(),
});
export type CheckoutInput = z.infer<typeof checkoutSchema>;

const MAX_TOPUP_MICROS = 10_000_000 * 1_000_000;

const topupAmount = z
  .string()
  .trim()
  .refine((v) => {
    const micros = decimalToMicros(v);
    return micros !== null && micros >= 1_000_000 && micros <= MAX_TOPUP_MICROS;
  }, 'Enter an amount of at least 1');

export const createTopupSchema = z.object({
  amount: topupAmount,
  provider: z.enum(PAYMENT_PROVIDERS).optional(),
});
export type CreateTopupInput = z.infer<typeof createTopupSchema>;

export const topupQuoteSchema = z.object({ amount: topupAmount });

export const listInvoicesSchema = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListInvoicesQuery = z.infer<typeof listInvoicesSchema>;

/** What `pnpm plans:import` reads. Every plan is replaced by the file's version of it. */
export const plansFileSchema = z.object({
  plans: z.array(
    z.object({
      code: z.string().min(1).max(40),
      name: z.string().min(1).max(80),
      description: z.string().max(500).nullable().default(null),
      seats: z.number().int().positive().nullable(),
      numbers: z.number().int().positive().nullable(),
      contacts: z.number().int().positive().nullable(),
      features: z.array(z.enum(PLAN_FEATURES)).default([]),
      isPublic: z.boolean().default(true),
      isTrial: z.boolean().default(false),
      trialDays: z.number().int().min(0).default(14),
      sortOrder: z.number().int().default(0),
      prices: z
        .array(
          z.object({
            currency: z.string().regex(/^[A-Z]{3}$/),
            interval: z.enum(BILLING_INTERVALS),
            amount: z.string(),
            stripePriceId: z.string().nullable().default(null),
            razorpayPlanId: z.string().nullable().default(null),
          }),
        )
        .default([]),
    }),
  ),
});

// ------------------------------------------------------------------ DTOs

export interface PlanPriceDto {
  currency: string;
  interval: BillingInterval;
  amountMicros: number;
  /** Which providers can take this price. Empty means it cannot be bought yet. */
  providers: PaymentProviderId[];
}

export interface PlanDto {
  code: string;
  name: string;
  description: string | null;
  seats: number | null;
  numbers: number | null;
  contacts: number | null;
  features: PlanFeature[];
  prices: PlanPriceDto[];
}

export interface BillingProfileDto {
  billingName: string | null;
  billingEmail: string | null;
  billingAddress: string | null;
  billingCountry: string | null;
  taxId: string | null;
}

export interface BillingSummaryDto {
  plan: PlanDto;
  /** The plan paid for or on trial. Differs from `plan` once it has expired. */
  subscribedPlanCode: string;
  status: EffectiveStatus;
  provider: PaymentProviderId | null;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  /** True when a provider is charging for this, so changing plan does not need a new checkout. */
  hasPaidSubscription: boolean;
  canManagePayment: boolean;
  usage: Record<PlanLimit, number>;
  currency: string;
  /** Providers set up on this deployment that can charge this workspace's currency. */
  providers: PaymentProviderId[];
  profile: BillingProfileDto;
  taxRateBps: number;
  taxLabel: string | null;
}

export interface TopupQuoteDto {
  currency: string;
  creditMicros: number;
  taxMicros: number;
  taxRateBps: number;
  taxLabel: string | null;
  totalMicros: number;
}

export interface CheckoutResultDto {
  /** Where to send the browser. Null when no new checkout was needed. */
  url: string | null;
}

export interface InvoiceDto {
  id: string;
  number: string;
  kind: 'subscription' | 'topup';
  description: string;
  currency: string;
  subtotalMicros: number;
  taxMicros: number;
  taxRateBps: number;
  taxLabel: string | null;
  totalMicros: number;
  periodStart: string | null;
  periodEnd: string | null;
  issuedAt: string;
}
