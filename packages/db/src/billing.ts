import {
  AppError,
  type BillingInterval,
  effectiveStatus,
  type EffectiveStatus,
  ErrorCode,
  FREE_PLAN_CODE,
  type InvoiceDto,
  type PaymentProviderId,
  PLAN_LIMIT_LABELS,
  type PlanDto,
  type PlanFeature,
  type PlanLimit,
  taxInside,
} from '@wacrm/shared';
import { liveContactWhere } from './contacts';
import type { Prisma } from './generated/prisma/client';
import type { TenantTx } from './tenant';

const DAY_MS = 86_400_000;

type PlanRow = Prisma.PlanGetPayload<{ include: { prices: true } }>;

/** The app's view of a plan, listing only the providers this deployment can charge with. */
export function planToDto(plan: PlanRow, configured: PaymentProviderId[] = []): PlanDto {
  return {
    code: plan.code,
    name: plan.name,
    description: plan.description,
    seats: plan.seats,
    numbers: plan.numbers,
    contacts: plan.contacts,
    features: plan.features as PlanFeature[],
    prices: plan.prices.map((p) => ({
      currency: p.currency,
      interval: p.interval as BillingInterval,
      amountMicros: Number(p.amountMicros),
      providers: configured.filter((id) =>
        id === 'stripe' ? Boolean(p.stripePriceId) : Boolean(p.razorpayPlanId),
      ),
    })),
  };
}

/** Every new workspace starts here. Safe to call twice. */
export async function startTrial(tx: TenantTx, orgId: string, now: Date = new Date()) {
  const plan = await tx.plan.findFirst({ where: { isTrial: true } });
  if (!plan) return;
  await tx.subscription.upsert({
    where: { orgId },
    create: {
      orgId,
      planId: plan.id,
      status: 'trialing',
      trialEndsAt: new Date(now.getTime() + plan.trialDays * DAY_MS),
    },
    update: {},
  });
}

export interface EffectivePlan {
  plan: PlanRow;
  subscribedPlan: PlanRow;
  status: EffectiveStatus;
  subscription: Prisma.SubscriptionGetPayload<object>;
}

/**
 * What this workspace may do now. Null when it has no subscription row, which signup and the
 * migration rule out for real workspaces. Limits then do not apply: a bookkeeping gap must never
 * stop a business from working.
 */
export async function effectivePlan(
  tx: TenantTx,
  orgId: string,
  now: Date = new Date(),
): Promise<EffectivePlan | null> {
  const subscription = await tx.subscription.findUnique({
    where: { orgId },
    include: { plan: { include: { prices: true } } },
  });
  if (!subscription) return null;
  const status = effectiveStatus(subscription, now);
  const subscribedPlan = subscription.plan;
  const plan =
    status === 'expired'
      ? await tx.plan.findUniqueOrThrow({
          where: { code: FREE_PLAN_CODE },
          include: { prices: true },
        })
      : subscribedPlan;
  return { plan, subscribedPlan, status, subscription };
}

