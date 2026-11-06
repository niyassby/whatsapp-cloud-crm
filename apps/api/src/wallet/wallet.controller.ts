import { Body, Controller, Get, Patch, Query, Req, Res } from '@nestjs/common';
import {
  AppError,
  type CursorPage,
  ErrorCode,
  type LedgerEntryDto,
  type ListLedgerQuery,
  listLedgerSchema,
  Permission,
  type RateDto,
  type UpdateWalletInput,
  updateWalletSchema,
  type WalletDto,
  type WalletRangeQuery,
  walletRangeSchema,
  type WalletUsageDto,
} from '@wacrm/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { CurrentAuth, RequirePermission } from '../auth/decorators';
import { requestMeta } from '../common/request-meta';
import { zod } from '../common/zod.pipe';
import type { AuthContext } from '../tenancy/request-context';
import { type WalletActor, WalletService } from './wallet.service';

function actor(auth: AuthContext, req?: FastifyRequest): WalletActor {
  if (!auth.orgId) {
    throw new AppError(ErrorCode.TENANT_CONTEXT_MISSING, 'An organization context is required');
  }
  return { userId: auth.userId, orgId: auth.orgId, meta: req ? requestMeta(req) : undefined };
}

/**
 * Reading and settings only. Money moves through src/wallet.ts in @wacrm/db, as part of what it
 * pays for: there is deliberately no endpoint that adds to or takes from a balance.
 */
@Controller('wallet')
export class WalletController {
  constructor(private readonly wallet: WalletService) {}

  @Get()
  @RequirePermission(Permission.WALLET_READ)
  get(@CurrentAuth() auth: AuthContext): Promise<WalletDto> {
    return this.wallet.get(actor(auth));
  }

  @Patch()
  @RequirePermission(Permission.BILLING_MANAGE)
  update(
    @CurrentAuth() auth: AuthContext,
    @Req() req: FastifyRequest,
    @Body(zod(updateWalletSchema)) body: UpdateWalletInput,
  ): Promise<WalletDto> {
    return this.wallet.update(actor(auth, req), body);
  }

  @Get('ledger')
  @RequirePermission(Permission.WALLET_READ)
  ledger(
    @Query(zod(listLedgerSchema)) query: ListLedgerQuery,
  ): Promise<CursorPage<LedgerEntryDto>> {
    return this.wallet.ledger(query);
  }

  @Get('usage')
  @RequirePermission(Permission.WALLET_READ)
  usage(
    @CurrentAuth() auth: AuthContext,
    @Query(zod(walletRangeSchema)) query: WalletRangeQuery,
  ): Promise<WalletUsageDto> {
    return this.wallet.usage(actor(auth), query);
  }

  @Get('rates')
  @RequirePermission(Permission.WALLET_READ)
  rates(@CurrentAuth() auth: AuthContext): Promise<RateDto[]> {
    return this.wallet.rates(actor(auth));
  }

  @Get('ledger/export')
  @RequirePermission(Permission.WALLET_READ)
  async export(
    @CurrentAuth() auth: AuthContext,
    @Req() req: FastifyRequest,
    @Query(zod(walletRangeSchema)) query: WalletRangeQuery,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const csv = await this.wallet.exportCsv(actor(auth, req), query);
    await reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', 'attachment; filename="wallet-ledger.csv"')
      .send(csv);
  }
}
