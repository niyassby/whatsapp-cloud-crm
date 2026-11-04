import { SetMetadata } from '@nestjs/common';

export const SKIP_TENANT_KEY = 'tenancy:skip';

/**
 * Opt a controller or route out of the global TenantGuard (health checks, signup, login,
 * webhooks). Anything without this decorator requires an organization in context.
 */
export const SkipTenant = () => SetMetadata(SKIP_TENANT_KEY, true);
