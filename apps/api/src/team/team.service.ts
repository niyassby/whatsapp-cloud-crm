import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { type TenantTx, withDbContext, withTenant } from '@wacrm/db';
import {
  type AcceptInvitationInput,
  AppError,
  canManageRole,
  type CreateInvitationInput,
  ErrorCode,
  type InvitationDto,
  type InvitationPreviewDto,
  type MemberDto,
  type Role,
} from '@wacrm/shared';
import { AuditAction, AuditService } from '../audit/audit.service';
import { AuthService, type SessionTokens } from '../auth/auth.service';
import { inviteMail } from '../auth/mail-templates';
import { PasswordService } from '../auth/password.service';
import { TokenService } from '../auth/token.service';
import type { RequestMeta } from '../common/request-meta';
import { PrismaService } from '../db/prisma.service';
import { API_ENV, type ApiEnv } from '../env';
import { RateLimiter } from '../infra/rate-limiter.service';
import type { AuthContext } from '../tenancy/request-context';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service';

const INVITE_TTL_MS = 7 * 24 * 3600_000;

interface InvitationLookupRow {
  id: string;
  org_id: string;
  org_name: string;
  email: string;
  role: Role;
  expires_at: Date;
  accepted_at: Date | null;
  revoked_at: Date | null;
  account_exists: boolean;
}

type Actor = Required<Pick<AuthContext, 'userId' | 'orgId' | 'role'>>;

export function actorOf(auth: AuthContext): Actor {
  if (!auth.orgId || !auth.role) {
    throw new AppError(ErrorCode.TENANT_CONTEXT_MISSING, 'An organization context is required');
  }
  return { userId: auth.userId, orgId: auth.orgId, role: auth.role };
}

@Injectable()
export class TeamService {
  constructor(
    @Inject(API_ENV) private readonly env: ApiEnv,
    private readonly db: TenantPrismaService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly tokens: TokenService,
    private readonly passwords: PasswordService,
    private readonly auth: AuthService,
    private readonly rateLimiter: RateLimiter,
  ) {}

  // ------------------------------------------------------------------ members

