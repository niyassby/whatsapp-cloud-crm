import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  AppError,
  type BillingProfileDto,
  type BillingSummaryDto,
  type CheckoutInput,
  type CheckoutResultDto,
  checkoutSchema,
  type CreateTopupInput,
  createTopupSchema,
  type CursorPage,
  ErrorCode,
  type InvoiceDto,
  type ListInvoicesQuery,
  listInvoicesSchema,
  Permission,
  type PlanDto,
  type TopupQuoteDto,
  topupQuoteSchema,
  type UpdateBillingProfileInput,
  updateBillingProfileSchema,
} from '@wacrm/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { CurrentAuth, RequirePermission } from '../auth/decorators';
import { requestMeta } from '../common/request-meta';
import { zod } from '../common/zod.pipe';
import { API_ENV, type ApiEnv } from '../env';
import type { AuthContext } from '../tenancy/request-context';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service';
import { type BillingActor, BillingService } from './billing.service';
import { type InvoicePdfInput, renderInvoicePdf } from './invoice-pdf';

function actor(auth: AuthContext, req?: FastifyRequest): BillingActor {
  if (!auth.orgId) {
    throw new AppError(ErrorCode.TENANT_CONTEXT_MISSING, 'An organization context is required');
  }
  return { userId: auth.userId, orgId: auth.orgId, meta: req ? requestMeta(req) : undefined };
}

@Controller('billing')
export class BillingController {
  constructor(
    private readonly billing: BillingService,
    private readonly db: TenantPrismaService,
    @Inject(API_ENV) private readonly env: ApiEnv,
  ) {}

  @Get('plans')
  @RequirePermission(Permission.BILLING_READ)
  plans(@CurrentAuth() auth: AuthContext): Promise<PlanDto[]> {
    return this.billing.plans(actor(auth));
  }

  @Get('summary')
  @RequirePermission(Permission.BILLING_READ)
  summary(@CurrentAuth() auth: AuthContext): Promise<BillingSummaryDto> {
    return this.billing.summary(actor(auth));
  }

  @Patch('profile')
  @RequirePermission(Permission.BILLING_MANAGE)
  updateProfile(
    @CurrentAuth() auth: AuthContext,
    @Req() req: FastifyRequest,
    @Body(zod(updateBillingProfileSchema)) body: UpdateBillingProfileInput,
  ): Promise<BillingProfileDto> {
    return this.billing.updateProfile(actor(auth, req), body);
  }

  @Post('checkout')
  @HttpCode(200)
  @RequirePermission(Permission.BILLING_MANAGE)
  checkout(
    @CurrentAuth() auth: AuthContext,
    @Req() req: FastifyRequest,
    @Body(zod(checkoutSchema)) body: CheckoutInput,
  ): Promise<CheckoutResultDto> {
    return this.billing.checkout(actor(auth, req), body);
  }

  @Post('cancel')
  @HttpCode(204)
  @RequirePermission(Permission.BILLING_MANAGE)
  async cancel(@CurrentAuth() auth: AuthContext, @Req() req: FastifyRequest): Promise<void> {
    await this.billing.cancel(actor(auth, req));
  }

  @Post('manage-payment')
  @HttpCode(200)
  @RequirePermission(Permission.BILLING_MANAGE)
  managePayment(@CurrentAuth() auth: AuthContext): Promise<CheckoutResultDto> {
    return this.billing.managePayment(actor(auth));
  }

  @Get('topup-quote')
  @RequirePermission(Permission.BILLING_MANAGE)
  topupQuote(
    @CurrentAuth() auth: AuthContext,
    @Query(zod(topupQuoteSchema)) q: z.infer<typeof topupQuoteSchema>,
  ): Promise<TopupQuoteDto> {
    return this.billing.topupQuote(actor(auth), q.amount);
  }

  @Post('topups')
  @HttpCode(200)
  @RequirePermission(Permission.BILLING_MANAGE)
  createTopup(
    @CurrentAuth() auth: AuthContext,
    @Req() req: FastifyRequest,
    @Body(zod(createTopupSchema)) body: CreateTopupInput,
  ): Promise<CheckoutResultDto> {
    return this.billing.createTopup(actor(auth, req), body);
  }

  @Get('invoices')
  @RequirePermission(Permission.BILLING_READ)
  invoices(@Query(zod(listInvoicesSchema)) q: ListInvoicesQuery): Promise<CursorPage<InvoiceDto>> {
    return this.billing.invoices(q);
  }

  @Get('invoices/:id/pdf')
  @RequirePermission(Permission.BILLING_READ)
  async invoicePdf(
    @Param('id', ParseUUIDPipe) id: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const row = await this.db.run((tx) => tx.invoice.findUnique({ where: { id } }));
    if (!row) throw new AppError(ErrorCode.NOT_FOUND, 'Invoice not found');
    const pdf = await renderInvoicePdf({
      ...row,
      subtotalMicros: Number(row.subtotalMicros),
      taxMicros: Number(row.taxMicros),
      totalMicros: Number(row.totalMicros),
      billTo: row.billTo as InvoicePdfInput['billTo'],
      seller: {
        name: this.env.BILLING_SELLER_NAME ?? this.env.APP_NAME,
        address: this.env.BILLING_SELLER_ADDRESS ?? null,
        taxId: this.env.BILLING_SELLER_TAX_ID ?? null,
      },
    });
    await reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', `attachment; filename="${row.number}.pdf"`)
      .send(pdf);
  }
}
