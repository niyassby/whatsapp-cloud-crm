import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { hasFeature, withTenant } from '@wacrm/db';
import { AppError, ErrorCode, PLAN_FEATURE_LABELS, type PlanFeature } from '@wacrm/shared';
import type { FastifyRequest } from 'fastify';
import { PrismaService } from '../db/prisma.service';
import { FEATURE_KEY } from './decorators';

/** Runs after AccessGuard, so the org is known. Marked routes need the feature on the org's plan. */
@Injectable()
export class PlanFeatureGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const feature = this.reflector.getAllAndOverride<PlanFeature | undefined>(FEATURE_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!feature) return true;
    const auth = ctx.switchToHttp().getRequest<FastifyRequest>().auth;
    const orgId = auth?.orgId;
    if (!orgId) throw new AppError(ErrorCode.TENANT_CONTEXT_MISSING, 'An organization is required');
    const allowed = await withTenant(this.prisma.client, { orgId }, (tx) =>
      hasFeature(tx, orgId, feature),
    );
    if (!allowed) {
      throw new AppError(
        ErrorCode.PLAN_FEATURE_UNAVAILABLE,
        `${PLAN_FEATURE_LABELS[feature]} are not on your plan. Upgrade to use them.`,
        { feature },
      );
    }
    return true;
  }
}
