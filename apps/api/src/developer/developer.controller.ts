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
  Req,
} from '@nestjs/common';
import {
  type ApiKeyDto,
  AppError,
  type CreatedApiKeyDto,
  type CreatedWebhookEndpointDto,
  type CreateApiKeyParsed,
  createApiKeySchema,
  type CreateWebhookEndpointParsed,
  createWebhookEndpointSchema,
  type CursorPage,
  ErrorCode,
  type ListWebhookDeliveriesQuery,
  listWebhookDeliveriesSchema,
  Permission,
  type UpdateWebhookEndpointInput,
  updateWebhookEndpointSchema,
  type WebhookDeliveryDto,
  type WebhookEndpointDto,
} from '@wacrm/shared';
import type { FastifyRequest } from 'fastify';
import { CurrentAuth, RequireFeature, RequirePermission } from '../auth/decorators';
import { requestMeta } from '../common/request-meta';
import { zod } from '../common/zod.pipe';
import type { AuthContext } from '../tenancy/request-context';
import { type DeveloperActor, DeveloperService } from './developer.service';

function actor(auth: AuthContext, req: FastifyRequest): DeveloperActor {
  if (!auth.orgId) {
    throw new AppError(ErrorCode.TENANT_CONTEXT_MISSING, 'An organization context is required');
  }
  return { userId: auth.userId, orgId: auth.orgId, meta: requestMeta(req) };
}

/** Managed from the dashboard, with a session. An API key cannot create more keys or endpoints. */
@Controller('api-keys')
export class ApiKeysController {
  constructor(private readonly developer: DeveloperService) {}

  @Get()
  @RequirePermission(Permission.API_KEYS_MANAGE)
  list(): Promise<ApiKeyDto[]> {
    return this.developer.listKeys();
  }

  @Post()
  @RequireFeature('public_api')
  @RequirePermission(Permission.API_KEYS_MANAGE)
  create(
    @CurrentAuth() auth: AuthContext,
    @Req() req: FastifyRequest,
    @Body(zod(createApiKeySchema)) body: CreateApiKeyParsed,
  ): Promise<CreatedApiKeyDto> {
    return this.developer.createKey(actor(auth, req), body);
  }

  @Delete(':id')
  @RequirePermission(Permission.API_KEYS_MANAGE)
  revoke(
    @CurrentAuth() auth: AuthContext,
    @Req() req: FastifyRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ApiKeyDto> {
    return this.developer.revokeKey(actor(auth, req), id);
  }
}

@Controller('webhook-endpoints')
export class WebhookEndpointsController {
  constructor(private readonly developer: DeveloperService) {}

  @Get()
  @RequirePermission(Permission.API_KEYS_MANAGE)
  list(): Promise<WebhookEndpointDto[]> {
    return this.developer.listEndpoints();
  }

  @Post()
  @RequireFeature('public_api')
  @RequirePermission(Permission.API_KEYS_MANAGE)
  create(
    @CurrentAuth() auth: AuthContext,
    @Req() req: FastifyRequest,
    @Body(zod(createWebhookEndpointSchema)) body: CreateWebhookEndpointParsed,
  ): Promise<CreatedWebhookEndpointDto> {
    return this.developer.createEndpoint(actor(auth, req), body);
  }

  @Patch(':id')
  @RequirePermission(Permission.API_KEYS_MANAGE)
  update(
    @CurrentAuth() auth: AuthContext,
    @Req() req: FastifyRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zod(updateWebhookEndpointSchema)) body: UpdateWebhookEndpointInput,
  ): Promise<WebhookEndpointDto> {
    return this.developer.updateEndpoint(actor(auth, req), id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission(Permission.API_KEYS_MANAGE)
  async remove(
    @CurrentAuth() auth: AuthContext,
    @Req() req: FastifyRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.developer.deleteEndpoint(actor(auth, req), id);
  }

  @Post(':id/rotate-secret')
  @HttpCode(200)
  @RequirePermission(Permission.API_KEYS_MANAGE)
  rotate(
    @CurrentAuth() auth: AuthContext,
    @Req() req: FastifyRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CreatedWebhookEndpointDto> {
    return this.developer.rotateSecret(actor(auth, req), id);
  }

  @Post(':id/test')
  @HttpCode(204)
  @RequirePermission(Permission.API_KEYS_MANAGE)
  async test(
    @CurrentAuth() auth: AuthContext,
    @Req() req: FastifyRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.developer.sendTest(actor(auth, req), id);
  }

  @Get(':id/deliveries')
  @RequirePermission(Permission.API_KEYS_MANAGE)
  deliveries(
    @Param('id', ParseUUIDPipe) id: string,
    @Query(zod(listWebhookDeliveriesSchema)) q: ListWebhookDeliveriesQuery,
  ): Promise<CursorPage<WebhookDeliveryDto>> {
    return this.developer.listDeliveries(id, q);
  }

  @Post(':id/deliveries/:deliveryId/replay')
  @HttpCode(200)
  @RequirePermission(Permission.API_KEYS_MANAGE)
  replay(
    @CurrentAuth() auth: AuthContext,
    @Req() req: FastifyRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('deliveryId', ParseUUIDPipe) deliveryId: string,
  ): Promise<WebhookDeliveryDto> {
    return this.developer.replay(actor(auth, req), id, deliveryId);
  }
}
