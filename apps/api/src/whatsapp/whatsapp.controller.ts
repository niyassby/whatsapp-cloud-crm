import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  AppError,
  type CursorPage,
  type CursorQuery,
  cursorQuerySchema,
  type EmbeddedSignupInput,
  embeddedSignupSchema,
  ErrorCode,
  type ManualConnectInput,
  manualConnectSchema,
  Permission,
  type PhoneNumberDto,
  type RegisterPhoneInput,
  registerPhoneSchema,
  type WebhookEventDto,
  type WhatsAppConfigDto,
} from '@wacrm/shared';
import { CurrentAuth, RequirePermission } from '../auth/decorators';
import { Meta, type RequestMeta } from '../common/request-meta';
import { zod } from '../common/zod.pipe';
import type { AuthContext } from '../tenancy/request-context';
import { type Actor, WhatsAppService } from './whatsapp.service';

function actor(auth: AuthContext): Actor {
  if (!auth.orgId) {
    throw new AppError(ErrorCode.TENANT_CONTEXT_MISSING, 'An organization context is required');
  }
  return { userId: auth.userId, orgId: auth.orgId };
}

@Controller('whatsapp')
export class WhatsAppController {
  constructor(private readonly whatsapp: WhatsAppService) {}

  @Get('config')
  @RequirePermission(Permission.WHATSAPP_MANAGE)
  config(): WhatsAppConfigDto {
    return this.whatsapp.getConfig();
  }

  @Post('embedded-signup')
  @RequirePermission(Permission.WHATSAPP_MANAGE)
  embeddedSignup(
    @CurrentAuth() auth: AuthContext,
    @Body(zod(embeddedSignupSchema)) body: EmbeddedSignupInput,
    @Meta() meta: RequestMeta,
  ): Promise<PhoneNumberDto> {
    return this.whatsapp.connectEmbedded(actor(auth), body, meta);
  }

  @Post('manual-connect')
  @RequirePermission(Permission.WHATSAPP_MANAGE)
  manualConnect(
    @CurrentAuth() auth: AuthContext,
    @Body(zod(manualConnectSchema)) body: ManualConnectInput,
    @Meta() meta: RequestMeta,
  ): Promise<PhoneNumberDto> {
    return this.whatsapp.connectManual(actor(auth), body, meta);
  }

  @Get('phone-numbers')
  @RequirePermission(Permission.ORG_READ)
  list(): Promise<PhoneNumberDto[]> {
    return this.whatsapp.list();
  }

  @Post('phone-numbers/:id/sync')
  @HttpCode(200)
  @RequirePermission(Permission.WHATSAPP_MANAGE)
  sync(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PhoneNumberDto> {
    return this.whatsapp.sync(actor(auth), id);
  }

  @Post('phone-numbers/:id/register')
  @HttpCode(200)
  @RequirePermission(Permission.WHATSAPP_MANAGE)
  register(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zod(registerPhoneSchema)) body: RegisterPhoneInput,
    @Meta() meta: RequestMeta,
  ): Promise<PhoneNumberDto> {
    return this.whatsapp.registerNumber(actor(auth), id, body.pin, meta);
  }

  @Delete('phone-numbers/:id')
  @HttpCode(204)
  @RequirePermission(Permission.WHATSAPP_MANAGE)
  async disconnect(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Meta() meta: RequestMeta,
  ): Promise<void> {
    await this.whatsapp.disconnect(actor(auth), id, meta);
  }

  @Get('webhook-events')
  @RequirePermission(Permission.WHATSAPP_MANAGE)
  events(@Query(zod(cursorQuerySchema)) query: CursorQuery): Promise<CursorPage<WebhookEventDto>> {
    return this.whatsapp.listEvents(query);
  }

  @Post('webhook-events/:id/replay')
  @HttpCode(202)
  @RequirePermission(Permission.WHATSAPP_MANAGE)
  async replay(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Meta() meta: RequestMeta,
  ): Promise<void> {
    await this.whatsapp.replayEvent(actor(auth), id, meta);
  }
}
