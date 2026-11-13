import { AsyncLocalStorage } from 'node:async_hooks';
import type { Role } from '@wacrm/shared';

/**
 * Identity of the caller for the current request. Set on `request.auth` by AccessGuard, then
 * exposed to services through AsyncLocalStorage by TenantContextInterceptor.
 */
export interface AuthContext {
  userId: string;
  /** Session (refresh-token family) the access token belongs to. */
  sessionId?: string;
  /** Present only when the user is an active member of the selected org. */
  orgId?: string;
  /** Role in `orgId`, loaded fresh from the membership row on every request. */
  role?: Role;
  /** Set by AccessGuard on @PartnerRoute routes: the partner this person works for. */
  partnerId?: string;
  /** Set by AccessGuard on @PlatformAdminRoute routes, after checking platform_admins. */
  platformAdmin?: boolean;
  /** Set when an API key made this request rather than a person's session. */
  apiKeyId?: string;
  /**
   * The caller is not a member of `orgId`: a partner's staff or a platform admin is acting inside
   * it. Names the impersonation_sessions row, which is checked on every request.
   */
  impersonationId?: string;
  /** The org exists but was suspended. Only @SkipTenant routes (the switcher) still work. */
  orgSuspended?: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

const storage = new AsyncLocalStorage<AuthContext>();

export const requestContext = {
  run<T>(ctx: AuthContext, fn: () => T): T {
    return storage.run(ctx, fn);
  },
  get(): AuthContext | undefined {
    return storage.getStore();
  },
};
