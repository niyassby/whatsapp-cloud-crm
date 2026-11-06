import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import { AppError, ErrorCode, type Permission, type PlanFeature } from '@wacrm/shared';
import type { FastifyRequest } from 'fastify';
import type { AuthContext } from '../tenancy/request-context';

export const PUBLIC_KEY = 'auth:public';
export const PERMISSIONS_KEY = 'auth:permissions';
export const FEATURE_KEY = 'auth:feature';

export interface PublicOptions {
  /** Parse a bearer token if one is sent (e.g. accept-invite works logged in or out). */
  optionalAuth?: boolean;
}

/** No authentication required. Implies no tenant requirement. */
export const Public = (options: PublicOptions = {}) => SetMetadata(PUBLIC_KEY, options);

/** Require every listed permission for the caller's role in the current org. */
export const RequirePermission = (...permissions: Permission[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);

/** Require this feature on the workspace's current plan. Goes on the actions, not on reading. */
export const RequireFeature = (feature: PlanFeature) => SetMetadata(FEATURE_KEY, feature);

/** The authenticated caller. Throws if the route is public and nobody is logged in. */
export const CurrentAuth = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthContext => {
    const auth = ctx.switchToHttp().getRequest<FastifyRequest>().auth;
    if (!auth) throw new AppError(ErrorCode.UNAUTHENTICATED, 'Authentication required');
    return auth;
  },
);

/** The caller if logged in, otherwise undefined (for @Public({ optionalAuth: true })). */
export const OptionalAuth = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthContext | undefined =>
    ctx.switchToHttp().getRequest<FastifyRequest>().auth,
);
