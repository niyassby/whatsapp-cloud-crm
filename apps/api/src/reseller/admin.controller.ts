import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  type AdminOrgDto,
  type AdminOrgListQuery,
  adminOrgListSchema,
  type AdminPlanDto,
  type AdminRateCardDto,
  type ClientDetailDto,
  closeStatementSchema,
  type CreatePartnerInput,
  createPartnerSchema,
  type CreateRateCardInput,
  createRateCardSchema,
  type CursorPage,
  type CursorQuery,
  cursorQuerySchema,
  type ImpersonateInput,
  impersonateSchema,
  type ImpersonationStartDto,
  markStatementPaidSchema,
  type PartnerDto,
  type PartnerMemberDto,
  partnerMemberSchema,
  type PartnerStatementDto,
  setOrgPlanSchema,
  type SystemStatusDto,
  type UpdatePartnerInput,
  updatePartnerSchema,
  type UpdatePlanInput,
  updatePlanSchema,
  type WalletCreditInput,
  walletCreditSchema,
  type WholesalePriceInput,
  wholesalePriceSchema,
} from '@wacrm/shared';
import { CurrentAuth, PlatformAdminRoute } from '../auth/decorators';
import { Meta, type RequestMeta } from '../common/request-meta';
import { zod } from '../common/zod.pipe';
import type { AuthContext } from '../tenancy/request-context';
import { AdminService } from './admin.service';
import { operatorOf, WorkspacesService } from './workspaces.service';

