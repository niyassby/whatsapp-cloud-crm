import { Body, Controller, HttpCode, Module, Post } from '@nestjs/common';
import { CurrentAuth } from '../auth/decorators';
import { Meta, type RequestMeta } from '../common/request-meta';
import type { AuthContext } from '../tenancy/request-context';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { PartnerController } from './partner.controller';
import { PartnerService } from './partner.service';
import { WorkspacesService } from './workspaces.service';

/** Called from inside the workspace being viewed, with the impersonation token itself. */
@Controller('impersonation')
export class ImpersonationController {
  constructor(private readonly workspaces: WorkspacesService) {}

  @Post('end')
  @HttpCode(204)
  async end(
    @CurrentAuth() auth: AuthContext,
    @Meta() meta: RequestMeta,
    @Body() _body: unknown,
  ): Promise<void> {
    await this.workspaces.endImpersonation(auth, meta);
  }
}

@Module({
  controllers: [PartnerController, AdminController, ImpersonationController],
  providers: [WorkspacesService, PartnerService, AdminService],
})
export class ResellerModule {}
