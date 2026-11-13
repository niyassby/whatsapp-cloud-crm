import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  ensureWallet,
  partnerTotals,
  type Prisma,
  setPartnerManagedPlan,
  statementToDto,
  type TenantTx,
  withTenant,
} from '@wacrm/db';
import {
  AppError,
  type ClientDto,
  type CreateClientInput,
  type CursorPage,
  decimalToMicros,
  ErrorCode,
  type PartnerDto,
  type PartnerLedgerEntryDto,
  type PartnerLedgerQuery,
  type PartnerLedgerType,
  type PartnerPlanDto,
  type PartnerStatementDto,
  type PartnerTotalsDto,
  periodOf,
  type PlanFeature,
  type UpdateClientInput,
} from '@wacrm/shared';
import { AuditAction, AuditService, PlatformAuditAction } from '../audit/audit.service';
import { AuthService, slugify } from '../auth/auth.service';
import { inviteMail } from '../auth/mail-templates';
import { TokenService } from '../auth/token.service';
import { PrismaService } from '../db/prisma.service';
import { API_ENV, type ApiEnv } from '../env';
import { decodeCursor, encodeCursor } from '../orgs/cursor';
import { RateLimiter } from '../infra/rate-limiter.service';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service';
import { clientInclude, type Operator, toClientDto, WorkspacesService } from './workspaces.service';

const INVITE_TTL_MS = 7 * 24 * 3600_000;

type PartnerOperator = Operator & { partnerId: string };

export function partnerOperator(by: Operator): PartnerOperator {
  if (!by.partnerId) throw new AppError(ErrorCode.FORBIDDEN, 'Partner accounts only');
  return { ...by, partnerId: by.partnerId };
}

const priceMicros = (value: string | null | undefined): bigint | null | undefined => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const micros = decimalToMicros(value);
  if (micros === null) throw new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid price');
  return BigInt(micros);
};

/** The partner console: a partner's own settings, its client workspaces and what it owes. */
@Injectable()
export class PartnerService {
  constructor(
    @Inject(API_ENV) private readonly env: ApiEnv,
    private readonly db: TenantPrismaService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly tokens: TokenService,
    private readonly auth: AuthService,
    private readonly rateLimiter: RateLimiter,
    private readonly workspaces: WorkspacesService,
  ) {}

  // ------------------------------------------------------------------ the partner itself

  async profile(by: PartnerOperator): Promise<PartnerDto> {
    return this.db.runAsOperator(async (tx) => {
      const partner = await tx.partner.findUniqueOrThrow({ where: { id: by.partnerId } });
      const clientCount = await tx.organization.count({
        where: { partnerId: by.partnerId, deletedAt: null },
      });
      return toPartnerDto(partner, clientCount);
    });
  }

  /** The markup applies to charges from now on. Past ledger entries keep the rate they were made at. */
  async setMarkup(by: PartnerOperator, walletMarkupBps: number): Promise<PartnerDto> {
    await this.db.runAsOperator(async (tx) => {
      const before = await tx.partner.findUniqueOrThrow({
        where: { id: by.partnerId },
        select: { walletMarkupBps: true },
      });
      await tx.partner.update({ where: { id: by.partnerId }, data: { walletMarkupBps } });
      await this.audit.recordPlatform(tx, {
        action: PlatformAuditAction.PARTNER_MARKUP_CHANGED,
        actorUserId: by.userId,
        partnerId: by.partnerId,
        targetType: 'partner',
        targetId: by.partnerId,
        metadata: { from: before.walletMarkupBps, to: walletMarkupBps },
        meta: by.meta,
      });
    });
    return this.profile(by);
  }

