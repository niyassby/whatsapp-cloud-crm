import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { closePartnerMonth, Prisma, statementToDto } from '@wacrm/db';
import {
  type AdminOrgDto,
  type AdminOrgListQuery,
  type AdminPlanDto,
  type AdminRateCardDto,
  AppError,
  type CreatePartnerInput,
  type CreateRateCardInput,
  type CursorPage,
  DEFAULT_JOB_OPTIONS,
  decimalToMicros,
  ErrorCode,
  type PartnerDto,
  type PartnerMemberDto,
  type PartnerStatementDto,
  type PlanFeature,
  QueueName,
  type QueueStatusDto,
  type SystemStatusDto,
  type UpdatePartnerInput,
  type UpdatePlanInput,
  type WholesalePriceInput,
} from '@wacrm/shared';
import { redisConnectionFromUrl } from '@wacrm/shared/server';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { AuditService, PlatformAuditAction } from '../audit/audit.service';
import { AuthService, slugify } from '../auth/auth.service';
import { PrismaService } from '../db/prisma.service';
import { API_ENV, type ApiEnv } from '../env';
import { REDIS } from '../infra/infra.tokens';
import { decodeCursor, encodeCursor } from '../orgs/cursor';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service';
import { toPartnerDto } from './partner.service';
import type { Operator } from './workspaces.service';

const timed = async (fn: () => Promise<unknown>) => {
  const started = Date.now();
  try {
    await fn();
    return { ok: true, latencyMs: Date.now() - started };
  } catch {
    return { ok: false, latencyMs: null };
  }
};

/**
 * The platform's own console. Every method runs with `app.platform_admin` on, which Postgres
 * honours only for a user with a platform_admins row, so the route guard and RLS both have to
 * agree before anything here is visible.
 */
@Injectable()
export class AdminService implements OnModuleDestroy {
  /** One handle per queue, only to read counts. The worker owns the processing. */
  private readonly queues: Queue[];

  constructor(
    @Inject(API_ENV) private readonly env: ApiEnv,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly db: TenantPrismaService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly auth: AuthService,
  ) {
    const opts = {
      connection: {
        ...redisConnectionFromUrl(env.REDIS_URL),
        enableOfflineQueue: false,
        maxRetriesPerRequest: 2,
      },
      prefix: env.QUEUE_PREFIX,
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    };
    this.queues = Object.values(QueueName).map((name) => new Queue(name, opts));
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all(this.queues.map((q) => q.close()));
  }

  // ------------------------------------------------------------------ partners

  async listPartners(): Promise<PartnerDto[]> {
    return this.db.runAsOperator(async (tx) => {
      const partners = await tx.partner.findMany({ orderBy: { createdAt: 'desc' }, take: 500 });
      const counts = await tx.organization.groupBy({
        by: ['partnerId'],
        where: { partnerId: { not: null }, deletedAt: null },
        _count: true,
      });
      const byPartner = new Map(counts.map((c) => [c.partnerId, c._count]));
      return partners.map((p) => toPartnerDto(p, byPartner.get(p.id) ?? 0));
    });
  }

  async createPartner(by: Operator, input: CreatePartnerInput): Promise<PartnerDto> {
    const adminUserId = input.adminEmail ? await this.userIdByEmail(input.adminEmail) : null;
    const partner = await this.db.runAsOperator(async (tx) => {
      const created = await tx.partner.create({
        data: {
          name: input.name,
          slug: slugify(input.name),
          currency: input.currency,
          maxClients: input.maxClients,
          walletMarkupBps: input.walletMarkupBps,
        },
      });
      if (adminUserId) await this.addMemberTx(tx, created.id, adminUserId);
      await this.audit.recordPlatform(tx, {
        action: PlatformAuditAction.PARTNER_CREATED,
        actorUserId: by.userId,
        partnerId: created.id,
        targetType: 'partner',
        targetId: created.id,
        metadata: { name: input.name, currency: input.currency, admin: input.adminEmail ?? null },
        meta: by.meta,
      });
      return created;
    });
    return toPartnerDto(partner, 0);
  }

  async updatePartner(by: Operator, id: string, input: UpdatePartnerInput): Promise<PartnerDto> {
    return this.db.runAsOperator(async (tx) => {
      const existing = await tx.partner.findUnique({ where: { id } });
      if (!existing) throw new AppError(ErrorCode.NOT_FOUND, 'Partner not found');
      const partner = await tx.partner.update({ where: { id }, data: input });
      await this.audit.recordPlatform(tx, {
        action: PlatformAuditAction.PARTNER_CHANGED,
        actorUserId: by.userId,
        partnerId: id,
        targetType: 'partner',
        targetId: id,
        metadata: input,
        meta: by.meta,
      });
      const clientCount = await tx.organization.count({
        where: { partnerId: id, deletedAt: null },
      });
      return toPartnerDto(partner, clientCount);
    });
  }

