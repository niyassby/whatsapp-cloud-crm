import { Injectable } from '@nestjs/common';
import { type TenantTx, withDbContext } from '@wacrm/db';
import { AppError, ErrorCode } from '@wacrm/shared';
import { PrismaService } from '../db/prisma.service';
import type { AuthContext } from '../tenancy/request-context';
import { type AccessClaims, TokenService } from './token.service';

/**
 * Turns an access token into an identity. Shared by HTTP (AccessGuard) and WebSockets, so both
 * enforce the same rules: live session, active user, role loaded fresh from the membership row.
 *
 * An impersonation token (claim `imp`) names someone who is not a member of the org. Their right
 * to be there is also loaded fresh on every request: the impersonation row must still be open,
 * and they must still work for the org's partner, or still be a platform admin. Ending the
 * session, removing them from the partner, or moving the org all take effect at once.
 */
@Injectable()
export class AuthenticatorService {
  constructor(
    private readonly tokens: TokenService,
    private readonly prisma: PrismaService,
  ) {}

  async authenticate(bearer: string): Promise<AuthContext & { tokenExpiresAt?: number }> {
    const claims = this.tokens.verifyAccess(bearer);

    const state = await withDbContext(
      this.prisma.client,
      { userId: claims.sub, orgId: claims.org },
      // Sequential on purpose: a transaction is one connection, so Promise.all would only
      // queue the queries (and pg warns about concurrent client.query calls).
      async (tx) => {
        const user = await tx.user.findUnique({
          where: { id: claims.sub },
          select: { status: true },
        });
        const liveSession = await tx.refreshToken.findFirst({
          where: {
            familyId: claims.sid,
            userId: claims.sub,
            revokedAt: null,
            expiresAt: { gt: new Date() },
          },
          select: { id: true },
        });
        const org = claims.org
          ? await tx.organization.findUnique({
              where: { id: claims.org },
              select: { status: true, deletedAt: true, partnerId: true },
            })
          : null;
        const membership =
          claims.org && !claims.imp
            ? await tx.membership.findUnique({
                where: { orgId_userId: { orgId: claims.org, userId: claims.sub } },
                select: { role: true, status: true },
              })
            : null;
        const impersonating = claims.imp && org ? await this.impersonation(tx, claims, org) : false;
        return { user, liveSession, org, membership, impersonating };
      },
    );

    if (!state.user) throw new AppError(ErrorCode.UNAUTHENTICATED, 'Invalid session');
    if (state.user.status !== 'active') {
      throw new AppError(ErrorCode.ACCOUNT_DISABLED, 'Account disabled');
    }
    if (!state.liveSession) {
      throw new AppError(ErrorCode.UNAUTHENTICATED, 'Session ended. Log in again.');
    }

    const base = { userId: claims.sub, sessionId: claims.sid, tokenExpiresAt: claims.exp };
    const orgLive = state.org !== null && state.org.deletedAt === null;

    if (claims.imp) {
      // Never falls back to the person's own access: an impersonation token is that or nothing.
      if (!state.impersonating || !orgLive) {
        throw new AppError(ErrorCode.UNAUTHENTICATED, 'This impersonation session has ended');
      }
      return { ...base, orgId: claims.org, role: 'admin', impersonationId: claims.imp };
    }

    const active = state.membership?.status === 'active' && orgLive;
    return {
      ...base,
      orgId: active ? claims.org : undefined,
      role: active ? state.membership?.role : undefined,
      orgSuspended: active && state.org?.status === 'suspended' ? true : undefined,
    };
  }

  /** Whether this token's impersonation is still allowed. Runs in the request's own context. */
  private async impersonation(
    tx: TenantTx,
    claims: AccessClaims,
    org: { partnerId: string | null },
  ): Promise<boolean> {
    const session = await tx.impersonationSession.findUnique({ where: { id: claims.imp } });
    if (!session || session.userId !== claims.sub || session.orgId !== claims.org) return false;
    if (session.endedAt || session.expiresAt <= new Date()) return false;

    if (session.partnerId) {
      // The org must still be this partner's, and the person must still work for it.
      if (org.partnerId !== session.partnerId) return false;
      const member = await tx.partnerMember.findUnique({
        where: { userId: claims.sub },
        select: { partnerId: true, partner: { select: { status: true } } },
      });
      return member?.partnerId === session.partnerId && member.partner.status === 'active';
    }
    return (await tx.platformAdmin.findUnique({ where: { userId: claims.sub } })) !== null;
  }

  /** The partner this person works for, loaded fresh. Null when none or it is suspended. */
  async partnerOf(
    userId: string,
  ): Promise<{ id: string; name: string; status: 'active' | 'suspended' } | null> {
    return withDbContext(this.prisma.client, { userId }, async (tx) => {
      const member = await tx.partnerMember.findUnique({
        where: { userId },
        select: { partnerId: true },
      });
      if (!member) return null;
      // partners is only readable in the partner's own context.
      await tx.$queryRaw`SELECT set_config('app.partner_id', ${member.partnerId}, true)`;
      return tx.partner.findUnique({
        where: { id: member.partnerId },
        select: { id: true, name: true, status: true },
      });
    });
  }

  async isPlatformAdmin(userId: string): Promise<boolean> {
    const row = await withDbContext(this.prisma.client, { userId }, (tx) =>
      tx.platformAdmin.findUnique({ where: { userId } }),
    );
    return row !== null;
  }
}
