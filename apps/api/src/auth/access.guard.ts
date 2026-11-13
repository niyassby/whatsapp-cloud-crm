import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  type ApiScope,
  AppError,
  ErrorCode,
  hasPermission,
  IMPERSONATION_DENIED,
  type Permission,
} from '@wacrm/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { SKIP_TENANT_KEY } from '../tenancy/skip-tenant.decorator';
import { ApiKeyAuthService } from './api-key-auth.service';
import {
  API_KEY_SCOPE_KEY,
  PARTNER_KEY,
  PERMISSIONS_KEY,
  PLATFORM_ADMIN_KEY,
  PUBLIC_KEY,
  type PublicOptions,
} from './decorators';
import { AuthenticatorService } from './authenticator.service';

/**
 * The single global guard, so ordering is explicit:
 *   1. authenticate the bearer access token (unless @Public)
 *   2. confirm the session is live and the user active; load the role FRESH from the
 *      membership row (a removed or demoted member loses access immediately, not at expiry)
 *   3. tenancy layer 1: require an org unless @SkipTenant (layer 2 is Postgres RLS)
 *   4. permissions from the shared role map (@RequirePermission)
 *
 * @PartnerRoute and @PlatformAdminRoute replace steps 3 and 4: the caller's partner membership or
 * platform_admins row is loaded fresh, and the request carries no org.
 */
@Injectable()
export class AccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authenticator: AuthenticatorService,
    private readonly apiKeys: ApiKeyAuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const targets = [context.getHandler(), context.getClass()];
    const req = context.switchToHttp().getRequest<FastifyRequest>();

    const scope = this.reflector.getAllAndOverride<ApiScope | undefined>(
      API_KEY_SCOPE_KEY,
      targets,
    );
    if (scope) {
      const reply = context.switchToHttp().getResponse<FastifyReply>();
      try {
        const { auth, rate } = await this.apiKeys.authenticate(extractBearer(req), scope);
        req.auth = auth;
        void reply.header('x-ratelimit-limit', rate.limit);
        void reply.header('x-ratelimit-remaining', rate.remaining);
        return true;
      } catch (err) {
        if (err instanceof AppError && err.code === ErrorCode.RATE_LIMITED) {
          void reply.header('retry-after', 60);
        }
        throw err;
      }
    }

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
    const auth = await this.authenticator.authenticate(bearer);
    req.auth = auth;

    const partnerRoute = this.reflector.getAllAndOverride<boolean>(PARTNER_KEY, targets);
    const adminRoute = this.reflector.getAllAndOverride<boolean>(PLATFORM_ADMIN_KEY, targets);
    if (partnerRoute || adminRoute) {
      // An impersonation token is for the client's workspace only. It never opens the consoles.
      if (auth.impersonationId) {
        throw new AppError(ErrorCode.FORBIDDEN, 'Leave the workspace you are viewing first');
      }
      // These consoles act across workspaces, so the org on the token is dropped: nothing here
      // can reach tenant data without naming a workspace and having it checked.
      const scoped = { userId: auth.userId, sessionId: auth.sessionId };
      if (adminRoute) {
        if (!(await this.authenticator.isPlatformAdmin(auth.userId))) {
          throw new AppError(ErrorCode.FORBIDDEN, 'Platform admins only');
        }
        req.auth = { ...scoped, platformAdmin: true };
        return true;
      }
      const partner = await this.authenticator.partnerOf(auth.userId);
      if (!partner) throw new AppError(ErrorCode.FORBIDDEN, 'Partner accounts only');
      if (partner.status !== 'active') {
        throw new AppError(ErrorCode.PARTNER_SUSPENDED, 'This partner account is suspended');
      }
      req.auth = { ...scoped, partnerId: partner.id };
      return true;
    }

    const skipTenant = this.reflector.getAllAndOverride<boolean>(SKIP_TENANT_KEY, targets);
    if (!skipTenant && !auth.orgId) {
      throw new AppError(ErrorCode.TENANT_CONTEXT_MISSING, 'An organization context is required');
    }
    if (!skipTenant && auth.orgSuspended) {
      throw new AppError(ErrorCode.ORG_SUSPENDED, 'This workspace is suspended');
    }

    const required =
      this.reflector.getAllAndOverride<Permission[] | undefined>(PERMISSIONS_KEY, targets) ?? [];
    const missing = required.filter((p) => !hasPermission(auth.role, p));
    if (missing.length > 0) {
      throw new AppError(ErrorCode.FORBIDDEN, 'You do not have permission to do this', { missing });
    }
    if (auth.impersonationId) {
      const denied = required.filter((p) => IMPERSONATION_DENIED.includes(p));
      if (denied.length > 0) {
        throw new AppError(ErrorCode.FORBIDDEN, 'Not available while viewing a client workspace', {
          missing: denied,
        });
      }
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
