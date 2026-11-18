import {
  Body,
  Controller,
  Delete,
  Get,
  Module,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import {
  AppError,
  ERASED_CONFIRM_WORD,
  type EraseContactInput,
  eraseContactSchema,
  ErrorCode,
  type OrgDeletionInput,
  orgDeletionSchema,
  Permission,
  type PrivacyRequestDto,
  type PrivacySettingsDto,
  type RetentionInput,
  retentionSchema,
} from '@wacrm/shared';
import { CurrentAuth, RequirePermission } from '../auth/decorators';
import { Meta, type RequestMeta } from '../common/request-meta';
import { zod } from '../common/zod.pipe';
import type { AuthContext } from '../tenancy/request-context';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service';
import { type PrivacyActor, PrivacyService } from './privacy.service';

function actor(auth: AuthContext, meta?: RequestMeta): PrivacyActor {
  if (!auth.orgId) {
    throw new AppError(ErrorCode.TENANT_CONTEXT_MISSING, 'An organization context is required');
  }
  return { orgId: auth.orgId, userId: auth.userId, meta };
}

/**
 * Phase 4.4: a contact's data export and erasure (GDPR and DPDP requests), for people who manage
 * contacts; a whole-workspace export, retention and deletion, for owners only.
 */
@Controller('privacy')
export class PrivacyController {
  constructor(
    private readonly privacy: PrivacyService,
    private readonly db: TenantPrismaService,
  ) {}

  @Get('contacts/:id/requests')
  @RequirePermission(Permission.CONTACTS_MANAGE)
  contactRequests(@Param('id', ParseUUIDPipe) id: string): Promise<PrivacyRequestDto[]> {
    return this.privacy.list('contact', id);
  }

  @Post('contacts/:id/export')
  @RequirePermission(Permission.CONTACTS_MANAGE)
  exportContact(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Meta() meta: RequestMeta,
  ): Promise<PrivacyRequestDto> {
    return this.privacy.request(actor(auth, meta), 'contact_export', id);
  }

  /** Cannot be undone: the person's current name, or ERASE, must be typed. */
  @Post('contacts/:id/erase')
  @RequirePermission(Permission.CONTACTS_MANAGE)
  async eraseContact(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zod(eraseContactSchema)) body: EraseContactInput,
    @Meta() meta: RequestMeta,
  ): Promise<PrivacyRequestDto> {
    const contact = await this.db.run((tx) =>
      tx.contact.findUnique({ where: { id }, select: { name: true } }),
    );
    if (!contact) throw new AppError(ErrorCode.NOT_FOUND, 'Contact not found');
    const ok =
      body.confirm === ERASED_CONFIRM_WORD ||
      (contact.name !== null && body.confirm.trim() === contact.name.trim());
    if (!ok) {
      throw new AppError(
        ErrorCode.VALIDATION_FAILED,
        `Type the contact's name, or ${ERASED_CONFIRM_WORD}, to confirm`,
      );
    }
    return this.privacy.request(actor(auth, meta), 'contact_erase', id);
  }

  @Get('contacts/requests/:requestId/download')
  @RequirePermission(Permission.CONTACTS_MANAGE)
  downloadContact(
    @CurrentAuth() auth: AuthContext,
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Meta() meta: RequestMeta,
  ): Promise<{ url: string }> {
    return this.privacy.download(actor(auth, meta), requestId, 'contact');
  }

  // ---------------------------------------------------------------- the whole workspace

  @Get('workspace')
  @RequirePermission(Permission.ORG_DELETE)
  settings(@CurrentAuth() auth: AuthContext): Promise<PrivacySettingsDto> {
    return this.privacy.settings(actor(auth).orgId);
  }

  @Patch('workspace/retention')
  @RequirePermission(Permission.ORG_DELETE)
  setRetention(
    @CurrentAuth() auth: AuthContext,
    @Body(zod(retentionSchema)) body: RetentionInput,
    @Meta() meta: RequestMeta,
  ): Promise<PrivacySettingsDto> {
    return this.privacy.setRetention(actor(auth, meta), body.messageRetentionDays);
  }

  @Get('workspace/exports')
  @RequirePermission(Permission.ORG_DELETE)
  exports(): Promise<PrivacyRequestDto[]> {
    return this.privacy.list('org');
  }

  @Post('workspace/exports')
  @RequirePermission(Permission.ORG_DELETE)
  exportWorkspace(
    @CurrentAuth() auth: AuthContext,
    @Meta() meta: RequestMeta,
  ): Promise<PrivacyRequestDto> {
    return this.privacy.request(actor(auth, meta), 'org_export');
  }

  @Get('workspace/exports/:requestId/download')
  @RequirePermission(Permission.ORG_DELETE)
  downloadWorkspace(
    @CurrentAuth() auth: AuthContext,
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Meta() meta: RequestMeta,
  ): Promise<{ url: string }> {
    return this.privacy.download(actor(auth, meta), requestId, 'org');
  }

  @Post('workspace/deletion')
  @RequirePermission(Permission.ORG_DELETE)
  requestDeletion(
    @CurrentAuth() auth: AuthContext,
    @Body(zod(orgDeletionSchema)) body: OrgDeletionInput,
    @Meta() meta: RequestMeta,
  ): Promise<PrivacySettingsDto> {
    return this.privacy.requestDeletion(actor(auth, meta), body.confirmName);
  }

  @Delete('workspace/deletion')
  @RequirePermission(Permission.ORG_DELETE)
  cancelDeletion(
    @CurrentAuth() auth: AuthContext,
    @Meta() meta: RequestMeta,
  ): Promise<PrivacySettingsDto> {
    return this.privacy.cancelDeletion(actor(auth, meta));
  }
}

@Module({ controllers: [PrivacyController], providers: [PrivacyService] })
export class PrivacyModule {}