  async listMembers(partnerId: string): Promise<PartnerMemberDto[]> {
    const rows = await this.db.runAsOperator((tx) =>
      tx.partnerMember.findMany({
        where: { partnerId },
        orderBy: { createdAt: 'asc' },
        include: { user: { select: { name: true, email: true } } },
      }),
    );
    return rows.map((m) => ({
      userId: m.userId,
      name: m.user.name,
      email: m.user.email,
      createdAt: m.createdAt.toISOString(),
    }));
  }

  /** Staff are added from existing accounts: the person signs up first, like anyone else. */
  async addMember(by: Operator, partnerId: string, email: string): Promise<PartnerMemberDto[]> {
    const userId = await this.userIdByEmail(email);
    await this.db.runAsOperator(async (tx) => {
      const partner = await tx.partner.findUnique({ where: { id: partnerId } });
      if (!partner) throw new AppError(ErrorCode.NOT_FOUND, 'Partner not found');
      await this.addMemberTx(tx, partnerId, userId);
      await this.audit.recordPlatform(tx, {
        action: PlatformAuditAction.PARTNER_MEMBER_ADDED,
        actorUserId: by.userId,
        partnerId,
        targetType: 'user',
        targetId: userId,
        metadata: { email },
        meta: by.meta,
      });
    });
    return this.listMembers(partnerId);
  }

  async removeMember(by: Operator, partnerId: string, userId: string): Promise<void> {
    await this.db.runAsOperator(async (tx) => {
      const removed = await tx.partnerMember.deleteMany({ where: { partnerId, userId } });
      if (removed.count === 0) throw new AppError(ErrorCode.NOT_FOUND, 'Member not found');
      await this.audit.recordPlatform(tx, {
        action: PlatformAuditAction.PARTNER_MEMBER_REMOVED,
        actorUserId: by.userId,
        partnerId,
        targetType: 'user',
        targetId: userId,
        meta: by.meta,
      });
    });
  }

  private async userIdByEmail(email: string): Promise<string> {
    const user = await this.auth.lookupUserByEmail(email);
    if (!user) {
      throw new AppError(
        ErrorCode.NOT_FOUND,
        'No account has this email. Ask them to sign up first, then add them.',
      );
    }
    return user.id;
  }

  private async addMemberTx(tx: Prisma.TransactionClient, partnerId: string, userId: string) {
    try {
      // createMany: no row is read back, so the nested savepoint Prisma would need is avoided.
      const { count } = await tx.partnerMember.createMany({
        data: [{ partnerId, userId }],
        skipDuplicates: true,
      });
      if (count === 0) {
        throw new AppError(ErrorCode.CONFLICT, 'This person already works for a partner');
      }
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError(ErrorCode.CONFLICT, 'This person already works for a partner');
    }
  }

  // ------------------------------------------------------------------ organizations

