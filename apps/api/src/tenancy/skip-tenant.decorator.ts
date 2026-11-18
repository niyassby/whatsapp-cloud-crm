import { SetMetadata } from '@nestjs/common';

export const SKIP_TENANT_KEY = 'tenancy:skip';

/**
 * Opt a controller or route out of the global TenantGuard (health checks, signup, login,
 * webhooks). Anything without this decorator requires an organization in context.
 */
export const SkipTenant = () => SetMetadata(SKIP_TENANT_KEY, true);

export const ALLOW_IMPERSONATION_KEY = 'tenancy:allow-impersonation';

/**
 * A workspace-less route an impersonation token may still call. Every other one is refused for
 * it, so an impersonation can never switch workspace, change the impersonator's own account or
 * turn into an ordinary session (Phase 4.4).
 */
export const AllowWhileImpersonating = () => SetMetadata(ALLOW_IMPERSONATION_KEY, true);
