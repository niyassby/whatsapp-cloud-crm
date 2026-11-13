import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Inject,
  Logger,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  type RawBodyRequest,
  Req,
  Res,
} from '@nestjs/common';
import {
  AppError,
  type ChannelDto,
  type CreateWebchatInput,
  createWebchatSchema,
  ErrorCode,
  instagramTokenConnectSchema,
  type InstagramStartDto,
  Permission,
  type UpdateChannelInput,
  updateChannelSchema,
  type WebchatMessageDto,
  type WebchatMessageInput,
  webchatMessageSchema,
  webchatReadSchema,
  webchatSessionSchema,
  type WebchatSessionDto,
} from '@wacrm/shared';
import {
  splitInstagramPayload,
  verifyWebhookChallenge,
  verifyWebhookSignature,
} from '@wacrm/whatsapp';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { CurrentAuth, Public, RequireFeature, RequirePermission } from '../auth/decorators';
import { Meta, type RequestMeta } from '../common/request-meta';
import { zod } from '../common/zod.pipe';
import { PrismaService } from '../db/prisma.service';
import { API_ENV, type ApiEnv } from '../env';
import { QueuesService } from '../infra/queues.service';
import type { AuthContext } from '../tenancy/request-context';
import { type ChannelActor, ChannelsService } from './channels.service';
import { WebchatService } from './webchat.service';
import { widgetScript } from './widget-script';

const actor = (auth: AuthContext, meta: RequestMeta): ChannelActor => {
  if (!auth.orgId)
    throw new AppError(ErrorCode.TENANT_CONTEXT_MISSING, 'An organization is required');
  return { userId: auth.userId, orgId: auth.orgId, meta };
};

@Controller('channels')
export class ChannelsController {
  constructor(private readonly channels: ChannelsService) {}

  @Get()
  @RequirePermission(Permission.INBOX_READ)
  list(): Promise<ChannelDto[]> {
    return this.channels.list();
  }

  @Post('webchat')
  @RequireFeature('webchat')
  @RequirePermission(Permission.CHANNELS_MANAGE)
  createWebchat(
    @CurrentAuth() auth: AuthContext,
    @Body(zod(createWebchatSchema)) body: CreateWebchatInput,
    @Meta() meta: RequestMeta,
  ): Promise<ChannelDto> {
    return this.channels.createWebchat(actor(auth, meta), body);
  }

  @Post('instagram/start')
  @HttpCode(200)
  @RequireFeature('instagram')
  @RequirePermission(Permission.CHANNELS_MANAGE)
  instagramStart(
    @CurrentAuth() auth: AuthContext,
    @Meta() meta: RequestMeta,
  ): Promise<InstagramStartDto> {
    return this.channels.instagramStart(actor(auth, meta));
  }

  @Post('instagram/token')
  @RequireFeature('instagram')
  @RequirePermission(Permission.CHANNELS_MANAGE)
  instagramToken(
    @CurrentAuth() auth: AuthContext,
    @Body(zod(instagramTokenConnectSchema)) body: { accessToken: string },
    @Meta() meta: RequestMeta,
  ): Promise<ChannelDto> {
    return this.channels.instagramWithToken(actor(auth, meta), body.accessToken);
  }

