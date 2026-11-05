import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppError, ErrorCode, hasPermission, type Permission } from '@wacrm/shared';
import type { FastifyRequest } from 'fastify';
import { SKIP_TENANT_KEY } from '../tenancy/skip-tenant.decorator';
import { PERMISSIONS_KEY, PUBLIC_KEY, type PublicOptions } from './decorators';
import { AuthenticatorService } from './authenticator.service';

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
    private readonly authenticator: AuthenticatorService,
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
      if (publicOptions.optionalAuth && bearer)
        req.auth = await this.authenticator.authenticate(bearer);
      return true;
    }
    if (!bearer) throw new AppError(ErrorCode.UNAUTHENTICATED, 'Authentication required');
    req.auth = await this.authenticator.authenticate(bearer);

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
}

function extractBearer(req: FastifyRequest): string | undefined {
  const header = req.headers.authorization;
  if (!header) return undefined;
  const [scheme, token] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' && token ? token : undefined;
}
