import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { TenantContextInterceptor } from './tenant-context.interceptor';
import { TenantPrismaService } from './tenant-prisma.service';

/**
 * Tenancy layer 1 lives in AccessGuard (auth module): it requires an org unless @SkipTenant.
 * This module exposes the request context to services and the RLS-scoped DB access.
 */
@Global()
@Module({
  providers: [
    TenantPrismaService,
    { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
  ],
  exports: [TenantPrismaService],
})
export class TenancyModule {}