  /** Plans the platform sells this partner: those with a wholesale price in its currency. */
  async plans(by: PartnerOperator): Promise<PartnerPlanDto[]> {
    return this.db.runAsOperator(async (tx) => {
      const { currency } = await tx.partner.findUniqueOrThrow({
        where: { id: by.partnerId },
        select: { currency: true },
      });
      const prices = await tx.wholesalePlanPrice.findMany({
        where: { currency },
        include: { plan: true },
        orderBy: { plan: { sortOrder: 'asc' } },
      });
      return prices.map(({ plan, amountMicros }) => ({
        code: plan.code,
        name: plan.name,
        description: plan.description,
        seats: plan.seats,
        numbers: plan.numbers,
        contacts: plan.contacts,
        features: plan.features as PlanFeature[],
        wholesaleMicros: Number(amountMicros),
        currency,
      }));
    });
  }

  // ------------------------------------------------------------------ clients

  async listClients(by: PartnerOperator): Promise<ClientDto[]> {
    return this.db.runAsOperator(async (tx) => {
      const { currency } = await tx.partner.findUniqueOrThrow({
        where: { id: by.partnerId },
        select: { currency: true },
      });
      const orgs = await tx.organization.findMany({
        where: { partnerId: by.partnerId, deletedAt: null },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        include: clientInclude,
        take: 500,
      });
      const wholesale = await this.workspaces.wholesalePrices(tx, currency);
      return orgs.map((o) => toClientDto(o, wholesale, currency));
    });
  }

  private async planFor(tx: TenantTx, planCode: string, currency: string) {
    const plan = await tx.plan.findUnique({
      where: { code: planCode },
      include: { wholesalePrices: { where: { currency } } },
    });
    if (!plan) throw new AppError(ErrorCode.NOT_FOUND, 'Plan not found');
    if (plan.wholesalePrices.length === 0) {
      throw new AppError(
        ErrorCode.BILLING_PRICE_UNAVAILABLE,
        'This plan is not available to partners in your currency',
      );
    }
    return plan;
  }

  /**
   * A new client workspace: its plan (billed to the partner), an empty wallet in the partner's
   * currency, any limits, and an invitation for the person who will own it. The partner's staff
   * are not members; they look inside by impersonating, which the client can see.
   */
  async createClient(by: PartnerOperator, input: CreateClientInput): Promise<ClientDto> {
    await this.rateLimiter.consume(`rl:partner-clients:${by.partnerId}`, 100, 3600);
    const orgId = randomUUID();
    const token = this.tokens.newOpaqueToken();
    const context = { orgId, userId: by.userId, partnerId: by.partnerId };

    const partnerName = await withTenant(this.prisma.client, context, async (tx) => {
      // The row lock makes the client count below exact when two are created at once.
      const [partner] = await tx.$queryRaw<
        { name: string; currency: string; max_clients: number | null }[]
      >`SELECT name, currency, max_clients FROM partners WHERE id = ${by.partnerId}::uuid FOR UPDATE`;
      if (!partner) throw new AppError(ErrorCode.FORBIDDEN, 'Partner accounts only');
      if (partner.max_clients !== null) {
        const count = await tx.organization.count({
          where: { partnerId: by.partnerId, deletedAt: null },
        });
        if (count >= partner.max_clients) {
          throw new AppError(
            ErrorCode.PARTNER_LIMIT_REACHED,
            'Your partner account has reached its limit on client workspaces',
            { limit: partner.max_clients },
          );
        }
      }
      const plan = await this.planFor(tx, input.planCode, partner.currency);

      await tx.organization.create({
        data: {
          id: orgId,
          name: input.name,
          slug: slugify(input.name),
          partnerId: by.partnerId,
          ...(input.timezone ? { timezone: input.timezone } : {}),
        },
      });
      await tx.partnerClient.create({
        data: {
          orgId,
          partnerId: by.partnerId,
          limitSeats: input.limits?.seats ?? null,
          limitNumbers: input.limits?.numbers ?? null,
          limitContacts: input.limits?.contacts ?? null,
          clientPriceMicros: priceMicros(input.clientPrice) ?? null,
          ownerEmail: input.ownerEmail,
        },
      });
      await setPartnerManagedPlan(tx, orgId, plan.id);
      await ensureWallet(tx, orgId, partner.currency, null);
      await this.createOwnerInvite(tx, orgId, input.ownerEmail, token.hash, by.userId);
      await this.audit.record(tx, orgId, {
        action: AuditAction.CLIENT_CREATED,
        actorUserId: by.userId,
        targetType: 'organization',
        targetId: orgId,
        metadata: { plan: plan.code, ownerEmail: input.ownerEmail },
        meta: by.meta,
      });
      return partner.name;
    });

    this.sendInvite(input.ownerEmail, token.raw, input.name, partnerName);
    return this.client(by, orgId);
  }

