import { Inject, Injectable } from '@nestjs/common';
import {
  creditWallet,
  disconnectWabaTx,
  ensureWallet,
  PARTNER_PROVIDER,
  partnerTotals,
  planUsage,
  type Prisma,
  setPartnerManagedPlan,
  type TenantTx,
} from '@wacrm/db';
import {
  AppError,
  type ClientDetailDto,
  type ClientDto,
  decimalToMicros,
  ErrorCode,
  IMPERSONATION_TTL_SECONDS,
  type ImpersonationStartDto,
  periodOf,
  type WalletCreditInput,
} from '@wacrm/shared';
import { AuditAction, AuditService } from '../audit/audit.service';
import { TokenService } from '../auth/token.service';
import type { RequestMeta } from '../common/request-meta';
import { API_ENV, type ApiEnv } from '../env';
import { RateLimiter } from '../infra/rate-limiter.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import type { AuthContext } from '../tenancy/request-context';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service';

export interface Operator {
  userId: string;
  sessionId?: string;
  partnerId?: string;
  meta: RequestMeta;
}

export const operatorOf = (auth: AuthContext, meta: RequestMeta): Operator => ({
  userId: auth.userId,
  sessionId: auth.sessionId,
  partnerId: auth.partnerId,
  meta,
});

export const clientInclude = {
  subscription: { include: { plan: true } },
  wallet: true,
  partnerClient: true,
} satisfies Prisma.OrganizationInclude;

type ClientRow = Prisma.OrganizationGetPayload<{ include: typeof clientInclude }>;

const lower = (a: number | null, b: number | null | undefined) =>
  b === null || b === undefined ? a : a === null ? b : Math.min(a, b);

/** `wholesale` maps a plan id to what the platform charges the partner for it a month. */
export function toClientDto(
  org: ClientRow,
  wholesale: Map<string, bigint>,
  fallbackCurrency: string,
): ClientDto {
  const plan = org.subscription?.plan ?? null;
  const cap = org.partnerClient;
  const price = plan ? wholesale.get(plan.id) : undefined;
  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    status: org.status,
    ownerEmail: cap?.ownerEmail ?? null,
    planCode: plan?.code ?? null,
    planName: plan?.name ?? null,
    limits: {
      seats: lower(plan?.seats ?? null, cap?.limitSeats),
      numbers: lower(plan?.numbers ?? null, cap?.limitNumbers),
      contacts: lower(plan?.contacts ?? null, cap?.limitContacts),
    },
    partnerLimits: {
      seats: cap?.limitSeats ?? null,
      numbers: cap?.limitNumbers ?? null,
      contacts: cap?.limitContacts ?? null,
    },
    clientPriceMicros:
      cap?.clientPriceMicros === null || cap?.clientPriceMicros === undefined
        ? null
        : Number(cap.clientPriceMicros),
    wholesalePriceMicros: price === undefined ? null : Number(price),
    currency: org.wallet?.currency ?? fallbackCurrency,
    balanceMicros: Number(org.wallet?.balanceMicros ?? 0n),
    createdAt: org.createdAt.toISOString(),
  };
}

/**
 * What a partner or a platform admin does to one workspace from outside it. Every method goes
 * through `runInWorkspace`, which refuses a workspace the caller has no right to, and writes the
 * workspace's own audit log in the same transaction, so its owners can see what was done.
 */
@Injectable()
export class WorkspacesService {
  constructor(
    @Inject(API_ENV) private readonly env: ApiEnv,
    private readonly db: TenantPrismaService,
    private readonly audit: AuditService,
    private readonly tokens: TokenService,
    private readonly realtime: RealtimeGateway,
    private readonly rateLimiter: RateLimiter,
  ) {}

  async wholesalePrices(tx: TenantTx, currency: string): Promise<Map<string, bigint>> {
    const rows = await tx.wholesalePlanPrice.findMany({ where: { currency } });
    return new Map(rows.map((r) => [r.planId, r.amountMicros]));
  }