export async function planUsage(tx: TenantTx, orgId: string): Promise<Record<PlanLimit, number>> {
  const [members, invites, numbers, contacts] = await Promise.all([
    tx.membership.count({ where: { orgId, status: 'active' } }),
    tx.invitation.count({
      where: { orgId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
    }),
    tx.phoneNumber.count({ where: { orgId, status: { not: 'disconnected' } } }),
    tx.contact.count({ where: { orgId, ...liveContactWhere } }),
  ]);
  return { seats: members + invites, numbers, contacts };
}

const countOne = (tx: TenantTx, orgId: string, limit: PlanLimit) => {
  if (limit === 'contacts') return tx.contact.count({ where: { orgId, ...liveContactWhere } });
  if (limit === 'numbers') {
    return tx.phoneNumber.count({ where: { orgId, status: { not: 'disconnected' } } });
  }
  return Promise.all([
    tx.membership.count({ where: { orgId, status: 'active' } }),
    tx.invitation.count({
      where: { orgId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
    }),
  ]).then(([members, invites]) => members + invites);
};

const lower = (a: number | null, b: number | null | undefined) =>
  b === null || b === undefined ? a : a === null ? b : Math.min(a, b);

/**
 * The limits in force: the plan's, lowered by any cap the workspace's partner set. A partner can
 * only restrict, since the plan is what the platform charges the partner for.
 */
export async function effectiveLimits(
  tx: TenantTx,
  orgId: string,
): Promise<Record<PlanLimit, number | null>> {
  const current = await effectivePlan(tx, orgId);
  const cap = await tx.partnerClient.findUnique({ where: { orgId } });
  return {
    seats: lower(current?.plan.seats ?? null, cap?.limitSeats),
    numbers: lower(current?.plan.numbers ?? null, cap?.limitNumbers),
    contacts: lower(current?.plan.contacts ?? null, cap?.limitContacts),
  };
}

/** How many more fit. Null means no limit. */
export async function roomLeft(
  tx: TenantTx,
  orgId: string,
  limit: PlanLimit,
): Promise<number | null> {
  const max = (await effectiveLimits(tx, orgId))[limit];
  if (max === null) return null;
  return Math.max(0, max - (await countOne(tx, orgId, limit)));
}

/**
 * Refuses when adding this many would pass the plan's limit. Going over because of a downgrade
 * keeps what exists: only adding more is stopped.
 */
export async function assertWithinLimit(
  tx: TenantTx,
  orgId: string,
  limit: PlanLimit,
  adding = 1,
): Promise<void> {
  const room = await roomLeft(tx, orgId, limit);
  if (room !== null && room < adding) {
    throw new AppError(
      ErrorCode.PLAN_LIMIT_REACHED,
      `Your plan's limit on ${PLAN_LIMIT_LABELS[limit]} has been reached. Upgrade to add more.`,
      { limit },
    );
  }
}

export async function hasFeature(
  tx: TenantTx,
  orgId: string,
  feature: PlanFeature,
): Promise<boolean> {
  const current = await effectivePlan(tx, orgId);
  return !current || (current.plan.features as string[]).includes(feature);
}

export async function taxRateFor(tx: TenantTx, country: string | null) {
  const row = country ? await tx.taxRate.findUnique({ where: { country } }) : null;
  return { rateBps: row?.rateBps ?? 0, label: row?.label ?? null };
}

export interface RecordInvoiceInput {
  orgId: string;
  kind: 'subscription' | 'topup';
  provider: string;
  providerRef: string;
  description: string;
  currency: string;
  subtotalMicros: number;
  taxMicros: number;
  taxRateBps: number;
  taxLabel: string | null;
  totalMicros: number;
  periodStart?: Date | null;
  periodEnd?: Date | null;
}

/**
 * Create the invoice for one payment, once. The number comes from a counter updated in this same
 * transaction, so a rollback gives it back and the sequence has no gaps.
 */
export async function recordInvoice(tx: TenantTx, input: RecordInvoiceInput) {
  const key = { provider: input.provider, providerRef: input.providerRef };
  const existing = await tx.invoice.findUnique({ where: { provider_providerRef: key } });
  if (existing) return { invoice: existing, created: false };

  const org = await tx.organization.findUniqueOrThrow({
    where: { id: input.orgId },
    select: {
      name: true,
      billingName: true,
      billingEmail: true,
      billingAddress: true,
      billingCountry: true,
      taxId: true,
    },
  });
  // Reviewed raw SQL: a definer function with no arguments.
  const [row] = await tx.$queryRaw<{ value: bigint }[]>`SELECT next_invoice_number() AS value`;
  const issuedAt = new Date();
  const invoice = await tx.invoice.create({
    data: {
      orgId: input.orgId,
      number: `INV-${issuedAt.getUTCFullYear()}-${String(row?.value ?? 0n).padStart(6, '0')}`,
      kind: input.kind,
      provider: input.provider,
      providerRef: input.providerRef,
      description: input.description,
      currency: input.currency,
      subtotalMicros: BigInt(input.subtotalMicros),
      taxMicros: BigInt(input.taxMicros),
      taxRateBps: input.taxRateBps,
      taxLabel: input.taxLabel,
      totalMicros: BigInt(input.totalMicros),
      periodStart: input.periodStart ?? null,
      periodEnd: input.periodEnd ?? null,
      billTo: {
        name: org.billingName ?? org.name,
        email: org.billingEmail,
        address: org.billingAddress,
        country: org.billingCountry,
        taxId: org.taxId,
      },
      issuedAt,
    },
  });
  return { invoice, created: true };
}

/** Plan prices include tax, so a subscription payment is split at the workspace's rate. */
export async function subscriptionInvoiceAmounts(tx: TenantTx, orgId: string, totalMicros: number) {
  const org = await tx.organization.findUniqueOrThrow({
    where: { id: orgId },
    select: { billingCountry: true },
  });
  const tax = await taxRateFor(tx, org.billingCountry);
  return { ...taxInside(totalMicros, tax.rateBps), taxRateBps: tax.rateBps, taxLabel: tax.label };
}

export function invoiceToDto(i: Prisma.InvoiceGetPayload<object>): InvoiceDto {
  return {
    id: i.id,
    number: i.number,
    kind: i.kind as InvoiceDto['kind'],
    description: i.description,
    currency: i.currency,
    subtotalMicros: Number(i.subtotalMicros),
    taxMicros: Number(i.taxMicros),
    taxRateBps: i.taxRateBps,
    taxLabel: i.taxLabel,
    totalMicros: Number(i.totalMicros),
    periodStart: i.periodStart?.toISOString() ?? null,
    periodEnd: i.periodEnd?.toISOString() ?? null,
    issuedAt: i.issuedAt.toISOString(),
  };
}
