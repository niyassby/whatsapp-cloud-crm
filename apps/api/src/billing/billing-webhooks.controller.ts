import {
  Controller,
  Headers,
  HttpCode,
  Inject,
  Logger,
  Post,
  type RawBodyRequest,
  Req,
} from '@nestjs/common';
import type { PaymentProviders } from '@wacrm/billing';
import { AppError, ErrorCode, type PaymentProviderId } from '@wacrm/shared';
import type { FastifyRequest } from 'fastify';
import { Public } from '../auth/decorators';
import { PrismaService } from '../db/prisma.service';
import { QueuesService } from '../infra/queues.service';
import { PAYMENT_PROVIDERS } from './billing.tokens';

/**
 * Providers -> us. Tiny on purpose: verify the raw bytes, store, enqueue, answer. A failure answers
 * 5xx so the provider redelivers, and a redelivery finds the row it already made.
 */
@Public()
@Controller('webhooks')
export class BillingWebhooksController {
  private readonly logger = new Logger(BillingWebhooksController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueuesService,
    @Inject(PAYMENT_PROVIDERS) private readonly providers: PaymentProviders,
  ) {}

  private async receive(
    providerId: PaymentProviderId,
    rawBody: Buffer | undefined,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<{ received: true }> {
    const provider = this.providers[providerId];
    if (!provider) {
      throw new AppError(ErrorCode.BILLING_NOT_CONFIGURED, `${providerId} is not set up`);
    }
    const verified = rawBody ? provider.verifyWebhook(rawBody, headers) : null;
    if (!verified) {
      this.logger.warn(`rejected a ${providerId} webhook with an invalid signature`);
      throw new AppError(ErrorCode.WEBHOOK_SIGNATURE_INVALID, 'Invalid signature');
    }
    const payload = JSON.stringify(verified.payload);
    // Reviewed raw SQL: a definer function with bound parameters, as no tenant is known yet.
    const [row] = await this.prisma.client.$queryRaw<{ id: string; status: string }[]>`
      SELECT id, status::text AS status FROM billing_event_ingest(
        ${providerId}, ${verified.eventId}, ${verified.type}, ${payload}::jsonb
      )`;
    if (!row) throw new Error('billing_event_ingest returned no row');
    // Still 'received' on a redelivery means an earlier attempt may have died before enqueuing.
    if (row.status === 'received') await this.queues.enqueueBillingEvent(row.id);
    return { received: true };
  }

  @Post('stripe')
  @HttpCode(200)
  stripe(
    @Req() req: RawBodyRequest<FastifyRequest>,
    @Headers() headers: Record<string, string | string[] | undefined>,
  ) {
    return this.receive('stripe', req.rawBody, headers);
  }

  @Post('razorpay')
  @HttpCode(200)
  razorpay(
    @Req() req: RawBodyRequest<FastifyRequest>,
    @Headers() headers: Record<string, string | string[] | undefined>,
  ) {
    return this.receive('razorpay', req.rawBody, headers);
  }
}
