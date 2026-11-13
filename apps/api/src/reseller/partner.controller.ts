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
  Query,
} from '@nestjs/common';
import {
  type ClientDetailDto,
  type ClientDto,
  type CreateClientInput,
  createClientSchema,
  type CursorPage,
  type ImpersonateInput,
  impersonateSchema,
  type ImpersonationStartDto,
  inviteOwnerSchema,
  type PartnerDto,
  type PartnerLedgerEntryDto,
  type PartnerLedgerQuery,
  partnerLedgerQuerySchema,
  type PartnerPlanDto,
  type PartnerStatementDto,
  type PartnerTotalsDto,
  type UpdateClientInput,
  updateClientSchema,
  updatePartnerSelfSchema,
  type WalletCreditInput,
  walletCreditSchema,
} from '@wacrm/shared';
import { CurrentAuth, PartnerRoute } from '../auth/decorators';
import { Meta, type RequestMeta } from '../common/request-meta';
import { zod } from '../common/zod.pipe';
import type { AuthContext } from '../tenancy/request-context';
import { partnerOperator, PartnerService } from './partner.service';
import { operatorOf, WorkspacesService } from './workspaces.service';

const by = (auth: AuthContext, meta: RequestMeta) => partnerOperator(operatorOf(auth, meta));

/**
 * The partner console. @PartnerRoute checks on every request that the caller works for an active
 * partner; each client workspace named in a path is then checked to be that partner's.
 */
@PartnerRoute()
@Controller('partner')
export class PartnerController {
  constructor(
    private readonly partners: PartnerService,
    private readonly workspaces: WorkspacesService,
  ) {}

  @Get()
  profile(@CurrentAuth() auth: AuthContext, @Meta() meta: RequestMeta): Promise<PartnerDto> {
    return this.partners.profile(by(auth, meta));
  }

  @Patch()
  setMarkup(
    @CurrentAuth() auth: AuthContext,
    @Body(zod(updatePartnerSelfSchema)) body: { walletMarkupBps: number },
    @Meta() meta: RequestMeta,
  ): Promise<PartnerDto> {
    return this.partners.setMarkup(by(auth, meta), body.walletMarkupBps);
  }

  @Get('plans')
  plans(@CurrentAuth() auth: AuthContext, @Meta() meta: RequestMeta): Promise<PartnerPlanDto[]> {
    return this.partners.plans(by(auth, meta));
  }

  @Get('summary')
  summary(@CurrentAuth() auth: AuthContext, @Meta() meta: RequestMeta): Promise<PartnerTotalsDto> {
    return this.partners.summary(by(auth, meta));
  }

  @Get('ledger')
  ledger(
    @CurrentAuth() auth: AuthContext,
    @Query(zod(partnerLedgerQuerySchema)) query: PartnerLedgerQuery,
    @Meta() meta: RequestMeta,
  ): Promise<CursorPage<PartnerLedgerEntryDto>> {
    return this.partners.ledger(by(auth, meta), query);
  }

  @Get('statements')
  statements(
    @CurrentAuth() auth: AuthContext,
    @Meta() meta: RequestMeta,
  ): Promise<PartnerStatementDto[]> {
    return this.partners.statements(by(auth, meta));
  }

  @Get('clients')
  clients(@CurrentAuth() auth: AuthContext, @Meta() meta: RequestMeta): Promise<ClientDto[]> {
    return this.partners.listClients(by(auth, meta));
  }

  @Post('clients')
  createClient(
    @CurrentAuth() auth: AuthContext,
    @Body(zod(createClientSchema)) body: CreateClientInput,
    @Meta() meta: RequestMeta,
  ): Promise<ClientDto> {
    return this.partners.createClient(by(auth, meta), body);
  }

  @Get('clients/:id')
  client(@Param('id', ParseUUIDPipe) id: string): Promise<ClientDetailDto> {
    return this.workspaces.detail(id);
  }

  @Patch('clients/:id')
  updateClient(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zod(updateClientSchema)) body: UpdateClientInput,
    @Meta() meta: RequestMeta,
  ): Promise<ClientDto> {
    return this.partners.updateClient(by(auth, meta), id, body);
  }

  @Post('clients/:id/suspend')
  @HttpCode(204)
  async suspend(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Meta() meta: RequestMeta,
  ): Promise<void> {
    await this.workspaces.setStatus(id, 'suspended', by(auth, meta));
  }

  @Post('clients/:id/resume')
  @HttpCode(204)
  async resume(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Meta() meta: RequestMeta,
  ): Promise<void> {
    await this.workspaces.setStatus(id, 'active', by(auth, meta));
  }

  @Delete('clients/:id')
  @HttpCode(204)
  async remove(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Meta() meta: RequestMeta,
  ): Promise<void> {
    await this.workspaces.remove(id, by(auth, meta));
  }

  @Post('clients/:id/invite-owner')
  @HttpCode(204)
  async inviteOwner(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zod(inviteOwnerSchema)) body: { email: string },
    @Meta() meta: RequestMeta,
  ): Promise<void> {
    await this.partners.inviteOwner(by(auth, meta), id, body.email);
  }

  @Post('clients/:id/wallet/credit')
  @HttpCode(200)
  credit(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zod(walletCreditSchema)) body: WalletCreditInput,
    @Meta() meta: RequestMeta,
  ): Promise<{ applied: boolean; balanceMicros: number }> {
    return this.partners.creditClient(by(auth, meta), id, body);
  }

  @Post('clients/:id/impersonate')
  @HttpCode(200)
  impersonate(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zod(impersonateSchema)) body: ImpersonateInput,
    @Meta() meta: RequestMeta,
  ): Promise<ImpersonationStartDto> {
    return this.workspaces.impersonate(id, body.reason, by(auth, meta));
  }
}
