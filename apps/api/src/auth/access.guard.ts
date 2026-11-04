import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { withDbContext } from '@wacrm/db';
import { AppError, ErrorCode, hasPermission, type Permission } from '@wacrm/shared';
import type { FastifyRequest } from 'fastify';
import { PrismaService } from '../db/prisma.service';
import type { AuthContext } from '../tenancy/request-context';
import { SKIP_TENANT_KEY } from '../tenancy/skip-tenant.decorator';
import { PERMISSIONS_KEY, PUBLIC_KEY, type PublicOptions } from './decorators';
import { TokenService } from './token.service';

/**
 * The single global guard, so ordering is explicit:
 *   1. authenticate the bearer access token (unless @Public)
 *   2. confirm the session is live and the user active; load the role FRESH from the
 *      membership row (a removed or demoted member loses access immediately, not at expiry)
 *   3. tenancy layer 1: require an org unless @SkipTenant (layer 2 is Postgres RLS)
 *   4. permissions from the shared role map (@RequirePermission)
 */
@Injectable()
export class AccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const targets = [context.getHandler(), context.getClass()];
    const req = context.switchToHttp().getRequest<FastifyRequest>();

    const publicOptions = this.reflector.getAllAndOverride<PublicOptions | undefined>(
      PUBLIC_KEY,
      targets,
    );
    const bearer = extractBearer(req);
    if (publicOptions) {
      if (publicOptions.optionalAuth && bearer) req.auth = await this.authenticate(bearer);
      return true;
    }
    if (!bearer) throw new AppError(ErrorCode.UNAUTHENTICATED, 'Authentication required');
    req.auth = await this.authenticate(bearer);

    const skipTenant = this.reflector.getAllAndOverride<boolean>(SKIP_TENANT_KEY, targets);
    if (!skipTenant && !req.auth.orgId) {
      throw new AppError(ErrorCode.TENANT_CONTEXT_MISSING, 'An organization context is required');
    }

    const required =
      this.reflector.getAllAndOverride<Permission[] | undefined>(PERMISSIONS_KEY, targets) ?? [];
    const missing = required.filter((p) => !hasPermission(req.auth?.role, p));
    if (missing.length > 0) {
      throw new AppError(ErrorCode.FORBIDDEN, 'You do not have permission to do this', { missing });
    }
    return true;
  }

  private async authenticate(bearer: string): Promise<AuthContext> {
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
    if (state.user.status !== 'active')
      throw new AppError(ErrorCode.ACCOUNT_DISABLED, 'Account disabled');
    if (!state.liveSession)
      throw new AppError(ErrorCode.UNAUTHENTICATED, 'Session ended. Log in again.');

    const active = state.membership?.status === 'active';
    return {
      userId: claims.sub,
      sessionId: claims.sid,
      orgId: active ? claims.org : undefined,
      role: active ? state.membership?.role : undefined,
    };
  }
}

function extractBearer(req: FastifyRequest): string | undefined {
  const header = req.headers.authorization;
  if (!header) return undefined;
  const [scheme, token] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' && token ? token : undefined;
}