  async listOrgs(q: AdminOrgListQuery): Promise<CursorPage<AdminOrgDto>> {
    const cursor = q.cursor ? decodeCursor(q.cursor) : null;
    const where: Prisma.OrganizationWhereInput = {
      ...(q.partnerId ? { partnerId: q.partnerId } : {}),
      ...(q.search
        ? {
            OR: [
              { name: { contains: q.search, mode: 'insensitive' } },
              { slug: { contains: q.search.toLowerCase() } },
            ],
          }
        : {}),
      ...(cursor
        ? {
            AND: [
              {
                OR: [
                  { createdAt: { lt: cursor.createdAt } },
                  { createdAt: cursor.createdAt, id: { lt: cursor.id } },
                ],
              },
            ],
          }
        : {}),
    };
    const rows = await this.db.runAsOperator((tx) =>
      tx.organization.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: q.limit + 1,
        include: {
          partner: { select: { name: true } },
          subscription: { select: { plan: { select: { code: true } } } },
          wallet: { select: { currency: true, balanceMicros: true } },
        },
      }),
    );
    const page = rows.slice(0, q.limit);
    const last = page.at(-1);
    return {
      items: page.map((o) => ({
        id: o.id,
        name: o.name,
        slug: o.slug,
        status: o.status,
        deleted: o.deletedAt !== null,
        partnerId: o.partnerId,
        partnerName: o.partner?.name ?? null,
        planCode: o.subscription?.plan.code ?? null,
        currency: o.wallet?.currency ?? null,
        balanceMicros: o.wallet ? Number(o.wallet.balanceMicros) : null,
        createdAt: o.createdAt.toISOString(),
      })),
      nextCursor: rows.length > q.limit && last ? encodeCursor(last) : null,
    };
  }

  async planByCode(code: string): Promise<{ id: string; code: string }> {
    const plan = await this.db.runAsOperator((tx) =>
      tx.plan.findUnique({ where: { code }, select: { id: true, code: true } }),
    );
    if (!plan) throw new AppError(ErrorCode.NOT_FOUND, 'Plan not found');
    return plan;
  }

  /** The wallet currency of a workspace, or the installation's default when it has no wallet. */
  async orgCurrency(orgId: string): Promise<string> {
    const wallet = await this.db.runAsOperator((tx) =>
      tx.wallet.findUnique({ where: { orgId }, select: { currency: true } }),
    );
    return wallet?.currency ?? this.env.WALLET_DEFAULT_CURRENCY;
  }

  // ------------------------------------------------------------------ plans and feature flags

  async listPlans(): Promise<AdminPlanDto[]> {
    const plans = await this.db.runAsOperator((tx) =>
      tx.plan.findMany({ orderBy: { sortOrder: 'asc' }, include: { wholesalePrices: true } }),
    );
    return plans.map((p) => ({
      code: p.code,
      name: p.name,
      description: p.description,
      seats: p.seats,
      numbers: p.numbers,
      contacts: p.contacts,
      features: p.features as PlanFeature[],
      isPublic: p.isPublic,
      isTrial: p.isTrial,
      wholesale: p.wholesalePrices.map((w) => ({
        currency: w.currency,
        amountMicros: Number(w.amountMicros),
      })),
    }));
  }

  /** Limits and features of a plan. Every workspace on it follows at once: nothing is copied. */
  async updatePlan(by: Operator, code: string, input: UpdatePlanInput): Promise<AdminPlanDto[]> {
    await this.db.runAsOperator(async (tx) => {
      // updateMany: the app role may change these columns only, and must not read the row back
      // through a full-row UPDATE ... RETURNING on columns it cannot write.
      const { count } = await tx.plan.updateMany({ where: { code }, data: input });
      if (count === 0) throw new AppError(ErrorCode.NOT_FOUND, 'Plan not found');
      await this.audit.recordPlatform(tx, {
        action: PlatformAuditAction.PLAN_CHANGED,
        actorUserId: by.userId,
        targetType: 'plan',
        targetId: code,
        metadata: input,
        meta: by.meta,
      });
    });
    return this.listPlans();
  }

  async setWholesalePrice(
    by: Operator,
    code: string,
    input: WholesalePriceInput,
  ): Promise<AdminPlanDto[]> {
    const plan = await this.planByCode(code);
    const amount = input.amount === null ? null : decimalToMicros(input.amount);
    await this.db.runAsOperator(async (tx) => {
      const key = { planId_currency: { planId: plan.id, currency: input.currency } };
      if (amount === null) {
        await tx.wholesalePlanPrice.deleteMany({
          where: { planId: plan.id, currency: input.currency },
        });
      } else {
        await tx.wholesalePlanPrice.upsert({
          where: key,
          create: { planId: plan.id, currency: input.currency, amountMicros: BigInt(amount) },
          update: { amountMicros: BigInt(amount) },
        });
      }
      await this.audit.recordPlatform(tx, {
        action: PlatformAuditAction.WHOLESALE_PRICE_CHANGED,
        actorUserId: by.userId,
        targetType: 'plan',
        targetId: code,
        metadata: { currency: input.currency, amount: input.amount },
        meta: by.meta,
      });
    });
    return this.listPlans();
  }

  // ------------------------------------------------------------------ rate cards

  /** The rate in force now for each country and category, like the wallet's own price list. */
  async listRateCards(currency?: string): Promise<AdminRateCardDto[]> {
    const rows = await this.db.runAsOperator((tx) =>
      tx.rateCard.findMany({
        where: { ...(currency ? { currency } : {}), validFrom: { lte: new Date() } },
        orderBy: { validFrom: 'desc' },
        take: 10_000,
      }),
    );
    const seen = new Set<string>();
    const out: AdminRateCardDto[] = [];
    for (const r of rows) {
      const key = `${r.currency}|${r.country}|${r.category}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        id: r.id,
        country: r.country,
        category: r.category,
        currency: r.currency,
        rateMicros: Number(r.rateMicros),
        validFrom: r.validFrom.toISOString(),
      });
    }
    return out.sort(
      (a, b) =>
        a.currency.localeCompare(b.currency) ||
        a.country.localeCompare(b.country) ||
        a.category.localeCompare(b.category),
    );
  }

  /** A new price is a new row with a later start. Past charges keep the rate copied onto them. */
  async addRateCard(by: Operator, input: CreateRateCardInput): Promise<AdminRateCardDto[]> {
    const rateMicros = decimalToMicros(input.rate);
    if (rateMicros === null || rateMicros < 0) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'Enter a valid rate');
    }
    const validFrom = input.validFrom ? new Date(input.validFrom) : new Date();
    await this.db.runAsOperator(async (tx) => {
      const { count } = await tx.rateCard.createMany({
        data: [
          {
            country: input.country,
            category: input.category,
            currency: input.currency,
            rateMicros: BigInt(rateMicros),
            validFrom,
          },
        ],
        skipDuplicates: true,
      });
      if (count === 0) {
        throw new AppError(ErrorCode.CONFLICT, 'A rate already starts at exactly this time');
      }
      await this.audit.recordPlatform(tx, {
        action: PlatformAuditAction.RATE_CARD_ADDED,
        actorUserId: by.userId,
        targetType: 'rate_card',
        metadata: { ...input, validFrom: validFrom.toISOString() },
        meta: by.meta,
      });
    });
    return this.listRateCards(input.currency);
  }

  // ------------------------------------------------------------------ statements

  async listStatements(status?: 'issued' | 'paid'): Promise<PartnerStatementDto[]> {
    const rows = await this.db.runAsOperator((tx) =>
      tx.partnerStatement.findMany({
        where: status ? { status } : {},
        orderBy: [{ period: 'desc' }, { issuedAt: 'desc' }],
        take: 500,
        include: { partner: { select: { name: true } } },
      }),
    );
    return rows.map((r) => statementToDto(r, r.partner.name));
  }

  /** Close a finished month by hand. The worker does the same for every partner each day. */
  async closeStatement(
    by: Operator,
    partnerId: string,
    period: string,
  ): Promise<PartnerStatementDto | null> {
    const result = await closePartnerMonth(this.prisma.client, partnerId, period);
    if (result.created && result.statement) {
      await this.db.runAsOperator((tx) =>
        this.audit.recordPlatform(tx, {
          action: PlatformAuditAction.STATEMENT_CLOSED,
          actorUserId: by.userId,
          partnerId,
          targetType: 'statement',
          targetId: result.statement?.id,
          metadata: { period },
          meta: by.meta,
        }),
      );
    }
    return result.statement;
  }

  /** Record that the partner paid a statement. The money itself moved outside this system. */
  async markStatementPaid(by: Operator, id: string, reference: string): Promise<void> {
    await this.db.runAsOperator(async (tx) => {
      const paid = await tx.partnerStatement.updateMany({
        where: { id, status: 'issued' },
        data: {
          status: 'paid',
          paidAt: new Date(),
          paymentReference: reference,
          paidById: by.userId,
        },
      });
      if (paid.count !== 1) {
        throw new AppError(ErrorCode.CONFLICT, 'This statement is not waiting for payment');
      }
      const row = await tx.partnerStatement.findUniqueOrThrow({ where: { id } });
      await this.audit.recordPlatform(tx, {
        action: PlatformAuditAction.STATEMENT_PAID,
        actorUserId: by.userId,
        partnerId: row.partnerId,
        targetType: 'statement',
        targetId: id,
        metadata: { period: row.period, reference },
        meta: by.meta,
      });
    });
  }

  // ------------------------------------------------------------------ audit and system

  async auditLog(q: { cursor?: string; limit: number }) {
    const cursor = q.cursor ? decodeCursor(q.cursor) : null;
    const rows = await this.db.runAsOperator((tx) =>
      tx.platformAuditLog.findMany({
        where: cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }
          : undefined,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: q.limit + 1,
      }),
    );
    const page = rows.slice(0, q.limit);
    const last = page.at(-1);
    return {
      items: page.map((r) => ({
        id: r.id,
        action: r.action,
        actorUserId: r.actorUserId,
        partnerId: r.partnerId,
        targetType: r.targetType,
        targetId: r.targetId,
        metadata: r.metadata,
        createdAt: r.createdAt.toISOString(),
      })),
      nextCursor: rows.length > q.limit && last ? encodeCursor(last) : null,
    };
  }

  async system(): Promise<SystemStatusDto> {
    const database = await timed(() => this.prisma.ping());
    const redis = await timed(() => this.redis.ping());
    const queues: QueueStatusDto[] = [];
    if (redis.ok) {
      for (const queue of this.queues) {
        const c = await queue
          .getJobCounts('waiting', 'active', 'delayed', 'failed')
          .catch(() => ({}) as Record<string, number>);
        queues.push({
          name: queue.name,
          waiting: c.waiting ?? 0,
          active: c.active ?? 0,
          delayed: c.delayed ?? 0,
          failed: c.failed ?? 0,
        });
      }
    }
    const counts = database.ok
      ? await this.db.runAsOperator(async (tx) => ({
          organizations: await tx.organization.count({ where: { deletedAt: null } }),
          partners: await tx.partner.count(),
        }))
      : { organizations: 0, partners: 0 };
    return { database, redis, queues, counts, checkedAt: new Date().toISOString() };
  }
}
