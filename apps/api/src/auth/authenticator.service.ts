import { Injectable } from '@nestjs/common';
import { withDbContext } from '@wacrm/db';
import { AppError, ErrorCode } from '@wacrm/shared';
import { PrismaService } from '../db/prisma.service';
import type { AuthContext } from '../tenancy/request-context';
import { TokenService } from './token.service';

/**
 * Turns an access token into an identity. Shared by HTTP (AccessGuard) and WebSockets, so both
 * enforce the same rules: live session, active user, role loaded fresh from the membership row.
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
        const membership = claims.org
          ? await tx.membership.findUnique({
              where: { orgId_userId: { orgId: claims.org, userId: claims.sub } },
              select: { role: true, status: true },
            })
          : null;
        return { user, liveSession, membership };
      },
    );

    if (!state.user) throw new AppError(ErrorCode.UNAUTHENTICATED, 'Invalid session');
    if (state.user.status !== 'active') {
      throw new AppError(ErrorCode.ACCOUNT_DISABLED, 'Account disabled');
    }
    if (!state.liveSession) {
      throw new AppError(ErrorCode.UNAUTHENTICATED, 'Session ended. Log in again.');
    }

    const active = state.membership?.status === 'active';
    return {
      userId: claims.sub,
      sessionId: claims.sid,
      orgId: active ? claims.org : undefined,
      role: active ? state.membership?.role : undefined,
      tokenExpiresAt: claims.exp,
    };
  }
}
