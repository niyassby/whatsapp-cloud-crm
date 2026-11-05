import { randomBytes } from 'node:crypto';
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  type RawBodyRequest,
  Req,
  Res,
} from '@nestjs/common';
import {
  AppError,
  type DataDeletionStatusDto,
  ErrorCode,
  type SignedRequestInput,
  signedRequestSchema,
} from '@wacrm/shared';
import { parseSignedRequest, type SignedRequestPayload } from '@wacrm/whatsapp';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Public } from '../auth/decorators';
import { Meta, type RequestMeta } from '../common/request-meta';
import { zod } from '../common/zod.pipe';
import { PrismaService } from '../db/prisma.service';
import { API_ENV, type ApiEnv } from '../env';
import { QueuesService } from '../infra/queues.service';
import { RateLimiter } from '../infra/rate-limiter.service';
import { WebhookIngestService } from './webhook-ingest.service';

/** Meta -> us. Tiny on purpose: verify, store, enqueue, answer. Logic lives in the worker. */
@Public()
@Controller('webhooks/meta')
export class WebhooksController {
  constructor(private readonly ingest: WebhookIngestService) {}

  @Get()
  verify(
    @Query('hub.mode') mode: string | undefined,
    @Query('hub.verify_token') token: string | undefined,
    @Query('hub.challenge') challenge: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): string {
    void reply.type('text/plain');
    return this.ingest.verifyChallenge(mode, token, challenge);
  }

  @Post()
  @HttpCode(200)
  async receive(
    @Req() req: RawBodyRequest<FastifyRequest>,
    @Headers('x-hub-signature-256') signature: string | undefined,
  ): Promise<{ received: true }> {
    await this.ingest.receive(req.rawBody, signature);
    return { received: true };
  }
}

/** Facebook Login callbacks configured in the Meta app dashboard. */
@Public()
@Controller('meta')
export class MetaCallbacksController {
  constructor(
    @Inject(API_ENV) private readonly env: ApiEnv,
    private readonly prisma: PrismaService,
    private readonly queues: QueuesService,
    private readonly rateLimiter: RateLimiter,
  ) {}

  @Post('deauthorize')
  @HttpCode(200)
  async deauthorize(
    @Body(zod(signedRequestSchema)) body: SignedRequestInput,
  ): Promise<{ received: true }> {
    const payload = this.verify(body.signed_request);
    await this.queues.enqueueMetaAccount({ kind: 'deauthorize', metaUserId: payload.user_id! });
    return { received: true };
  }

  /** Meta requires exactly this response shape: a status URL and a confirmation code. */
  @Post('data-deletion')
  @HttpCode(200)
  async dataDeletion(
    @Body(zod(signedRequestSchema)) body: SignedRequestInput,
  ): Promise<{ url: string; confirmation_code: string }> {
    const payload = this.verify(body.signed_request);
    const code = randomBytes(12).toString('hex');
    const [row] = await this.prisma.client.$queryRaw<{ id: string }[]>`
      SELECT data_deletion_create(${payload.user_id!}, ${code}) AS id`;
    if (!row) throw new AppError(ErrorCode.INTERNAL, 'Could not record the deletion request');
    await this.queues.enqueueMetaAccount({
      kind: 'data_deletion',
      metaUserId: payload.user_id!,
      requestId: row.id,
    });
    return {
      url: `${this.env.WEB_URL}/data-deletion?code=${code}`,
      confirmation_code: code,
    };
  }

  @Get('data-deletion/:code')
  async dataDeletionStatus(
    @Param('code') code: string,
    @Meta() meta: RequestMeta,
  ): Promise<DataDeletionStatusDto> {
    await this.rateLimiter.consume(`rl:deletion-status:ip:${meta.ip}`, 30, 60);
    const [row] = await this.prisma.client.$queryRaw<
      { status: 'received' | 'completed'; requested_at: Date; completed_at: Date | null }[]
    >`SELECT * FROM data_deletion_status(${code})`;
    if (!row) throw new AppError(ErrorCode.NOT_FOUND, 'Unknown confirmation code');
    return {
      confirmationCode: code,
      status: row.status,
      requestedAt: row.requested_at.toISOString(),
      completedAt: row.completed_at?.toISOString() ?? null,
    };
  }

  private verify(signedRequest: string): SignedRequestPayload {
    if (!this.env.META_APP_SECRET) {
      throw new AppError(ErrorCode.WHATSAPP_NOT_CONFIGURED, 'META_APP_SECRET is not set');
    }
    let payload: SignedRequestPayload;
    try {
      payload = parseSignedRequest(signedRequest, this.env.META_APP_SECRET);
    } catch {
      throw new AppError(ErrorCode.WEBHOOK_SIGNATURE_INVALID, 'Invalid signed_request');
    }
    if (!payload.user_id) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'signed_request has no user_id');
    }
    return payload;
  }
}