  async detail(orgId: string): Promise<ClientDetailDto> {
    return this.db.runInWorkspace(orgId, async (tx) => {
      const org = await tx.organization.findUniqueOrThrow({
        where: { id: orgId },
        include: clientInclude,
      });
      const currency = org.wallet?.currency ?? this.env.WALLET_DEFAULT_CURRENCY;
      const dto = toClientDto(org, await this.wholesalePrices(tx, currency), currency);
      const period = periodOf(new Date());
      const month = org.partnerId
        ? await partnerTotals(tx, { partnerId: org.partnerId, period, currency, orgId })
        : {
            period,
            currency,
            usageWholesaleMicros: 0,
            usageRetailMicros: 0,
            planFeesWholesaleMicros: 0,
            planFeesRetailMicros: 0,
            commissionMicros: 0,
            totalDueMicros: 0,
          };
      return { ...dto, usage: await planUsage(tx, orgId), month };
    });
  }

  async setStatus(orgId: string, status: 'active' | 'suspended', by: Operator): Promise<void> {
    await this.db.runInWorkspace(orgId, async (tx) => {
      await tx.organization.update({ where: { id: orgId }, data: { status } });
      await this.audit.record(tx, orgId, {
        action: status === 'suspended' ? AuditAction.CLIENT_SUSPENDED : AuditAction.CLIENT_RESUMED,
        actorUserId: by.userId,
        targetType: 'organization',
        targetId: orgId,
        metadata: { by: by.partnerId ? 'partner' : 'platform' },
        meta: by.meta,
      });
    });
    if (status === 'suspended') this.realtime.disconnectOrg(orgId);
  }

  /**
   * Soft delete. Numbers are disconnected and their credentials wiped, so they can be connected
   * elsewhere; keys and pending invitations stop working. History stays, as for any workspace.
   */
  async remove(orgId: string, by: Operator): Promise<void> {
    await this.db.runInWorkspace(orgId, async (tx) => {
      const now = new Date();
      const wabas = await tx.wabaAccount.findMany({
        where: { status: 'active' },
        select: { id: true },
      });
      for (const waba of wabas) await disconnectWabaTx(tx, waba.id, 'Workspace deleted');
      await tx.apiKey.updateMany({ where: { revokedAt: null }, data: { revokedAt: now } });
      await tx.invitation.updateMany({
        where: { acceptedAt: null, revokedAt: null },
        data: { revokedAt: now },
      });
      await this.audit.record(tx, orgId, {
        action: AuditAction.CLIENT_DELETED,
        actorUserId: by.userId,
        targetType: 'organization',
        targetId: orgId,
        metadata: { numbersDisconnected: wabas.length },
        meta: by.meta,
      });
      // Last: once deleted_at is set the workspace is no longer found by runInWorkspace.
      await tx.organization.update({
        where: { id: orgId },
        data: { deletedAt: now, status: 'suspended' },
      });
    });
    this.realtime.disconnectOrg(orgId);
  }

  /**
   * Add funds to a workspace's wallet on the operator's word: a partner who collected from its
   * client, or a platform admin making an adjustment. The caller's key makes a repeat harmless.
   */
  async credit(orgId: string, input: WalletCreditInput, by: Operator, currency: string) {
    const amountMicros = decimalToMicros(input.amount);
    if (amountMicros === null) throw new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid amount');
    const move = await this.db.runInWorkspace(orgId, async (tx) => {
      await ensureWallet(tx, orgId, currency, null);
      const result = await creditWallet(tx, {
        orgId,
        amountMicros,
        type: by.partnerId ? 'credit' : 'adjustment',
        referenceType: by.partnerId ? 'partner' : 'manual',
        referenceId: by.partnerId ?? null,
        idempotencyKey: `operator:${input.idempotencyKey}`,
        description: input.note,
        actorUserId: by.userId,
      });
      if (result.applied) {
        await this.audit.record(tx, orgId, {
          action: AuditAction.WALLET_CREDITED,
          actorUserId: by.userId,
          targetType: 'wallet',
          metadata: { amount: input.amount, note: input.note },
          meta: by.meta,
        });
      }
      return result;
    });
    this.realtime.emit(orgId, 'wallet:updated', {});
    return { applied: move.applied, balanceMicros: move.balanceAfterMicros };
  }

