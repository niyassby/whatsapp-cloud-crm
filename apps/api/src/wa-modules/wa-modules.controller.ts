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
  Put,
  Query,
} from '@nestjs/common';
import {
  type AdsReportDto,
  adsReportSchema,
  AppError,
  type CallDto,
  type CallingSettingsDto,
  type CallingSettingsInput,
  callingSettingsSchema,
  type CallPermissionDto,
  type CatalogDto,
  type CreateGroupInput,
  createGroupSchema,
  type CreateQrCodeInput,
  createQrCodeSchema,
  ErrorCode,
  type GroupDto,
  type GroupJoinRequestDto,
  groupJoinRequestsSchema,
  groupMessageSchema,
  type MessageDto,
  Permission,
  type QrCodeDto,
  removeParticipantsSchema,
  sdpSchema,
  type SendProductsInput,
  sendProductsSchema,
  updateQrCodeSchema,
} from '@wacrm/shared';
import { z } from 'zod';
import { CurrentAuth, RequireFeature, RequirePermission } from '../auth/decorators';
import { Meta, type RequestMeta } from '../common/request-meta';
import { zod } from '../common/zod.pipe';
import type { AuthContext } from '../tenancy/request-context';
import { type ModuleActor, WaModulesService } from './wa-modules.service';

const actor = (auth: AuthContext, meta: RequestMeta): ModuleActor => {
  if (!auth.orgId || !auth.role) {
    throw new AppError(ErrorCode.TENANT_CONTEXT_MISSING, 'An organization is required');
  }
  return { userId: auth.userId, orgId: auth.orgId, role: auth.role, meta };
};

const phoneQuery = z.object({ phoneId: z.uuid() });
const clientIdSchema = z.object({ clientMessageId: z.uuid() });

/** Reading stays open on every plan; actions need the feature, as elsewhere. */
@Controller('qr-codes')
export class QrCodesController {
  constructor(private readonly modules: WaModulesService) {}

  @Get()
  @RequirePermission(Permission.CHANNELS_MANAGE)
  list(): Promise<QrCodeDto[]> {
    return this.modules.listQrCodes();
  }

  @Post()
  @RequireFeature('qr_codes')
  @RequirePermission(Permission.CHANNELS_MANAGE)
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(zod(createQrCodeSchema)) body: CreateQrCodeInput,
    @Meta() meta: RequestMeta,
  ): Promise<QrCodeDto[]> {
    return this.modules.createQrCode(actor(auth, meta), body);
  }

  @Patch(':id')
  @RequireFeature('qr_codes')
  @RequirePermission(Permission.CHANNELS_MANAGE)
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zod(updateQrCodeSchema)) body: { name?: string; prefilledMessage?: string },
    @Meta() meta: RequestMeta,
  ): Promise<QrCodeDto[]> {
    return this.modules.updateQrCode(actor(auth, meta), id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission(Permission.CHANNELS_MANAGE)
  async remove(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Meta() meta: RequestMeta,
  ): Promise<void> {
    await this.modules.deleteQrCode(actor(auth, meta), id);
  }
}

@Controller('catalog')
export class CatalogController {
  constructor(private readonly modules: WaModulesService) {}

  @Get()
  @RequirePermission(Permission.INBOX_READ)
  catalog(@Query(zod(phoneQuery)) query: { phoneId: string }): Promise<CatalogDto> {
    return this.modules.catalog(query.phoneId);
  }

  @Post('sync')
  @HttpCode(200)
  @RequireFeature('catalog')
  @RequirePermission(Permission.CHANNELS_MANAGE)
  sync(
    @CurrentAuth() auth: AuthContext,
    @Body(zod(phoneQuery)) body: { phoneId: string },
    @Meta() meta: RequestMeta,
  ): Promise<CatalogDto> {
    return this.modules.syncCatalog(actor(auth, meta), body.phoneId);
  }
}

@Controller('groups')
export class GroupsController {
  constructor(private readonly modules: WaModulesService) {}

  @Get()
  @RequirePermission(Permission.CHANNELS_MANAGE)
  list(): Promise<GroupDto[]> {
    return this.modules.listGroups();
  }

  @Post()
  @RequireFeature('groups')
  @RequirePermission(Permission.CHANNELS_MANAGE)
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(zod(createGroupSchema)) body: CreateGroupInput,
    @Meta() meta: RequestMeta,
  ): Promise<GroupDto> {
    return this.modules.createGroup(actor(auth, meta), body);
  }

  @Post(':id/refresh')
  @HttpCode(200)
  @RequireFeature('groups')
  @RequirePermission(Permission.CHANNELS_MANAGE)
  refresh(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Meta() meta: RequestMeta,
  ): Promise<GroupDto> {
    return this.modules.refreshGroup(actor(auth, meta), id);
  }

  @Get(':id/join-requests')
  @RequireFeature('groups')
  @RequirePermission(Permission.CHANNELS_MANAGE)
  joinRequests(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Meta() meta: RequestMeta,
  ): Promise<GroupJoinRequestDto[]> {
    return this.modules.joinRequests(actor(auth, meta), id);
  }

  @Post(':id/join-requests')
  @HttpCode(200)
  @RequireFeature('groups')
  @RequirePermission(Permission.CHANNELS_MANAGE)
  answer(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zod(groupJoinRequestsSchema)) body: { approve: string[]; reject: string[] },
    @Meta() meta: RequestMeta,
  ): Promise<GroupJoinRequestDto[]> {
    return this.modules.answerJoinRequests(actor(auth, meta), id, body);
  }

  @Post(':id/remove-participants')
  @HttpCode(204)
  @RequireFeature('groups')
  @RequirePermission(Permission.CHANNELS_MANAGE)
  async removeParticipants(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zod(removeParticipantsSchema)) body: { users: string[] },
    @Meta() meta: RequestMeta,
  ): Promise<void> {
    await this.modules.removeParticipants(actor(auth, meta), id, body.users);
  }

  @Post(':id/messages')
  @RequireFeature('groups')
  @RequirePermission(Permission.CHANNELS_MANAGE)
  message(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zod(groupMessageSchema)) body: { body: string },
    @Meta() meta: RequestMeta,
  ): Promise<{ messageId: string }> {
    return this.modules.sendGroupMessage(actor(auth, meta), id, body.body);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission(Permission.CHANNELS_MANAGE)
  async remove(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Meta() meta: RequestMeta,
  ): Promise<void> {
    await this.modules.deleteGroup(actor(auth, meta), id);
  }
}

