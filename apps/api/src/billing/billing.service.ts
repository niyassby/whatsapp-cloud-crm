import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  type PaymentProvider,
  PaymentProviderError,
  type PaymentProviders,
  providersForCurrency,
} from '@wacrm/billing';
import {
  effectivePlan,
  invoiceToDto,
  planToDto,
  planUsage,
  startTrial,
  taxRateFor,
  type TenantTx,
} from '@wacrm/db';
import {
  AppError,
  type BillingProfileDto,
  type BillingSummaryDto,
  type CheckoutInput,
  type CheckoutResultDto,
  type CreateTopupInput,
  type CursorPage,
  decimalToMicros,
  ErrorCode,
  FREE_PLAN_CODE,
  type InvoiceDto,
  type ListInvoicesQuery,
  type PaymentProviderId,
  type PlanDto,
  taxOnTop,
  type TopupQuoteDto,
  type UpdateBillingProfileInput,
} from '@wacrm/shared';
import { AuditAction, AuditService } from '../audit/audit.service';
import type { RequestMeta } from '../common/request-meta';
import { API_ENV, type ApiEnv } from '../env';
import { decodeCursor, encodeCursor } from '../orgs/cursor';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { PAYMENT_PROVIDERS } from './billing.tokens';

export interface BillingActor {
  userId: string;
  orgId: string;
  meta?: RequestMeta;
}

