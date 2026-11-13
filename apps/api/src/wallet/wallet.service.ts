import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  clientPartnerPricing,
  ensureWallet,
  ledgerToDto,
  type Prisma,
  walletToDto,
} from '@wacrm/db';
import {
  applyMarkup,
  csvCell,
  type CursorPage,
  decimalToMicros,
  ErrorCode,
  AppError,
  formatMoney,
  hasPermission,
  type LedgerEntryDto,
  type ListLedgerQuery,
  microsToDecimal,
  Permission,
  type RateDto,
  ROLES,
  type UpdateWalletInput,
  type WalletDto,
  type WalletRangeQuery,
  type WalletUsageDto,
} from '@wacrm/shared';
import { AuditAction, AuditService } from '../audit/audit.service';
import type { RequestMeta } from '../common/request-meta';
import { API_ENV, type ApiEnv } from '../env';
import { MAILER, type Mailer } from '../infra/mailer';
import { decodeCursor, encodeCursor } from '../orgs/cursor';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service';

export interface WalletActor {
  userId: string;
  orgId: string;
  meta?: RequestMeta;
}

/** A bound on memory: this runs inside the API. Narrow the dates for more. */
const EXPORT_ROW_LIMIT = 100_000;
const EXPORT_PAGE = 2_000;

const rangeWhere = (q: { from?: string; to?: string }): Prisma.WalletLedgerWhereInput =>
  q.from || q.to
    ? {
        createdAt: {
          ...(q.from ? { gte: new Date(q.from) } : {}),
          ...(q.to ? { lte: new Date(q.to) } : {}),
        },
      }
    : {};

@Injectable()
export class WalletService {
  private readonly logger = new Logger(WalletService.name);

  constructor(
    private readonly db: TenantPrismaService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeGateway,
    @Inject(API_ENV) private readonly env: ApiEnv,
    @Inject(MAILER) private readonly mailer: Mailer,
  ) {}

  /** What a new wallet starts with, from config. */
  get defaults() {
    const threshold = decimalToMicros(this.env.WALLET_LOW_BALANCE_DEFAULT);
    return { currency: this.env.WALLET_DEFAULT_CURRENCY, thresholdMicros: threshold };
  }

  async get(actor: WalletActor): Promise<WalletDto> {
    const { currency, thresholdMicros } = this.defaults;
    const row = await this.db.run(async (tx) => {
      await ensureWallet(tx, actor.orgId, currency, thresholdMicros);
      return tx.wallet.findUniqueOrThrow({ where: { orgId: actor.orgId } });
    });
    return walletToDto(row);
  }

  async update(actor: WalletActor, input: UpdateWalletInput): Promise<WalletDto> {
    const { currency, thresholdMicros } = this.defaults;
    const threshold =
      input.lowBalanceThreshold === null ? null : decimalToMicros(input.lowBalanceThreshold);
    const row = await this.db.run(async (tx) => {
      await ensureWallet(tx, actor.orgId, currency, thresholdMicros);
      await this.audit.record(tx, actor.orgId, {
        action: AuditAction.WALLET_SETTINGS_CHANGED,
        actorUserId: actor.userId,
        metadata: { lowBalanceThreshold: input.lowBalanceThreshold },
        meta: actor.meta,
      });
      return tx.wallet.update({
        where: { orgId: actor.orgId },
        data: {
          lowBalanceThresholdMicros: threshold === null ? null : BigInt(threshold),
          // A new threshold starts fresh, so the next crossing alerts.
          lowBalanceAlertedAt: null,
        },
      });
    });
    this.realtime.emit(actor.orgId, 'wallet:updated', {});
    return walletToDto(row);
  }

