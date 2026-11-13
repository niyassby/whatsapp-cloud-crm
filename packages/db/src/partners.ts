import {
  AppError,
  ErrorCode,
  type PartnerStatementDto,
  type PartnerTotalsDto,
  periodOf,
  previousPeriod,
} from '@wacrm/shared';
import type { DbClient } from './client';
import type { Prisma } from './generated/prisma/client';
import { type TenantTx, withDbContext } from './tenant';
import { clientPartnerPricing } from './wallet';

/**
 * Resellers. A partner is invoiced by the platform at wholesale and collects from its clients
 * itself, so nothing here moves money: `partner_ledger` records what each client's usage and plan
 * cost the partner and what the partner earned on it, and a statement closes a month of it.
 *
 * Functions taking `tx` expect the partner's context (`app.partner_id`), unless they say otherwise.
 */

/** How a partner-managed workspace's subscription is marked. No payment provider is involved. */
export const PARTNER_PROVIDER = 'partner';

/**
 * Refuses when a partner pays for the current workspace: it cannot buy a plan or add funds on its
 * own, because the platform bills the partner. Runs in the workspace's own context.
 */
export async function assertNotPartnerManaged(tx: TenantTx): Promise<void> {
  if (await clientPartnerPricing(tx)) {
    throw new AppError(
      ErrorCode.MANAGED_BY_PARTNER,
      'This workspace is managed by a partner. Ask them to change the plan or add funds.',
    );
  }
}

/** The name of the partner managing the current workspace, if any. Workspace context. */
export async function managingPartnerName(tx: TenantTx): Promise<string | null> {
  const pricing = await clientPartnerPricing(tx);
  if (!pricing) return null;
  const partner = await tx.partner.findUnique({
    where: { id: pricing.partnerId },
    select: { name: true },
  });
  return partner?.name ?? null;
}

/** Put a partner's client on a plan. There is nothing to pay here: it shows on the statement. */
export async function setPartnerManagedPlan(tx: TenantTx, orgId: string, planId: string) {
  await tx.subscription.upsert({
    where: { orgId },
    create: { orgId, planId, status: 'active', provider: PARTNER_PROVIDER },
    update: {
      planId,
      status: 'active',
      provider: PARTNER_PROVIDER,
      providerSubscriptionId: null,
      trialEndsAt: null,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
    },
  });
}

const ZERO_TOTALS = {
  usageWholesaleMicros: 0,
  usageRetailMicros: 0,
  planFeesWholesaleMicros: 0,
  planFeesRetailMicros: 0,
  commissionMicros: 0,
  totalDueMicros: 0,
};

/** One period of a partner's ledger, added up. Optionally for a single client. */
export async function partnerTotals(
  tx: TenantTx,
  input: { partnerId: string; period: string; currency: string; orgId?: string },
): Promise<PartnerTotalsDto> {
  const groups = await tx.partnerLedger.groupBy({
    by: ['type'],
    where: {
      partnerId: input.partnerId,
      period: input.period,
      currency: input.currency,
      ...(input.orgId ? { orgId: input.orgId } : {}),
    },
    _sum: { wholesaleMicros: true, retailMicros: true, commissionMicros: true },
  });
  const totals = { ...ZERO_TOTALS };
  for (const g of groups) {
    const wholesale = Number(g._sum.wholesaleMicros ?? 0n);
    const retail = Number(g._sum.retailMicros ?? 0n);
    if (g.type === 'plan_fee') {
      totals.planFeesWholesaleMicros += wholesale;
      totals.planFeesRetailMicros += retail;
    } else {
      // usage, its refunds, and adjustments
      totals.usageWholesaleMicros += wholesale;
      totals.usageRetailMicros += retail;
    }
    totals.commissionMicros += Number(g._sum.commissionMicros ?? 0n);
    totals.totalDueMicros += wholesale;
  }
  return { period: input.period, currency: input.currency, ...totals };
}

const periodBounds = (period: string) => {
  const [year, month] = period.split('-').map(Number) as [number, number];
  return { start: new Date(Date.UTC(year, month - 1, 1)), end: new Date(Date.UTC(year, month, 1)) };
};

/**
 * Write the month's plan fee for each client a partner manages: the wholesale price of the client's
 * plan, and what the partner charges the client for it. A whole month each, with no proration.
 * Keyed by client and period, so running it again adds nothing.
 */