/** Calls to a provider never happen inside a transaction, and their failures get a stable code. */
async function callProvider<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof PaymentProviderError) {
      throw new AppError(ErrorCode.PAYMENT_PROVIDER_ERROR, err.message);
    }
    throw err;
  }
}

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    private readonly db: TenantPrismaService,
    private readonly audit: AuditService,
    private readonly wallet: WalletService,
    private readonly realtime: RealtimeGateway,
    @Inject(API_ENV) private readonly env: ApiEnv,
    @Inject(PAYMENT_PROVIDERS) private readonly providers: PaymentProviders,
  ) {}

  private url(path: string) {
    return `${this.env.WEB_URL}${path}`;
  }

  /** The workspace's choice if it can be used, then the local provider for its currency. */
  private pickProvider(
    currency: string,
    requested: PaymentProviderId | undefined,
    usable?: PaymentProviderId[],
  ): PaymentProvider {
    const available = providersForCurrency(this.providers, currency).filter(
      (id) => !usable || usable.includes(id),
    );
    const id = requested && available.includes(requested) ? requested : available[0];
    const provider = id ? this.providers[id] : undefined;
    if (!provider) {
      throw new AppError(
        ErrorCode.BILLING_NOT_CONFIGURED,
        'Payments are not set up for this currency yet',
      );
    }
    return provider;
  }

  // ------------------------------------------------------------------ reading

  async plans(actor: BillingActor): Promise<PlanDto[]> {
    const { currency } = await this.wallet.get(actor);
    const configured = providersForCurrency(this.providers, currency);
    const rows = await this.db.run((tx) =>
      tx.plan.findMany({
        where: { isPublic: true },
        orderBy: { sortOrder: 'asc' },
        include: { prices: { where: { currency } } },
      }),
    );
    return rows.map((p) => planToDto(p, configured));
  }

  async summary(actor: BillingActor): Promise<BillingSummaryDto> {
    const { currency } = await this.wallet.get(actor);
    const configured = providersForCurrency(this.providers, currency);
    return this.db.run(async (tx) => {
      // Workspaces always have one by now, but this view must not break if one slipped through.
      await startTrial(tx, actor.orgId);
      const current = await effectivePlan(tx, actor.orgId);
      if (!current) {
        const free = await tx.plan.findUniqueOrThrow({
          where: { code: FREE_PLAN_CODE },
          include: { prices: true },
        });
        return this.toSummary(tx, actor, currency, configured, {
          plan: planToDto(free, configured),
          subscribedPlanCode: free.code,
          status: 'expired',
          provider: null,
          trialEndsAt: null,
          currentPeriodEnd: null,
          cancelAtPeriodEnd: false,
          hasPaidSubscription: false,
          canManagePayment: false,
        });
      }
      const { subscription: sub } = current;
      const paying = Boolean(sub.providerSubscriptionId) && current.status !== 'expired';
      return this.toSummary(tx, actor, currency, configured, {
        plan: planToDto(current.plan, configured),
        subscribedPlanCode: current.subscribedPlan.code,
        status: current.status,
        provider: sub.provider as PaymentProviderId | null,
        trialEndsAt: sub.trialEndsAt?.toISOString() ?? null,
        currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null,
        cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
        hasPaidSubscription: paying,
        canManagePayment: paying && Boolean(this.providers[sub.provider as PaymentProviderId]),
      });
    });
  }

  private async toSummary(
    tx: TenantTx,
    actor: BillingActor,
    currency: string,
    configured: PaymentProviderId[],
    part: Pick<
      BillingSummaryDto,
      | 'plan'
      | 'subscribedPlanCode'
      | 'status'
      | 'provider'
      | 'trialEndsAt'
      | 'currentPeriodEnd'
      | 'cancelAtPeriodEnd'
      | 'hasPaidSubscription'
      | 'canManagePayment'
    >,
  ): Promise<BillingSummaryDto> {
    const profile = await this.loadProfile(tx, actor.orgId);
    const tax = await taxRateFor(tx, profile.billingCountry);
    return {
      ...part,
      usage: await planUsage(tx, actor.orgId),
      currency,
      providers: configured,
      profile,
      taxRateBps: tax.rateBps,
      taxLabel: tax.label,
    };
  }

  private loadProfile(tx: TenantTx, orgId: string): Promise<BillingProfileDto> {
    return tx.organization.findUniqueOrThrow({
      where: { id: orgId },
      select: {
        billingName: true,
        billingEmail: true,
        billingAddress: true,
        billingCountry: true,
        taxId: true,
      },
    });
  }

  async updateProfile(
    actor: BillingActor,
    input: UpdateBillingProfileInput,
  ): Promise<BillingProfileDto> {
    return this.db.run(async (tx) => {
      await tx.organization.update({ where: { id: actor.orgId }, data: input });
      await this.audit.record(tx, actor.orgId, {
        action: AuditAction.BILLING_PROFILE_CHANGED,
        actorUserId: actor.userId,
        meta: actor.meta,
      });
      return this.loadProfile(tx, actor.orgId);
    });
  }

  async invoices(q: ListInvoicesQuery): Promise<CursorPage<InvoiceDto>> {
    const cursor = q.cursor ? decodeCursor(q.cursor) : null;
    const rows = await this.db.run((tx) =>
      tx.invoice.findMany({
        where: cursor
          ? {
              OR: [
                { issuedAt: { lt: cursor.createdAt } },
                { issuedAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }
          : {},
        orderBy: [{ issuedAt: 'desc' }, { id: 'desc' }],
        take: q.limit + 1,
      }),
    );
    const page = rows.slice(0, q.limit);
    const last = page.at(-1);
    return {
      items: page.map(invoiceToDto),
      nextCursor:
        rows.length > q.limit && last
          ? encodeCursor({ createdAt: last.issuedAt, id: last.id })
          : null,
    };
  }

  // ------------------------------------------------------------------ subscriptions

  /**
   * Send someone to pay for a plan, or change the plan they already pay for. Nothing changes here:
   * the plan only moves when the provider's webhook says so.
   */
  async checkout(actor: BillingActor, input: CheckoutInput): Promise<CheckoutResultDto> {
    const { currency } = await this.wallet.get(actor);
    const { price, sub, email } = await this.db.run(async (tx) => {
      const plan = await tx.plan.findFirst({ where: { code: input.planCode, isPublic: true } });
      if (!plan) throw new AppError(ErrorCode.NOT_FOUND, 'Plan not found');
      return {
        price: await tx.planPrice.findUnique({
          where: {
            planId_currency_interval: {
              planId: plan.id,
              currency,
              interval: input.interval,
            },
          },
        }),
        sub: await tx.subscription.findUnique({ where: { orgId: actor.orgId } }),
        email: (await this.loadProfile(tx, actor.orgId)).billingEmail,
      };
    });
    const usable: PaymentProviderId[] = [];
    if (price?.stripePriceId) usable.push('stripe');
    if (price?.razorpayPlanId) usable.push('razorpay');
    if (!price || usable.length === 0) {
      throw new AppError(
        ErrorCode.BILLING_PRICE_UNAVAILABLE,
        `This plan cannot be bought in ${currency} yet`,
      );
    }

    // Someone already paying keeps their provider, since their card is saved there.
    const live =
      sub?.providerSubscriptionId &&
      sub.provider &&
      (sub.status === 'active' || sub.status === 'past_due')
        ? this.providers[sub.provider as PaymentProviderId]
        : undefined;
    const provider =
      live && usable.includes(live.id) ? live : this.pickProvider(currency, input.provider, usable);
    const priceRef = price[provider.priceColumn];
    if (!priceRef) throw new Error('A usable price has no provider reference');

    const audit = () =>
      this.db.run((tx) =>
        this.audit.record(tx, actor.orgId, {
          action: AuditAction.BILLING_CHECKOUT_STARTED,
          actorUserId: actor.userId,
          metadata: { planCode: input.planCode, interval: input.interval, provider: provider.id },
          meta: actor.meta,
        }),
      );

    if (live === provider && sub?.providerSubscriptionId) {
      const subscriptionRef = sub.providerSubscriptionId;
      await callProvider(() => provider.changePlan({ subscriptionRef, priceRef }));
      await audit();
      return { url: null };
    }
    const result = await callProvider(() =>
      provider.createSubscriptionCheckout({
        orgId: actor.orgId,
        priceRef,
        interval: input.interval,
        customerRef: sub?.provider === provider.id ? sub.providerCustomerId : null,
        customerEmail: email,
        successUrl: this.url('/settings/billing?payment=done'),
        cancelUrl: this.url('/settings/billing?payment=cancelled'),
      }),
    );
    await audit();
    return { url: result.url };
  }

  private async paidSubscription(actor: BillingActor) {
    const sub = await this.db.run((tx) =>
      tx.subscription.findUnique({ where: { orgId: actor.orgId } }),
    );
    const provider = sub?.provider ? this.providers[sub.provider as PaymentProviderId] : undefined;
    if (!sub?.providerSubscriptionId || !provider) return null;
    return { sub, provider, subscriptionRef: sub.providerSubscriptionId };
  }

  /** Stops at the end of the period already paid for. */
  async cancel(actor: BillingActor): Promise<void> {
    const paid = await this.paidSubscription(actor);
    if (!paid) throw new AppError(ErrorCode.CONFLICT, 'There is no paid subscription to cancel');
    await callProvider(() => paid.provider.cancelAtPeriodEnd(paid.subscriptionRef));
    await this.db.run(async (tx) => {
      // Razorpay does not report this back, so it is recorded once the provider has accepted it.
      await tx.subscription.update({
        where: { orgId: actor.orgId },
        data: { cancelAtPeriodEnd: true },
      });
      await this.audit.record(tx, actor.orgId, {
        action: AuditAction.BILLING_CANCEL_REQUESTED,
        actorUserId: actor.userId,
        meta: actor.meta,
      });
    });
    this.realtime.emit(actor.orgId, 'billing:updated', {});
  }

  async managePayment(actor: BillingActor): Promise<CheckoutResultDto> {
    const paid = await this.paidSubscription(actor);
    if (!paid) return { url: null };
    return {
      url: await callProvider(() =>
        paid.provider.managePaymentUrl({
          subscriptionRef: paid.subscriptionRef,
          customerRef: paid.sub.providerCustomerId,
          returnUrl: this.url('/settings/billing'),
        }),
      ),
    };
  }

  // ------------------------------------------------------------------ top-ups

  private async quoteFor(tx: TenantTx, orgId: string, currency: string, amount: string) {
    const creditMicros = decimalToMicros(amount);
    if (creditMicros === null) throw new AppError(ErrorCode.VALIDATION_FAILED, 'Enter an amount');
    const org = await tx.organization.findUniqueOrThrow({
      where: { id: orgId },
      select: { billingCountry: true, billingEmail: true },
    });
    const tax = await taxRateFor(tx, org.billingCountry);
    const totals = taxOnTop(creditMicros, tax.rateBps);
    return {
      email: org.billingEmail,
      quote: {
        currency,
        creditMicros,
        taxMicros: totals.taxMicros,
        taxRateBps: tax.rateBps,
        taxLabel: tax.label,
        totalMicros: totals.totalMicros,
      } satisfies TopupQuoteDto,
    };
  }

  async topupQuote(actor: BillingActor, amount: string): Promise<TopupQuoteDto> {
    const { currency } = await this.wallet.get(actor);
    const { quote } = await this.db.run((tx) => this.quoteFor(tx, actor.orgId, currency, amount));
    return quote;
  }

  /**
   * Start a top-up. This only records the intent and opens the provider's page. The wallet moves
   * when a verified webhook reports the money was captured, never because a browser came back.
   */
  async createTopup(actor: BillingActor, input: CreateTopupInput): Promise<CheckoutResultDto> {
    const { currency } = await this.wallet.get(actor);
    const provider = this.pickProvider(currency, input.provider);
    const { topup, email, quote } = await this.db.run(async (tx) => {
      const { quote, email } = await this.quoteFor(tx, actor.orgId, currency, input.amount);
      const topup = await tx.walletTopup.create({
        data: {
          orgId: actor.orgId,
          provider: provider.id,
          currency,
          creditMicros: BigInt(quote.creditMicros),
          taxMicros: BigInt(quote.taxMicros),
          taxRateBps: quote.taxRateBps,
          taxLabel: quote.taxLabel,
          totalMicros: BigInt(quote.totalMicros),
          createdById: actor.userId,
        },
      });
      await this.audit.record(tx, actor.orgId, {
        action: AuditAction.WALLET_TOPUP_STARTED,
        actorUserId: actor.userId,
        targetType: 'wallet_topup',
        targetId: topup.id,
        metadata: { amountMicros: quote.creditMicros, currency, provider: provider.id },
        meta: actor.meta,
      });
      return { topup, email, quote };
    });

    try {
      const result = await callProvider(() =>
        provider.createTopupCheckout({
          topupId: topup.id,
          orgId: actor.orgId,
          totalMicros: quote.totalMicros,
          currency,
          description: 'Wallet top-up',
          customerEmail: email,
          successUrl: this.url('/wallet?payment=done'),
          cancelUrl: this.url('/wallet?payment=cancelled'),
        }),
      );
      await this.db.run((tx) =>
        tx.walletTopup.update({
          where: { id: topup.id },
          data: { providerRef: result.providerRef },
        }),
      );
      return { url: result.url };
    } catch (err) {
      await this.db
        .run((tx) =>
          tx.walletTopup.update({
            where: { id: topup.id },
            data: {
              status: 'failed',
              failure: err instanceof Error ? err.message.slice(0, 500) : 'Failed',
            },
          }),
        )
        .catch((markErr: unknown) =>
          this.logger.warn(`could not mark a top-up: ${String(markErr)}`),
        );
      throw err;
    }
  }
}
