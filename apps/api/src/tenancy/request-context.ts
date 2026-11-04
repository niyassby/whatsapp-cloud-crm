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
  partnerId?: string;
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