@Controller()
export class CallsController {
  constructor(private readonly modules: WaModulesService) {}

  @Get('calling/settings')
  @RequirePermission(Permission.WHATSAPP_MANAGE)
  settings(
    @CurrentAuth() auth: AuthContext,
    @Query(zod(phoneQuery)) query: { phoneId: string },
    @Meta() meta: RequestMeta,
  ): Promise<CallingSettingsDto> {
    return this.modules.callingSettings(actor(auth, meta), query.phoneId);
  }

  @Put('calling/settings')
  @RequireFeature('calling')
  @RequirePermission(Permission.WHATSAPP_MANAGE)
  updateSettings(
    @CurrentAuth() auth: AuthContext,
    @Query(zod(phoneQuery)) query: { phoneId: string },
    @Body(zod(callingSettingsSchema)) body: CallingSettingsInput,
    @Meta() meta: RequestMeta,
  ): Promise<CallingSettingsDto> {
    return this.modules.updateCallingSettings(actor(auth, meta), query.phoneId, body);
  }

  @Get('calls')
  @RequirePermission(Permission.INBOX_READ)
  recent(): Promise<CallDto[]> {
    return this.modules.recentCalls();
  }

  @Get('inbox/conversations/:id/call-permission')
  @RequireFeature('calling')
  @RequirePermission(Permission.CALLS_HANDLE)
  permission(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Meta() meta: RequestMeta,
  ): Promise<CallPermissionDto> {
    return this.modules.callPermission(actor(auth, meta), id);
  }

  @Post('inbox/conversations/:id/call-permission')
  @RequireFeature('calling')
  @RequirePermission(Permission.CALLS_HANDLE)
  requestPermission(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zod(clientIdSchema)) body: { clientMessageId: string },
    @Meta() meta: RequestMeta,
  ): Promise<MessageDto> {
    return this.modules.requestCallPermission(actor(auth, meta), id, body.clientMessageId);
  }

  @Post('inbox/conversations/:id/calls')
  @RequireFeature('calling')
  @RequirePermission(Permission.CALLS_HANDLE)
  start(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zod(sdpSchema)) body: { sdp: string },
    @Meta() meta: RequestMeta,
  ): Promise<CallDto> {
    return this.modules.startCall(actor(auth, meta), id, body.sdp);
  }

  @Post('calls/:id/accept')
  @HttpCode(200)
  @RequireFeature('calling')
  @RequirePermission(Permission.CALLS_HANDLE)
  accept(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zod(sdpSchema)) body: { sdp: string },
    @Meta() meta: RequestMeta,
  ): Promise<CallDto> {
    return this.modules.acceptCall(actor(auth, meta), id, body.sdp);
  }

  @Post('calls/:id/reject')
  @HttpCode(200)
  @RequirePermission(Permission.CALLS_HANDLE)
  reject(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Meta() meta: RequestMeta,
  ): Promise<CallDto> {
    return this.modules.rejectCall(actor(auth, meta), id);
  }

  @Post('calls/:id/terminate')
  @HttpCode(204)
  @RequirePermission(Permission.CALLS_HANDLE)
  async terminate(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Meta() meta: RequestMeta,
  ): Promise<void> {
    await this.modules.terminateCall(actor(auth, meta), id);
  }
}

@Controller()
export class ProductsAndAdsController {
  constructor(private readonly modules: WaModulesService) {}

  @Post('inbox/conversations/:id/products')
  @RequireFeature('catalog')
  @RequirePermission(Permission.INBOX_REPLY)
  sendProducts(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zod(sendProductsSchema)) body: SendProductsInput,
    @Meta() meta: RequestMeta,
  ): Promise<MessageDto> {
    return this.modules.sendProducts(actor(auth, meta), id, body);
  }

  @Get('analytics/ads')
  @RequireFeature('ad_attribution')
  @RequirePermission(Permission.ANALYTICS_READ)
  ads(
    @CurrentAuth() auth: AuthContext,
    @Query(zod(adsReportSchema)) query: { days: number },
    @Meta() meta: RequestMeta,
  ): Promise<AdsReportDto> {
    return this.modules.adsReport(actor(auth, meta).orgId, query.days);
  }
}