  /**
   * Put a workspace on a plan with no payment. For a partner's client the partner is billed at
   * wholesale. A workspace paying a provider itself is left alone: changing it here would leave
   * it paying for a plan it is not on.
   */
  async setPlan(orgId: string, planId: string, planCode: string, by: Operator): Promise<void> {
    await this.db.runInWorkspace(orgId, async (tx) => {
      const sub = await tx.subscription.findUnique({ where: { orgId } });
      if (sub?.providerSubscriptionId && sub.provider !== PARTNER_PROVIDER) {
        throw new AppError(
          ErrorCode.CONFLICT,
          'This workspace pays for its own subscription. It must cancel that first.',
        );
      }
      await setPartnerManagedPlan(tx, orgId, planId);
      const org = await tx.organization.findUniqueOrThrow({
        where: { id: orgId },
        select: { partnerId: true },
      });
      // Only a partner's client is billed to a partner. Anything else is a grant by the platform.
      if (!org.partnerId) {
        await tx.subscription.update({ where: { orgId }, data: { provider: 'manual' } });
      }
      await this.audit.record(tx, orgId, {
        action: AuditAction.PLAN_SET,
        actorUserId: by.userId,
        metadata: { plan: planCode, by: by.partnerId ? 'partner' : 'platform' },
        meta: by.meta,
      });
    });
    this.realtime.emit(orgId, 'billing:updated', {});
  }

  /**
   * Open a workspace as an outsider. The token names an impersonation row that every request
   * checks, lasts 30 minutes, and is never refreshed. The workspace's audit log gets the start
   * (with the reason), the end, and a mark on everything done in between.
   */
  async impersonate(orgId: string, reason: string, by: Operator): Promise<ImpersonationStartDto> {
    if (!by.sessionId) throw new AppError(ErrorCode.UNAUTHENTICATED, 'No session');
    await this.rateLimiter.consume(`rl:impersonate:user:${by.userId}`, 30, 3600);
    const expiresAt = new Date(Date.now() + IMPERSONATION_TTL_SECONDS * 1000);
    const { session, orgName } = await this.db.runInWorkspace(orgId, async (tx) => {
      const session = await tx.impersonationSession.create({
        data: {
          orgId,
          userId: by.userId,
          partnerId: by.partnerId ?? null,
          reason,
          expiresAt,
          ip: by.meta.ip,
          userAgent: by.meta.userAgent,
        },
      });
      await this.audit.record(tx, orgId, {
        action: AuditAction.IMPERSONATION_STARTED,
        actorUserId: by.userId,
        targetType: 'impersonation',
        targetId: session.id,
        metadata: { reason, by: by.partnerId ? 'partner' : 'platform' },
        meta: by.meta,
        impersonationId: session.id,
      });
      const org = await tx.organization.findUniqueOrThrow({
        where: { id: orgId },
        select: { name: true },
      });
      return { session, orgName: org.name };
    });
    return {
      accessToken: this.tokens.signAccess(
        { sub: by.userId, org: orgId, sid: by.sessionId, imp: session.id },
        IMPERSONATION_TTL_SECONDS,
      ),
      expiresIn: IMPERSONATION_TTL_SECONDS,
      impersonation: { id: session.id, orgId, orgName, expiresAt: expiresAt.toISOString() },
    };
  }

  /** Called with the impersonation token itself, from inside the workspace. */
  async endImpersonation(auth: AuthContext, meta: RequestMeta): Promise<void> {
    if (!auth.impersonationId || !auth.orgId) return;
    const { impersonationId, orgId } = auth;
    await this.db.run(async (tx) => {
      const ended = await tx.impersonationSession.updateMany({
        where: { id: impersonationId, endedAt: null },
        data: { endedAt: new Date() },
      });
      if (ended.count !== 1) return;
      await this.audit.record(tx, orgId, {
        action: AuditAction.IMPERSONATION_ENDED,
        actorUserId: auth.userId,
        targetType: 'impersonation',
        targetId: impersonationId,
        meta,
      });
    });
  }
}
