import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppError, ErrorCode } from '@wacrm/shared';
import type { FastifyRequest } from 'fastify';
import { SKIP_TENANT_KEY } from './skip-tenant.decorator';

/**
 * Layer 1 of tenancy (layer 2 is Postgres RLS). Registered globally: every route needs an
 * organization in `request.auth` unless marked with @SkipTenant().
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_TENANT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skip) return true;

    const req = context.switchToHttp().getRequest<FastifyRequest>();
    if (!req.auth?.orgId) {
      throw new AppError(ErrorCode.TENANT_CONTEXT_MISSING, 'An organization context is required');
    }
    return true;
  }
}