export async function recordPlanFees(
  tx: TenantTx,
  partner: { id: string; currency: string },
  period: string,
): Promise<number> {
  const { start, end } = periodBounds(period);
  const clients = await tx.organization.findMany({
    where: {
      partnerId: partner.id,
      createdAt: { lt: end },
      OR: [{ deletedAt: null }, { deletedAt: { gte: start } }],
    },
    select: {
      id: true,
      name: true,
      subscription: { select: { provider: true, status: true, plan: true } },
      partnerClient: { select: { clientPriceMicros: true } },
    },
  });
  const prices = await tx.wholesalePlanPrice.findMany({ where: { currency: partner.currency } });
  const wholesaleOf = new Map(prices.map((p) => [p.planId, p.amountMicros]));

  const rows: Prisma.PartnerLedgerCreateManyInput[] = [];
  for (const client of clients) {
    const sub = client.subscription;
    if (!sub || sub.provider !== PARTNER_PROVIDER || sub.status !== 'active') continue;
    const wholesale = wholesaleOf.get(sub.plan.id);
    if (wholesale === undefined) continue;
    const retail = client.partnerClient?.clientPriceMicros ?? wholesale;
    rows.push({
      partnerId: partner.id,
      orgId: client.id,
      type: 'plan_fee',
      currency: partner.currency,
      wholesaleMicros: wholesale,
      retailMicros: retail,
      commissionMicros: retail - wholesale,
      period,
      referenceType: 'plan',
      referenceId: sub.plan.code,
      idempotencyKey: `plan-fee:${client.id}:${period}`,
      description: `${sub.plan.name} plan, ${client.name}`,
    });
  }
  if (rows.length === 0) return 0;
  const { count } = await tx.partnerLedger.createMany({ data: rows, skipDuplicates: true });
  return count;
}

export interface CloseMonthResult {
  /** False when this month already had a statement, which is returned unchanged. */
  created: boolean;
  statement: PartnerStatementDto | null;
}

/**
 * Close a finished month for one partner: write its plan fees, then copy the ledger's totals onto
 * a statement. Refuses the current month, which is still moving. Safe to run again: a statement
 * is unique per partner and period, and never rewritten.
 */
export async function closePartnerMonth(
  db: DbClient,
  partnerId: string,
  period: string,
  now: Date = new Date(),
): Promise<CloseMonthResult> {
  if (period >= periodOf(now)) {
    throw new AppError(ErrorCode.CONFLICT, 'Only a finished month can be closed');
  }
  return withDbContext(db, { partnerId }, async (tx) => {
    const partner = await tx.partner.findUnique({ where: { id: partnerId } });
    if (!partner) throw new AppError(ErrorCode.NOT_FOUND, 'Partner not found');
    const key = { partnerId, period, currency: partner.currency };
    const existing = await tx.partnerStatement.findUnique({
      where: { partnerId_period_currency: key },
    });
    if (existing) return { created: false, statement: statementToDto(existing, partner.name) };

    await recordPlanFees(tx, partner, period);
    const totals = await partnerTotals(tx, key);
    const nothing = totals.totalDueMicros === 0 && totals.commissionMicros === 0;
    if (nothing && totals.usageRetailMicros === 0) return { created: false, statement: null };

    const statement = await tx.partnerStatement.create({
      data: {
        ...key,
        usageWholesaleMicros: BigInt(totals.usageWholesaleMicros),
        usageRetailMicros: BigInt(totals.usageRetailMicros),
        planFeesWholesaleMicros: BigInt(totals.planFeesWholesaleMicros),
        planFeesRetailMicros: BigInt(totals.planFeesRetailMicros),
        commissionMicros: BigInt(totals.commissionMicros),
        totalDueMicros: BigInt(totals.totalDueMicros),
      },
    });
    return { created: true, statement: statementToDto(statement, partner.name) };
  });
}

/**
 * Close last month for every partner. Runs daily, so a worker that was down on the first of the
 * month catches up. One partner failing does not stop the others; its error is returned.
 */
export async function closeDuePartnerMonths(
  db: DbClient,
  now: Date = new Date(),
): Promise<{ created: number; failed: { partnerId: string; error: string }[] }> {
  const period = previousPeriod(periodOf(now));
  // Reviewed raw SQL: a definer function with no arguments that returns ids only.
  const targets = await db.$queryRaw<{ partner_id: string }[]>`
    SELECT partner_id FROM partner_statement_targets()`;
  let created = 0;
  const failed: { partnerId: string; error: string }[] = [];
  for (const { partner_id: partnerId } of targets) {
    try {
      if ((await closePartnerMonth(db, partnerId, period, now)).created) created++;
    } catch (err) {
      failed.push({ partnerId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { created, failed };
}

export function statementToDto(
  s: Prisma.PartnerStatementGetPayload<object>,
  partnerName: string | null = null,
): PartnerStatementDto {
  return {
    id: s.id,
    partnerId: s.partnerId,
    partnerName,
    period: s.period,
    currency: s.currency,
    usageWholesaleMicros: Number(s.usageWholesaleMicros),
    usageRetailMicros: Number(s.usageRetailMicros),
    planFeesWholesaleMicros: Number(s.planFeesWholesaleMicros),
    planFeesRetailMicros: Number(s.planFeesRetailMicros),
    commissionMicros: Number(s.commissionMicros),
    totalDueMicros: Number(s.totalDueMicros),
    status: s.status as PartnerStatementDto['status'],
    issuedAt: s.issuedAt.toISOString(),
    paidAt: s.paidAt?.toISOString() ?? null,
    paymentReference: s.paymentReference,
  };
}