/** The platform's console. @PlatformAdminRoute checks platform_admins on every request. */
@PlatformAdminRoute()
@Controller('admin')
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly workspaces: WorkspacesService,
  ) {}

  // ------------------------------------------------------------------ partners

  @Get('partners')
  partners(): Promise<PartnerDto[]> {
    return this.admin.listPartners();
  }

  @Post('partners')
  createPartner(
    @CurrentAuth() auth: AuthContext,
    @Body(zod(createPartnerSchema)) body: CreatePartnerInput,
    @Meta() meta: RequestMeta,
  ): Promise<PartnerDto> {
    return this.admin.createPartner(operatorOf(auth, meta), body);
  }

  @Patch('partners/:id')
  updatePartner(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zod(updatePartnerSchema)) body: UpdatePartnerInput,
    @Meta() meta: RequestMeta,
  ): Promise<PartnerDto> {
    return this.admin.updatePartner(operatorOf(auth, meta), id, body);
  }

  @Get('partners/:id/members')
  members(@Param('id', ParseUUIDPipe) id: string): Promise<PartnerMemberDto[]> {
    return this.admin.listMembers(id);
  }

  @Post('partners/:id/members')
  addMember(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zod(partnerMemberSchema)) body: { email: string },
    @Meta() meta: RequestMeta,
  ): Promise<PartnerMemberDto[]> {
    return this.admin.addMember(operatorOf(auth, meta), id, body.email);
  }

  @Delete('partners/:id/members/:userId')
  @HttpCode(204)
  async removeMember(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Meta() meta: RequestMeta,
  ): Promise<void> {
    await this.admin.removeMember(operatorOf(auth, meta), id, userId);
  }

  @Post('partners/:id/statements/close')
  @HttpCode(200)
  async closeStatement(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zod(closeStatementSchema)) body: { period: string },
    @Meta() meta: RequestMeta,
  ): Promise<{ statement: PartnerStatementDto | null }> {
    return {
      statement: await this.admin.closeStatement(operatorOf(auth, meta), id, body.period),
    };
  }

  // ------------------------------------------------------------------ organizations

  @Get('orgs')
  orgs(@Query(zod(adminOrgListSchema)) query: AdminOrgListQuery): Promise<CursorPage<AdminOrgDto>> {
    return this.admin.listOrgs(query);
  }

  @Get('orgs/:id')
  org(@Param('id', ParseUUIDPipe) id: string): Promise<ClientDetailDto> {
    return this.workspaces.detail(id);
  }

  @Post('orgs/:id/suspend')
  @HttpCode(204)
  async suspend(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Meta() meta: RequestMeta,
  ): Promise<void> {
    await this.workspaces.setStatus(id, 'suspended', operatorOf(auth, meta));
  }

  @Post('orgs/:id/resume')
  @HttpCode(204)
  async resume(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Meta() meta: RequestMeta,
  ): Promise<void> {
    await this.workspaces.setStatus(id, 'active', operatorOf(auth, meta));
  }

  @Patch('orgs/:id/plan')
  @HttpCode(204)
  async setPlan(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zod(setOrgPlanSchema)) body: { planCode: string },
    @Meta() meta: RequestMeta,
  ): Promise<void> {
    const plan = await this.admin.planByCode(body.planCode);
    await this.workspaces.setPlan(id, plan.id, plan.code, operatorOf(auth, meta));
  }

  @Post('orgs/:id/wallet/credit')
  @HttpCode(200)
  async credit(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zod(walletCreditSchema)) body: WalletCreditInput,
    @Meta() meta: RequestMeta,
  ): Promise<{ applied: boolean; balanceMicros: number }> {
    const currency = await this.admin.orgCurrency(id);
    return this.workspaces.credit(id, body, operatorOf(auth, meta), currency);
  }

  @Post('orgs/:id/impersonate')
  @HttpCode(200)
  impersonate(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zod(impersonateSchema)) body: ImpersonateInput,
    @Meta() meta: RequestMeta,
  ): Promise<ImpersonationStartDto> {
    return this.workspaces.impersonate(id, body.reason, operatorOf(auth, meta));
  }

  // ------------------------------------------------------------------ plans, feature flags, rates

  @Get('plans')
  plans(): Promise<AdminPlanDto[]> {
    return this.admin.listPlans();
  }

  @Patch('plans/:code')
  updatePlan(
    @CurrentAuth() auth: AuthContext,
    @Param('code') code: string,
    @Body(zod(updatePlanSchema)) body: UpdatePlanInput,
    @Meta() meta: RequestMeta,
  ): Promise<AdminPlanDto[]> {
    return this.admin.updatePlan(operatorOf(auth, meta), code, body);
  }

  @Put('plans/:code/wholesale')
  setWholesale(
    @CurrentAuth() auth: AuthContext,
    @Param('code') code: string,
    @Body(zod(wholesalePriceSchema)) body: WholesalePriceInput,
    @Meta() meta: RequestMeta,
  ): Promise<AdminPlanDto[]> {
    return this.admin.setWholesalePrice(operatorOf(auth, meta), code, body);
  }

  @Get('rate-cards')
  rateCards(@Query('currency') currency?: string): Promise<AdminRateCardDto[]> {
    return this.admin.listRateCards(
      currency && /^[A-Za-z]{3}$/.test(currency) ? currency.toUpperCase() : undefined,
    );
  }

  @Post('rate-cards')
  addRateCard(
    @CurrentAuth() auth: AuthContext,
    @Body(zod(createRateCardSchema)) body: CreateRateCardInput,
    @Meta() meta: RequestMeta,
  ): Promise<AdminRateCardDto[]> {
    return this.admin.addRateCard(operatorOf(auth, meta), body);
  }

  // ------------------------------------------------------------------ statements, audit, system

  @Get('statements')
  statements(@Query('status') status?: string): Promise<PartnerStatementDto[]> {
    return this.admin.listStatements(status === 'issued' || status === 'paid' ? status : undefined);
  }

  @Post('statements/:id/paid')
  @HttpCode(204)
  async markPaid(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zod(markStatementPaidSchema)) body: { reference: string },
    @Meta() meta: RequestMeta,
  ): Promise<void> {
    await this.admin.markStatementPaid(operatorOf(auth, meta), id, body.reference);
  }

  @Get('audit')
  audit(@Query(zod(cursorQuerySchema)) query: CursorQuery) {
    return this.admin.auditLog(query);
  }

  @Get('system')
  system(): Promise<SystemStatusDto> {
    return this.admin.system();
  }
}
