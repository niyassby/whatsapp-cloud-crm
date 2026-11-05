import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppError, ErrorCode } from '@wacrm/shared';
import {
  splitWebhookPayload,
  verifyWebhookChallenge,
  verifyWebhookSignature,
} from '@wacrm/whatsapp';
import { PrismaService } from '../db/prisma.service';
import { API_ENV, type ApiEnv } from '../env';
import { QueuesService } from '../infra/queues.service';

@Injectable()
export class WebhookIngestService {
  private readonly logger = new Logger(WebhookIngestService.name);

  constructor(
    @Inject(API_ENV) private readonly env: ApiEnv,
    private readonly prisma: PrismaService,
    private readonly queues: QueuesService,
  ) {}

  verifyChallenge(
    mode: string | undefined,
    token: string | undefined,
    challenge: string | undefined,
  ): string {
    if (!this.env.META_WEBHOOK_VERIFY_TOKEN) {
      throw new AppError(ErrorCode.WHATSAPP_NOT_CONFIGURED, 'META_WEBHOOK_VERIFY_TOKEN is not set');
    }
    const echoed = verifyWebhookChallenge({
      mode,
      token,
      challenge,
      expectedToken: this.env.META_WEBHOOK_VERIFY_TOKEN,
    });
    if (echoed === null) throw new AppError(ErrorCode.FORBIDDEN, 'Webhook verification failed');
    return echoed;
  }

  /**
   * Verify the signature on the exact bytes, store each change, enqueue, return.
   * A failure anywhere propagates as 5xx so Meta redelivers; redelivery is safe because storing
   * dedupes on the payload hash and jobs are keyed by event id.
   */
  async receive(rawBody: Buffer | undefined, signature: string | undefined): Promise<void> {
    if (!this.env.META_APP_SECRET) {
      throw new AppError(ErrorCode.WHATSAPP_NOT_CONFIGURED, 'META_APP_SECRET is not set');
    }
    if (!rawBody || !verifyWebhookSignature(rawBody, signature, this.env.META_APP_SECRET)) {
      this.logger.warn('rejected webhook with an invalid signature');
      throw new AppError(ErrorCode.WEBHOOK_SIGNATURE_INVALID, 'Invalid signature');
    }

    for (const event of splitWebhookPayload(JSON.parse(rawBody.toString('utf8')))) {
      const payload = JSON.stringify(event.payload);
      const [row] = await this.prisma.client.$queryRaw<{ id: string; status: string }[]>`
        SELECT id, status FROM webhook_event_ingest(
          ${event.dedupeKey}, ${event.wabaId}, ${event.phoneNumberId}, ${event.field},
          ${payload}::jsonb
        )`;
      if (!row) throw new Error('webhook_event_ingest returned no row');
      // Still 'received' on a redelivery means an earlier attempt may have died before enqueuing.
      if (row.status === 'received') await this.queues.enqueueWebhookEvent(row.id);
    }
  }
}