  async ledger(q: ListLedgerQuery): Promise<CursorPage<LedgerEntryDto>> {
    const cursor = q.cursor ? decodeCursor(q.cursor) : null;
    const rows = await this.db.run((tx) =>
      tx.walletLedger.findMany({
        where: {
          AND: [
            rangeWhere(q),
            q.type ? { type: q.type } : {},
            cursor
              ? {
                  OR: [
                    { createdAt: { lt: cursor.createdAt } },
                    { createdAt: cursor.createdAt, id: { lt: cursor.id } },
                  ],
                }
              : {},
          ],
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: q.limit + 1,
      }),
    );
    const page = rows.slice(0, q.limit);
    const last = page.at(-1);
    return {
      items: page.map(ledgerToDto),
      nextCursor:
        rows.length > q.limit && last
          ? encodeCursor({ createdAt: last.createdAt, id: last.id })
          : null,
    };
  }

  /** Cost by category, after refunds. Credits and adjustments are not usage. */
  async usage(actor: WalletActor, q: WalletRangeQuery): Promise<WalletUsageDto> {
    const { wallet, groups } = await this.db.run(async (tx) => ({
      wallet: await tx.wallet.findUnique({
        where: { orgId: actor.orgId },
        select: { currency: true },
      }),
      groups: await tx.walletLedger.groupBy({
        by: ['category', 'type'],
        where: { ...rangeWhere(q), type: { in: ['debit', 'refund'] } },
        _sum: { amountMicros: true },
        _count: { _all: true },
      }),
    }));
    const totals = new Map<string, { messages: number; cost: number }>();
    for (const g of groups) {
      const category = g.category ?? 'other';
      const row = totals.get(category) ?? { messages: 0, cost: 0 };
      row.cost -= Number(g._sum.amountMicros ?? 0n);
      row.messages += g.type === 'debit' ? g._count._all : -g._count._all;
      totals.set(category, row);
    }
    const rows = [...totals.entries()]
      .map(([category, t]) => ({ category, messages: t.messages, costMicros: t.cost }))
      .sort((x, y) => y.costMicros - x.costMicros);
    return {
      currency: wallet?.currency ?? this.env.WALLET_DEFAULT_CURRENCY,
      rows,
      totalMicros: rows.reduce((sum, r) => sum + r.costMicros, 0),
    };
  }

  /** Current prices in this wallet's currency: the newest row in force for each pair. */
  async rates(actor: WalletActor): Promise<RateDto[]> {
    const { currency } = await this.get(actor);
    const { rows, markupBps } = await this.db.run(async (tx) => ({
      rows: await tx.rateCard.findMany({
        where: { currency, validFrom: { lte: new Date() } },
        orderBy: { validFrom: 'desc' },
        take: 5_000,
      }),
      // A partner's client sees what it will be charged, never the wholesale price.
      markupBps: (await clientPartnerPricing(tx))?.markupBps ?? 0,
    }));
    const seen = new Set<string>();
    const out: RateDto[] = [];
    for (const r of rows) {
      const key = `${r.country}|${r.category}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        country: r.country,
        category: r.category,
        currency: r.currency,
        rateMicros: applyMarkup(Number(r.rateMicros), markupBps),
        validFrom: r.validFrom.toISOString(),
      });
    }
    return out.sort(
      (a, b) => a.country.localeCompare(b.country) || a.category.localeCompare(b.category),
    );
  }

  /** The ledger as CSV. Pages through in short transactions, so it holds no connection long. */
  async exportCsv(actor: WalletActor, q: WalletRangeQuery): Promise<string> {
    const lines = [
      'date,type,amount,balance_after,currency,category,country,rate,reference_type,reference_id,description',
    ];
    const { currency } = await this.get(actor);
    const money = (micros: bigint | null) =>
      micros === null ? '' : microsToDecimal(Number(micros));
    let cursor: { createdAt: Date; id: string } | null = null;
    let count = 0;
    const fetchPage = (after: { createdAt: Date; id: string } | null) =>
      this.db.run((tx) =>
        tx.walletLedger.findMany({
          where: {
            AND: [
              rangeWhere(q),
              after
                ? {
                    OR: [
                      { createdAt: { lt: after.createdAt } },
                      { createdAt: after.createdAt, id: { lt: after.id } },
                    ],
                  }
                : {},
            ],
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: EXPORT_PAGE,
        }),
      );
    for (;;) {
      const page = await fetchPage(cursor);
      for (const e of page) {
        lines.push(
          [
            e.createdAt.toISOString(),
            e.type,
            // Written directly: csvCell would treat a minus sign as the start of a formula.
            money(e.amountMicros),
            money(e.balanceAfterMicros),
            currency,
            csvCell(e.category),
            csvCell(e.country),
            money(e.rateMicros),
            csvCell(e.referenceType),
            csvCell(e.referenceId),
            csvCell(e.description),
          ].join(','),
        );
      }
      count += page.length;
      const last = page.at(-1);
      if (!last || page.length < EXPORT_PAGE) break;
      if (count >= EXPORT_ROW_LIMIT) {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          'That is too many entries to export at once. Choose a shorter date range.',
        );
      }
      cursor = { createdAt: last.createdAt, id: last.id };
    }
    await this.db.run((tx) =>
      this.audit.record(tx, actor.orgId, {
        action: AuditAction.WALLET_EXPORTED,
        actorUserId: actor.userId,
        metadata: { rows: count, from: q.from ?? null, to: q.to ?? null },
        meta: actor.meta,
      }),
    );
    return `${lines.join('\r\n')}\r\n`;
  }

  /** Send a charge or refund to open screens. */
  changed(orgId: string): void {
    this.realtime.emit(orgId, 'wallet:updated', {});
  }

  /**
   * Tell the people who can top up. In the background: a slow mail server must not hold up a send,
   * and the balance banner shows in the app either way.
   */
  alertLowBalance(orgId: string): void {
    void this.sendLowBalanceEmail(orgId).catch((err: unknown) => {
      this.logger.error(`could not send a low balance alert: ${String(err)}`);
    });
  }

  private async sendLowBalanceEmail(orgId: string): Promise<void> {
    const roles = ROLES.filter((r) => hasPermission(r, Permission.BILLING_MANAGE));
    const { org, wallet, members } = await this.db.run(async (tx) => ({
      org: await tx.organization.findUniqueOrThrow({
        where: { id: orgId },
        select: { name: true },
      }),
      wallet: await tx.wallet.findUniqueOrThrow({ where: { orgId } }),
      members: await tx.membership.findMany({
        // By org explicitly: RLS also shows a user's own memberships in other orgs.
        where: { orgId, role: { in: roles }, status: 'active' },
        select: { user: { select: { email: true } } },
      }),
    }));
    const balance = formatMoney(Number(wallet.balanceMicros), wallet.currency);
    const subject = `Low wallet balance for ${org.name}`;
    const link = `${this.env.WEB_URL}/wallet`;
    const text = `The wallet for ${org.name} is down to ${balance}. Sends that cost money stop when it runs out.\n\nReview it here: ${link}`;
    const html = `<p>The wallet for <strong>${escapeHtml(org.name)}</strong> is down to <strong>${escapeHtml(balance)}</strong>. Sends that cost money stop when it runs out.</p><p><a href="${link}">Review the wallet</a></p>`;
    await Promise.all(
      members.map((m) => this.mailer.send({ to: m.user.email, subject, text, html })),
    );
  }
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
