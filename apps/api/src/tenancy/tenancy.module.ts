import { Global, Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { TenantContextInterceptor } from './tenant-context.interceptor';
import { TenantGuard } from './tenant.guard';
import { TenantPrismaService } from './tenant-prisma.service';

@Global()
@Module({
  providers: [
    TenantPrismaService,
    // TODO(phase-1.3): the global AuthGuard must be registered before TenantGuard.
    { provide: APP_GUARD, useClass: TenantGuard },
    { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
  ],
  exports: [TenantPrismaService],
})
export class TenancyModule {}
