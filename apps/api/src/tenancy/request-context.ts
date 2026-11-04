import { AsyncLocalStorage } from 'node:async_hooks';
import type { Role } from '@wacrm/db';

/**
 * Identity of the caller for the current request. Set on `request.auth` by the auth guard
 * (Phase 1.3), then exposed to services through AsyncLocalStorage by TenantContextInterceptor.
 */
export interface AuthContext {
  userId: string;
  orgId?: string;
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