  private async createOwnerInvite(
    tx: TenantTx,
    orgId: string,
    email: string,
    tokenHash: string,
    invitedById: string,
  ): Promise<void> {
    // Only the newest invitation for an address works.
    await tx.invitation.updateMany({
      where: { orgId, email, acceptedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await tx.invitation.create({
      data: {
        orgId,
        email,
        role: 'owner',
        tokenHash,
        invitedById,
        expiresAt: new Date(Date.now() + INVITE_TTL_MS),
      },
    });
  }

  private sendInvite(email: string, rawToken: string, orgName: string, partnerName: string): void {
    this.auth.sendMail(
      inviteMail(
        this.env.APP_NAME,
        email,
        this.auth.link('/invite', rawToken),
        orgName,
        partnerName,
      ),
    );
  }

  /** Send the owner a fresh invitation, for example when the first expired or went astray. */
  async inviteOwner(by: PartnerOperator, orgId: string, email: string): Promise<void> {
    await this.rateLimiter.consume(`rl:invite:org:${orgId}`, 50, 3600);
    const token = this.tokens.newOpaqueToken();
    const { orgName, partnerName } = await this.db.runInWorkspace(orgId, async (tx) => {
      const member = await tx.membership.findFirst({ where: { user: { email } } });
      if (member) throw new AppError(ErrorCode.ALREADY_MEMBER, 'This person is already a member');
      await this.createOwnerInvite(tx, orgId, email, token.hash, by.userId);
      await tx.partnerClient.update({ where: { orgId }, data: { ownerEmail: email } });
      await this.audit.record(tx, orgId, {
        action: AuditAction.INVITE_CREATED,
        actorUserId: by.userId,
        metadata: { email, role: 'owner', by: 'partner' },
        meta: by.meta,
      });
      const org = await tx.organization.findUniqueOrThrow({
        where: { id: orgId },
        select: { name: true, partner: { select: { name: true } } },
      });
      return { orgName: org.name, partnerName: org.partner?.name ?? this.env.APP_NAME };
    });
    this.sendInvite(email, token.raw, orgName, partnerName);
  }

  async client(by: PartnerOperator, orgId: string): Promise<ClientDto> {
    const found = (await this.listClients(by)).find((c) => c.id === orgId);
    if (!found) throw new AppError(ErrorCode.NOT_FOUND, 'Workspace not found');
    return found;
  }

  async updateClient(
    by: PartnerOperator,
    orgId: string,
    input: UpdateClientInput,
  ): Promise<ClientDto> {
    if (input.planCode) {
      const plan = await this.db.runAsOperator(async (tx) => {
        const { currency } = await tx.partner.findUniqueOrThrow({
          where: { id: by.partnerId },
          select: { currency: true },
        });
        return this.planFor(tx, input.planCode!, currency);
      });
      await this.workspaces.setPlan(orgId, plan.id, plan.code, by);
    }

    const cap: Prisma.PartnerClientUncheckedUpdateInput = {};
    if (input.limits?.seats !== undefined) cap.limitSeats = input.limits.seats;
    if (input.limits?.numbers !== undefined) cap.limitNumbers = input.limits.numbers;
    if (input.limits?.contacts !== undefined) cap.limitContacts = input.limits.contacts;
    const price = priceMicros(input.clientPrice);
    if (price !== undefined) cap.clientPriceMicros = price;

    if (input.name !== undefined || Object.keys(cap).length > 0) {
      await this.db.runInWorkspace(orgId, async (tx) => {
        if (input.name !== undefined) {
          await tx.organization.update({ where: { id: orgId }, data: { name: input.name } });
        }
        if (Object.keys(cap).length > 0) {
          await tx.partnerClient.upsert({
            where: { orgId },
            create: {
              orgId,
              partnerId: by.partnerId,
              limitSeats: input.limits?.seats ?? null,
              limitNumbers: input.limits?.numbers ?? null,
              limitContacts: input.limits?.contacts ?? null,
              clientPriceMicros: price ?? null,
            },
            update: cap,
          });
        }
        await this.audit.record(tx, orgId, {
          action: AuditAction.CLIENT_CHANGED,
          actorUserId: by.userId,
          targetType: 'organization',
          targetId: orgId,
          metadata: { name: input.name, limits: input.limits },
          meta: by.meta,
        });
      });
    }
    return this.client(by, orgId);
  }

  async creditClient(
    by: PartnerOperator,
    orgId: string,
    input: Parameters<WorkspacesService['credit']>[1],
  ) {
    const { currency } = await this.db.runAsOperator((tx) =>
      tx.partner.findUniqueOrThrow({ where: { id: by.partnerId }, select: { currency: true } }),
    );
    return this.workspaces.credit(orgId, input, by, currency);
  }

  // ------------------------------------------------------------------ what the partner owes and earns

  /** The current month so far. It moves until the month closes into a statement. */
  async summary(by: PartnerOperator): Promise<PartnerTotalsDto> {
    return this.db.runAsOperator(async (tx) => {
      const { currency } = await tx.partner.findUniqueOrThrow({
        where: { id: by.partnerId },
        select: { currency: true },
      });
      return partnerTotals(tx, {
        partnerId: by.partnerId,
        period: periodOf(new Date()),
        currency,
      });
    });
  }

  async ledger(
    by: PartnerOperator,
    q: PartnerLedgerQuery,
  ): Promise<CursorPage<PartnerLedgerEntryDto>> {
    const cursor = q.cursor ? decodeCursor(q.cursor) : null;
    return this.db.runAsOperator(async (tx) => {
      const rows = await tx.partnerLedger.findMany({
        where: {
          partnerId: by.partnerId,
          ...(q.period ? { period: q.period } : {}),
          ...(q.orgId ? { orgId: q.orgId } : {}),
          ...(cursor
            ? {
                OR: [
                  { createdAt: { lt: cursor.createdAt } },
                  { createdAt: cursor.createdAt, id: { lt: cursor.id } },
                ],
              }
            : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: q.limit + 1,
      });
      const page = rows.slice(0, q.limit);
      const orgIds = [...new Set(page.map((r) => r.orgId).filter((id): id is string => !!id))];
      const orgs = await tx.organization.findMany({
        where: { id: { in: orgIds } },
        select: { id: true, name: true },
      });
      const names = new Map(orgs.map((o) => [o.id, o.name]));
      const last = page.at(-1);
      return {
        items: page.map((r) => ({
          id: r.id,
          orgId: r.orgId,
          orgName: r.orgId ? (names.get(r.orgId) ?? null) : null,
          type: r.type as PartnerLedgerType,
          wholesaleMicros: Number(r.wholesaleMicros),
          retailMicros: Number(r.retailMicros),
          commissionMicros: Number(r.commissionMicros),
          period: r.period,
          description: r.description,
          createdAt: r.createdAt.toISOString(),
        })),
        nextCursor: rows.length > q.limit && last ? encodeCursor(last) : null,
      };
    });
  }

  async statements(by: PartnerOperator): Promise<PartnerStatementDto[]> {
    const rows = await this.db.runAsOperator((tx) =>
      tx.partnerStatement.findMany({
        where: { partnerId: by.partnerId },
        orderBy: { period: 'desc' },
        take: 120,
      }),
    );
    return rows.map((r) => statementToDto(r));
  }
}

export function toPartnerDto(p: Prisma.PartnerGetPayload<object>, clientCount: number): PartnerDto {
  return {
    id: p.id,
    name: p.name,
    slug: p.slug,
    status: p.status,
    currency: p.currency,
    walletMarkupBps: p.walletMarkupBps,
    maxClients: p.maxClients,
    clientCount,
    createdAt: p.createdAt.toISOString(),
  };
}