  async listMembers(): Promise<MemberDto[]> {
    const rows = await this.db.run((tx) =>
      tx.membership.findMany({
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          userId: true,
          role: true,
          status: true,
          createdAt: true,
          user: { select: { name: true, email: true } },
        },
      }),
    );
    return rows.map((m) => ({
      id: m.id,
      userId: m.userId,
      name: m.user.name,
      email: m.user.email,
      role: m.role,
      status: m.status,
      createdAt: m.createdAt.toISOString(),
    }));
  }

  async changeRole(
    actor: Actor,
    membershipId: string,
    role: Role,
    meta: RequestMeta,
  ): Promise<MemberDto> {
    await this.db.run(async (tx) => {
      const target = await this.lockMember(tx, membershipId);
      if (target.user_id === actor.userId) {
        throw new AppError(ErrorCode.ROLE_NOT_ALLOWED, 'You cannot change your own role');
      }
      if (!canManageRole(actor.role, target.role) || !canManageRole(actor.role, role)) {
        throw new AppError(ErrorCode.ROLE_NOT_ALLOWED, 'Your role cannot make this change');
      }
      if (target.role === 'owner' && role !== 'owner')
        await this.assertAnotherOwner(tx, membershipId);
      await tx.membership.update({ where: { id: membershipId }, data: { role } });
      await this.audit.record(tx, actor.orgId, {
        action: AuditAction.ROLE_CHANGED,
        actorUserId: actor.userId,
        targetType: 'membership',
        targetId: membershipId,
        metadata: { userId: target.user_id, from: target.role, to: role },
        meta,
      });
    });
    const member = (await this.listMembers()).find((m) => m.id === membershipId);
    if (!member) throw new AppError(ErrorCode.NOT_FOUND, 'Member not found');
    return member;
  }

  async removeMember(actor: Actor, membershipId: string, meta: RequestMeta): Promise<void> {
    await this.db.run(async (tx) => {
      const target = await this.lockMember(tx, membershipId);
      if (target.user_id === actor.userId) {
        throw new AppError(ErrorCode.ROLE_NOT_ALLOWED, 'You cannot remove yourself');
      }
      if (!canManageRole(actor.role, target.role)) {
        throw new AppError(ErrorCode.ROLE_NOT_ALLOWED, 'Your role cannot remove this member');
      }
      if (target.role === 'owner') await this.assertAnotherOwner(tx, membershipId);
      await tx.membership.delete({ where: { id: membershipId } });
      await this.audit.record(tx, actor.orgId, {
        action: AuditAction.MEMBER_REMOVED,
        actorUserId: actor.userId,
        targetType: 'membership',
        targetId: membershipId,
        metadata: { userId: target.user_id, role: target.role },
        meta,
      });
    });
  }

  /**
   * Serialise membership changes per org (transaction-scoped advisory lock), then read the
   * target. Without this, two owners demoting each other at once could leave zero owners, or
   * deadlock by locking the same two rows in opposite order.
   */
  private async lockMember(tx: TenantTx, membershipId: string) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('memberships:' || app_current_org_id()::text, 0))`;
    const [row] = await tx.$queryRaw<{ id: string; user_id: string; role: Role }[]>`
      SELECT id, user_id, role FROM memberships WHERE id = ${membershipId}::uuid FOR UPDATE`;
    if (!row) throw new AppError(ErrorCode.NOT_FOUND, 'Member not found');
    return row;
  }

  private async assertAnotherOwner(tx: TenantTx, excludingMembershipId: string): Promise<void> {
    const owners = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM memberships
      WHERE role = 'owner' AND status = 'active' AND id <> ${excludingMembershipId}::uuid`;
    if (owners.length === 0) {
      throw new AppError(ErrorCode.LAST_OWNER, 'An organization needs at least one owner');
    }
  }

  // ------------------------------------------------------------------ invitations

  async listInvitations(): Promise<InvitationDto[]> {
    const rows = await this.db.run((tx) =>
      tx.invitation.findMany({
        where: { acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
        orderBy: { createdAt: 'desc' },
      }),
    );
    return rows.map(toInvitationDto);
  }

  async invite(
    actor: Actor,
    input: CreateInvitationInput,
    meta: RequestMeta,
  ): Promise<InvitationDto> {
    if (!canManageRole(actor.role, input.role)) {
      throw new AppError(ErrorCode.ROLE_NOT_ALLOWED, `Your role cannot invite a ${input.role}`);
    }
    await this.rateLimiter.consume(`rl:invite:org:${actor.orgId}`, 50, 3600);
    const token = this.tokens.newOpaqueToken();

    const { invitation, orgName, inviterName } = await this.db.run(async (tx) => {
      const existing = await tx.membership.findFirst({ where: { user: { email: input.email } } });
      if (existing) throw new AppError(ErrorCode.ALREADY_MEMBER, 'This person is already a member');
      // Re-inviting replaces any pending invite for the same email.
      await tx.invitation.updateMany({
        where: { email: input.email, acceptedAt: null, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      const invitation = await tx.invitation.create({
        data: {
          orgId: actor.orgId,
          email: input.email,
          role: input.role,
          tokenHash: token.hash,
          invitedById: actor.userId,
          expiresAt: new Date(Date.now() + INVITE_TTL_MS),
        },
      });
      await this.audit.record(tx, actor.orgId, {
        action: AuditAction.INVITE_CREATED,
        actorUserId: actor.userId,
        targetType: 'invitation',
        targetId: invitation.id,
        metadata: { email: input.email, role: input.role },
        meta,
      });
      const org = await tx.organization.findUniqueOrThrow({
        where: { id: actor.orgId },
        select: { name: true },
      });
      const inviter = await tx.user.findUniqueOrThrow({
        where: { id: actor.userId },
        select: { name: true },
      });
      return { invitation, orgName: org.name, inviterName: inviter.name };
    });

    this.auth.sendMail(
      inviteMail(
        this.env.APP_NAME,
        input.email,
        this.auth.link('/invite', token.raw),
        orgName,
        inviterName,
      ),
    );
    return toInvitationDto(invitation);
  }

  async revokeInvitation(actor: Actor, invitationId: string, meta: RequestMeta): Promise<void> {
    await this.db.run(async (tx) => {
      const inv = await tx.invitation.findUnique({ where: { id: invitationId } });
      if (!inv || inv.acceptedAt || inv.revokedAt)
        throw new AppError(ErrorCode.NOT_FOUND, 'Invitation not found');
      if (!canManageRole(actor.role, inv.role)) {
        throw new AppError(ErrorCode.ROLE_NOT_ALLOWED, 'Your role cannot revoke this invitation');
      }
      await tx.invitation.update({ where: { id: invitationId }, data: { revokedAt: new Date() } });
      await this.audit.record(tx, actor.orgId, {
        action: AuditAction.INVITE_REVOKED,
        actorUserId: actor.userId,
        targetType: 'invitation',
        targetId: invitationId,
        meta,
      });
    });
  }

  async previewInvitation(rawToken: string): Promise<InvitationPreviewDto> {
    const inv = await this.lookupValidInvitation(rawToken);
    return {
      orgName: inv.org_name,
      email: inv.email,
      role: inv.role,
      accountExists: inv.account_exists,
    };
  }

  /**
   * Accept an invitation.
   * - Logged in: the account email must match the invitation; joins and switches the session.
   * - Logged out, new email: creates the account (email counts as verified) and logs in.
   * - Logged out, existing account: must log in first.
   */
  async accept(
    input: AcceptInvitationInput,
    auth: AuthContext | undefined,
    meta: RequestMeta,
  ): Promise<SessionTokens | { accessToken: string; expiresIn: number }> {
    await this.rateLimiter.consume(`rl:invite-accept:ip:${meta.ip}`, 20, 3600);
    const inv = await this.lookupValidInvitation(input.token);

    if (auth) {
      const me = await withDbContext(this.prisma.client, { userId: auth.userId }, (tx) =>
        tx.user.findUniqueOrThrow({ where: { id: auth.userId }, select: { email: true } }),
      );
      if (me.email !== inv.email) {
        throw new AppError(
          ErrorCode.INVITATION_EMAIL_MISMATCH,
          `This invitation is for ${inv.email}`,
        );
      }
      await withTenant(this.prisma.client, { orgId: inv.org_id, userId: auth.userId }, (tx) =>
        this.joinOrg(tx, inv, auth.userId, meta),
      );
      if (!auth.sessionId) throw new AppError(ErrorCode.UNAUTHENTICATED, 'No session');
      return this.auth.switchOrg(auth.userId, auth.sessionId, inv.org_id);
    }

    if (inv.account_exists) {
      throw new AppError(
        ErrorCode.UNAUTHENTICATED,
        'Log in with this email to accept the invitation',
      );
    }
    if (!input.name || !input.password) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'Name and password are required', {
        issues: [
          ...(input.name ? [] : [{ path: 'name', message: 'Required' }]),
          ...(input.password ? [] : [{ path: 'password', message: 'Required' }]),
        ],
      });
    }
    const userId = randomUUID();
    const passwordHash = await this.passwords.hash(input.password);
    await withTenant(this.prisma.client, { orgId: inv.org_id, userId }, async (tx) => {
      await tx.user.create({
        data: {
          id: userId,
          email: inv.email,
          name: input.name!,
          passwordHash,
          emailVerifiedAt: new Date(),
        },
      });
      await this.joinOrg(tx, inv, userId, meta);
    });
    return this.auth.startSession(userId, meta, AuditAction.LOGIN, inv.org_id);
  }

  private async joinOrg(tx: TenantTx, inv: InvitationLookupRow, userId: string, meta: RequestMeta) {
    // Conditional update: an invitation can be accepted exactly once.
    const claimed = await tx.invitation.updateMany({
      where: { id: inv.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
      data: { acceptedAt: new Date(), acceptedById: userId },
    });
    if (claimed.count !== 1)
      throw new AppError(ErrorCode.INVITATION_INVALID, 'This invitation is no longer valid');
    const existing = await tx.membership.findUnique({
      where: { orgId_userId: { orgId: inv.org_id, userId } },
    });
    if (existing) throw new AppError(ErrorCode.ALREADY_MEMBER, 'You are already a member');
    await tx.membership.create({ data: { orgId: inv.org_id, userId, role: inv.role } });
    await this.audit.record(tx, inv.org_id, {
      action: AuditAction.INVITE_ACCEPTED,
      actorUserId: userId,
      targetType: 'invitation',
      targetId: inv.id,
      metadata: { role: inv.role },
      meta,
    });
  }

  private async lookupValidInvitation(rawToken: string): Promise<InvitationLookupRow> {
    const rows = await this.prisma.client.$queryRaw<InvitationLookupRow[]>`
      SELECT * FROM auth_lookup_invitation(${this.tokens.hashToken(rawToken)})`;
    const inv = rows[0];
    if (!inv || inv.accepted_at || inv.revoked_at || inv.expires_at.getTime() <= Date.now()) {
      throw new AppError(ErrorCode.INVITATION_INVALID, 'This invitation is invalid or has expired');
    }
    return inv;
  }
}

function toInvitationDto(i: {
  id: string;
  email: string;
  role: Role;
  expiresAt: Date;
  createdAt: Date;
}): InvitationDto {
  return {
    id: i.id,
    email: i.email,
    role: i.role,
    expiresAt: i.expiresAt.toISOString(),
    createdAt: i.createdAt.toISOString(),
  };
}