  @Patch(':id')
  @RequirePermission(Permission.CHANNELS_MANAGE)
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zod(updateChannelSchema)) body: UpdateChannelInput,
    @Meta() meta: RequestMeta,
  ): Promise<ChannelDto> {
    return this.channels.update(actor(auth, meta), id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission(Permission.CHANNELS_MANAGE)
  async disconnect(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Meta() meta: RequestMeta,
  ): Promise<void> {
    await this.channels.disconnect(actor(auth, meta), id);
  }
}

/** Instagram sends the browser back here after login. */
@Public()
@Controller('channels/instagram')
export class InstagramCallbackController {
  constructor(private readonly channels: ChannelsService) {}

  @Get('callback')
  async callback(
    @Query() query: { code?: string; state?: string; error?: string },
    @Res() res: FastifyReply,
  ): Promise<void> {
    const to = await this.channels.instagramCallback({
      code: typeof query.code === 'string' ? query.code : undefined,
      state: typeof query.state === 'string' ? query.state : undefined,
      error: typeof query.error === 'string' ? query.error : undefined,
    });
    await res.status(302).header('location', to).send();
  }
}

/** Meta -> us for Instagram. Tiny on purpose: verify, store, enqueue, answer. */
@Public()
@Controller('webhooks/instagram')
export class InstagramWebhooksController {
  private readonly logger = new Logger(InstagramWebhooksController.name);

  constructor(
    @Inject(API_ENV) private readonly env: ApiEnv,
    private readonly prisma: PrismaService,
    private readonly queues: QueuesService,
  ) {}

  @Get()
  verify(
    @Query('hub.mode') mode: string | undefined,
    @Query('hub.verify_token') token: string | undefined,
    @Query('hub.challenge') challenge: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
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
    void reply.type('text/plain');
    return echoed;
  }

  @Post()
  @HttpCode(200)
  async receive(
    @Req() req: RawBodyRequest<FastifyRequest>,
    @Headers('x-hub-signature-256') signature: string | undefined,
  ): Promise<{ received: true }> {
    const secret = this.env.INSTAGRAM_APP_SECRET;
    if (!secret) {
      throw new AppError(ErrorCode.WHATSAPP_NOT_CONFIGURED, 'INSTAGRAM_APP_SECRET is not set');
    }
    if (!req.rawBody || !verifyWebhookSignature(req.rawBody, signature, secret)) {
      this.logger.warn('rejected Instagram webhook with an invalid signature');
      throw new AppError(ErrorCode.WEBHOOK_SIGNATURE_INVALID, 'Invalid signature');
    }
    for (const event of splitInstagramPayload(JSON.parse(req.rawBody.toString('utf8')))) {
      const payload = JSON.stringify(event.payload);
      // Reviewed raw SQL: a definer function, since no workspace is known yet.
      const [row] = await this.prisma.client.$queryRaw<{ id: string; status: string }[]>`
        SELECT id, status FROM webhook_event_ingest_for(
          'instagram', ${event.dedupeKey}, ${event.accountId}, 'messages', ${payload}::jsonb
        )`;
      if (!row) throw new Error('webhook_event_ingest_for returned no row');
      if (row.status === 'received') await this.queues.enqueueWebhookEvent(row.id);
    }
    return { received: true };
  }
}

/** The website chat widget. Public, and keyed by the widget's public key. */
@Public()
@Controller('webchat')
export class WebchatController {
  constructor(
    @Inject(API_ENV) private readonly env: ApiEnv,
    private readonly webchat: WebchatService,
  ) {}

  @Get('widget.js')
  script(@Res({ passthrough: true }) reply: FastifyReply): string {
    void reply
      .type('application/javascript; charset=utf-8')
      .header('cache-control', 'public, max-age=3600')
      // Loaded by other sites by design.
      .header('cross-origin-resource-policy', 'cross-origin');
    return widgetScript(this.env.WEB_URL);
  }

  @Post(':key/session')
  @HttpCode(200)
  session(
    @Param('key') key: string,
    @Body(zod(webchatSessionSchema)) body: { token?: string; origin?: string },
    @Meta() meta: RequestMeta,
  ): Promise<WebchatSessionDto> {
    return this.webchat.session(key, body, meta.ip);
  }

  /** POST so the token stays out of URLs and logs. */
  @Post(':key/history')
  @HttpCode(200)
  history(
    @Param('key') key: string,
    @Body(zod(webchatReadSchema)) body: { token: string },
  ): Promise<WebchatMessageDto[]> {
    return this.webchat.messages(key, body.token);
  }

  @Post(':key/messages')
  send(
    @Param('key') key: string,
    @Body(zod(webchatMessageSchema)) body: WebchatMessageInput,
    @Meta() meta: RequestMeta,
  ): Promise<WebchatMessageDto> {
    return this.webchat.send(key, body, meta.ip);
  }
}
