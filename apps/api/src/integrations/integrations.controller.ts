import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
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
  type ConnectorDto,
  type CreateConnectionInput,
  createConnectionSchema,
  type CreatedConnectionDto,
  type CursorPage,
  ErrorCode,
  type IntegrationConnectionDto,
  type IntegrationEventDto,
  type ListIntegrationEventsQuery,
  listIntegrationEventsSchema,
  Permission,
  type StartOAuthInput,
  startOAuthSchema,
  type UpdateConnectionInput,
  updateConnectionSchema,
} from '@wacrm/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { CurrentAuth, Public, RequireFeature, RequirePermission } from '../auth/decorators';
import { requestMeta } from '../common/request-meta';
import { zod } from '../common/zod.pipe';
import type { AuthContext } from '../tenancy/request-context';
import { type IntegrationActor, IntegrationsService } from './integrations.service';

function actor(auth: AuthContext, req?: FastifyRequest): IntegrationActor {
  if (!auth.orgId) {
    throw new AppError(ErrorCode.TENANT_CONTEXT_MISSING, 'An organization context is required');
  }
  return { userId: auth.userId, orgId: auth.orgId, meta: req ? requestMeta(req) : undefined };
}

/**
 * Connections and their event log. Reading stays open after a plan drops, so past events stay
 * visible; connecting needs the plan's `integrations` feature.
 */
@Controller('integrations')
export class IntegrationsController {
  constructor(private readonly integrations: IntegrationsService) {}

  @Get('connectors')
  @RequirePermission(Permission.INTEGRATIONS_MANAGE)
  connectors(): ConnectorDto[] {
    return this.integrations.listConnectors();
  }

  @Get('connections')
  @RequirePermission(Permission.INTEGRATIONS_MANAGE)
  connections(): Promise<IntegrationConnectionDto[]> {
    return this.integrations.listConnections();
  }

  @Post('connections')
  @RequirePermission(Permission.INTEGRATIONS_MANAGE)
  @RequireFeature('integrations')
  create(
    @CurrentAuth() auth: AuthContext,
    @Req() req: FastifyRequest,
    @Body(zod(createConnectionSchema)) body: CreateConnectionInput,
  ): Promise<CreatedConnectionDto> {
    return this.integrations.create(actor(auth, req), body);
  }

  @Get('connections/:id')
  @RequirePermission(Permission.INTEGRATIONS_MANAGE)
  connection(@Param('id', ParseUUIDPipe) id: string): Promise<IntegrationConnectionDto> {
    return this.integrations.getConnection(id);
  }

  @Patch('connections/:id')
  @RequirePermission(Permission.INTEGRATIONS_MANAGE)
  @RequireFeature('integrations')
  update(
    @CurrentAuth() auth: AuthContext,
    @Req() req: FastifyRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zod(updateConnectionSchema)) body: UpdateConnectionInput,
  ): Promise<IntegrationConnectionDto> {
    return this.integrations.update(actor(auth, req), id, body);
  }

  @Post('connections/:id/disconnect')
  @HttpCode(200)
  @RequirePermission(Permission.INTEGRATIONS_MANAGE)
  disconnect(
    @CurrentAuth() auth: AuthContext,
    @Req() req: FastifyRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<IntegrationConnectionDto> {
    return this.integrations.disconnect(actor(auth, req), id);
  }

  @Post('connections/:id/test')
  @HttpCode(202)
  @RequirePermission(Permission.INTEGRATIONS_MANAGE)
  async test(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ queued: true }> {
    await this.integrations.test(actor(auth), id);
    return { queued: true };
  }

  @Get('connections/:id/events')
  @RequirePermission(Permission.INTEGRATIONS_MANAGE)
  events(
    @Param('id', ParseUUIDPipe) id: string,
    @Query(zod(listIntegrationEventsSchema)) q: ListIntegrationEventsQuery,
  ): Promise<CursorPage<IntegrationEventDto>> {
    return this.integrations.events(id, q);
  }

  @Post('events/:eventId/replay')
  @HttpCode(200)
  @RequirePermission(Permission.INTEGRATIONS_MANAGE)
  replay(
    @CurrentAuth() auth: AuthContext,
    @Param('eventId', ParseUUIDPipe) eventId: string,
  ): Promise<IntegrationEventDto> {
    return this.integrations.replay(actor(auth), eventId);
  }

  @Post('oauth/start')
  @HttpCode(200)
  @RequirePermission(Permission.INTEGRATIONS_MANAGE)
  @RequireFeature('integrations')
  startOAuth(
    @CurrentAuth() auth: AuthContext,
    @Body(zod(startOAuthSchema)) body: StartOAuthInput,
  ): Promise<{ url: string }> {
    return this.integrations.startOAuth(actor(auth), body);
  }
}

/**
 * What providers call: OAuth redirects and webhooks. No session; each request proves itself, by a
 * one-time state or by a signature on the raw body.
 */
@Public()
@Controller('integrations')
export class IntegrationsPublicController {
  constructor(private readonly integrations: IntegrationsService) {}

  @Get('oauth/callback')
  async callback(
    @Query() query: { code?: string; state?: string; error?: string },
    @Res() res: FastifyReply,
  ): Promise<void> {
    const to = await this.integrations.finishOAuth({
      code: typeof query.code === 'string' ? query.code : undefined,
      state: typeof query.state === 'string' ? query.state : undefined,
      error: typeof query.error === 'string' ? query.error : undefined,
    });
    await res.status(302).header('location', to).send();
  }

  @Post('hooks/:token')
  @HttpCode(200)
  hook(
    @Param('token') token: string,
    @Req() req: RawBodyRequest<FastifyRequest>,
    @Headers() headers: Record<string, string | string[] | undefined>,
  ): Promise<{ received: true }> {
    return this.integrations.receiveWebhook(token, req.rawBody, headers);
  }
}
